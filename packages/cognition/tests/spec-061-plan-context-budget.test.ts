/**
 * Spec 061 — Plan-Context Budgeting (issue #219, AC-1 / AC-3 / AC-4)
 * ────────────────────────────────────────────────────────────────────────────
 * R1/R3 unit coverage for the pure budgeter:
 * - under-budget byte-identity with the pre-change join,
 * - oversized payload dropping Tier 5 first (drop order in `droppedBlockIds`),
 * - required-only overflow truncating the last required block, never throwing,
 * - env parsing for `PLAN_PROMPT_MAX_CHARS` / recall caps incl. invalid values,
 * - the reserved `recall` tier (3.5) and its order/char caps (no ranking).
 *
 * R2 integration coverage: the builder bounds the perception context to the
 * ceiling headroom while `systemPrompt` and `tools` stay byte-identical (the
 * enum is plan legality — spec 037/058).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import type { Affordance, PerceptionResult } from '@evol-hive/shared';
import {
  budgetPlanContext,
  capRecallBlocks,
  capRecallText,
  planPromptMaxChars,
  planRecallMaxChars,
  planRecallMaxLines,
  DEFAULT_PLAN_PROMPT_MAX_CHARS,
  DEFAULT_PLAN_RECALL_MAX_CHARS,
  DEFAULT_PLAN_RECALL_MAX_LINES,
} from '../src/pper/plan-context-budget.js';
import type { PlanContextBlock } from '../src/pper/plan-context-budget.js';
import { estimatePlanPrompt } from '../src/pper/plan-shape-diagnostic.js';
import { PlanBuilderImpl } from '../src/pper/plan-builder.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

const join = (blocks: readonly PlanContextBlock[]): string => blocks.map((b) => b.text).join('\n');

// ── R1 / AC-3: byte-identity, tier order, truncation ─────────────────────────

describe('spec 061 R1 — under-budget byte-identity', () => {
  it("returns exactly blocks.map((b) => b.text).join('\\n') with no reordering", () => {
    const blocks: PlanContextBlock[] = [
      { id: 'room', text: 'Room: garden', required: true },
      { id: 'objects', text: 'Objects: Planter', required: true },
      { id: 'agents-present', text: 'Agents present: Ada (a1) (idle)' },
      { id: 'separator', text: '---', required: true },
      { id: 'primary-drive', text: 'Primary drive: low curiosity', required: true },
      { id: 'drives', text: 'Drives: energy=45, curiosity=60', required: true },
      { id: 'horizon', text: 'Horizon: framing' },
    ];
    const result = budgetPlanContext(blocks, DEFAULT_PLAN_PROMPT_MAX_CHARS);

    expect(result.perceptionContext).toBe(join(blocks));
    expect(result.budgeted).toBe(false);
    expect(result.droppedBlockIds).toEqual([]);
    expect(result.truncatedBlockId).toBeUndefined();
    expect(result.originalChars).toBe(join(blocks).length);
    expect(result.chars).toBe(join(blocks).length);
  });
});

describe('spec 061 R1/R2 — over-budget drops lowest tier first', () => {
  const required: PlanContextBlock[] = [
    { id: 'room', text: 'Room: garden', required: true },
    { id: 'objects', text: 'Objects: Planter', required: true },
    { id: 'separator', text: '---', required: true },
    { id: 'primary-drive', text: 'Primary drive: low curiosity', required: true },
    { id: 'drives', text: 'Drives: energy=45', required: true },
  ];

  it('drops Tier 5 (horizon) before any lower-priority block', () => {
    const blocks: PlanContextBlock[] = [
      ...required,
      { id: 'horizon', text: 'H'.repeat(200) },
      { id: 'relationships', text: 'R'.repeat(200) },
      { id: 'last-plan', text: 'L'.repeat(200) },
    ];
    const withoutHorizon = join(blocks.filter((b) => b.id !== 'horizon'));

    const result = budgetPlanContext(blocks, withoutHorizon.length);

    expect(result.droppedBlockIds).toEqual(['horizon']);
    expect(result.perceptionContext).toBe(withoutHorizon);
    expect(result.perceptionContext).toContain('\n---\n');
  });

  it('reports drop order Tier 5 → Tier 4 → Tier 3', () => {
    const blocks: PlanContextBlock[] = [
      ...required,
      { id: 'horizon', text: 'H'.repeat(200) },
      { id: 'relationships', text: 'R'.repeat(200) },
      { id: 'last-plan', text: 'L'.repeat(200) },
    ];

    const result = budgetPlanContext(blocks, join(required).length);

    expect(result.droppedBlockIds).toEqual(['horizon', 'relationships', 'last-plan']);
    expect(result.perceptionContext).toBe(join(required));
    expect(result.truncatedBlockId).toBeUndefined();
    expect(result.budgeted).toBe(true);
  });

  it('never drops a required block', () => {
    const blocks: PlanContextBlock[] = [...required, { id: 'horizon', text: 'H'.repeat(500) }];
    const result = budgetPlanContext(blocks, join(required).length + 10);

    // Required content survives in order.
    expect(result.perceptionContext.startsWith(join(required))).toBe(true);
    expect(result.droppedBlockIds).toEqual(['horizon']);
  });
});

describe('spec 061 R1 — required-only overflow truncates and never throws', () => {
  const requiredOnly: PlanContextBlock[] = [
    { id: 'room', text: 'Room: garden', required: true },
    { id: 'drives', text: 'D'.repeat(100), required: true },
  ];

  it('truncates the last required block with the marker at the char boundary', () => {
    const maxChars = 40;
    const result = budgetPlanContext(requiredOnly, maxChars);

    expect(result.chars).toBeLessThanOrEqual(maxChars);
    expect(result.perceptionContext.startsWith('Room: garden\n')).toBe(true);
    expect(result.perceptionContext.endsWith('…[truncated]')).toBe(true);
    expect(result.truncatedBlockId).toBe('drives');
    expect(result.droppedBlockIds).toEqual([]);
    expect(result.budgeted).toBe(true);
  });

  it('returns an empty string for a zero/negative budget without throwing', () => {
    expect(() => budgetPlanContext(requiredOnly, -5)).not.toThrow();
    expect(() => budgetPlanContext(requiredOnly, 0)).not.toThrow();

    const negative = budgetPlanContext(requiredOnly, -5);
    expect(negative.chars).toBe(0);
    expect(negative.perceptionContext).toBe('');
    expect(negative.truncatedBlockId).toBe('drives');

    const zero = budgetPlanContext(requiredOnly, 0);
    expect(zero.chars).toBe(0);
    expect(zero.perceptionContext).toBe('');
  });

  it('drops optional blocks before truncating a required one', () => {
    const blocks: PlanContextBlock[] = [
      { id: 'room', text: 'Room: garden', required: true },
      { id: 'drives', text: 'D'.repeat(100), required: true },
      { id: 'horizon', text: 'H'.repeat(300) },
    ];
    const result = budgetPlanContext(blocks, 40);

    expect(result.droppedBlockIds).toEqual(['horizon']);
    expect(result.truncatedBlockId).toBe('drives');
  });
});

// ── R1: env parsing ──────────────────────────────────────────────────────────

describe('spec 061 R1 — planPromptMaxChars env parsing', () => {
  it('reads a positive override', () => {
    vi.stubEnv('PLAN_PROMPT_MAX_CHARS', '2500');
    expect(planPromptMaxChars()).toBe(2500);
  });

  it('falls back to the default when absent, empty, non-finite, or non-positive', () => {
    delete process.env['PLAN_PROMPT_MAX_CHARS'];
    expect(planPromptMaxChars()).toBe(DEFAULT_PLAN_PROMPT_MAX_CHARS);

    for (const raw of ['', 'abc', '0', '-1', 'Infinity', 'NaN']) {
      vi.stubEnv('PLAN_PROMPT_MAX_CHARS', raw);
      expect(planPromptMaxChars()).toBe(DEFAULT_PLAN_PROMPT_MAX_CHARS);
    }
  });
});

// ── R3 / AC-4: reserved recall tier + caps ───────────────────────────────────

describe('spec 061 R3 — reserved recall tier', () => {
  it('drops recall after Tier 4 and before Tier 3 (Tier 3.5)', () => {
    const blocks: PlanContextBlock[] = [
      { id: 'room', text: 'Room: garden', required: true },
      { id: 'primary-drive', text: 'Primary drive: x', required: true },
      { id: 'drives', text: 'Drives: energy=45', required: true },
      { id: 'relationships', text: 'R'.repeat(200) },
      { id: 'recall', text: 'M'.repeat(200) },
      { id: 'last-plan', text: 'L'.repeat(200) },
    ];
    const target = join([...blocks.filter((b) => b.id !== 'relationships' && b.id !== 'recall')]);

    const result = budgetPlanContext(blocks, target.length);

    expect(result.droppedBlockIds).toEqual(['relationships', 'recall']);
    expect(result.perceptionContext).toBe(target);
  });

  it('caps recall lines and chars preserving the ranked order (no re-ranking)', () => {
    const blocks: PlanContextBlock[] = [
      { id: 'recall', text: 'm1\nm2\nm3\nm4\nm5' },
      { id: 'room', text: 'Room: garden', required: true },
    ];
    const capped = capRecallBlocks(blocks, 3, 400);

    expect(capped[0]!.text).toBe('m1\nm2\nm3');
    expect(capped[1]).toBe(blocks[1]);
  });

  it('enforces the char cap and the line cap', () => {
    expect(capRecallText('a'.repeat(500), 3, 400)).toBe('a'.repeat(400));
    expect(capRecallText('m1\nm2\nm3\nm4', 2, 400)).toBe('m1\nm2');
    expect(capRecallText('m1\nm2', 3, 400)).toBe('m1\nm2');
  });

  it('reads the recall caps from env with invalid-value fallback', () => {
    vi.stubEnv('PLAN_RECALL_MAX_LINES', '5');
    vi.stubEnv('PLAN_RECALL_MAX_CHARS', '120');
    expect(planRecallMaxLines()).toBe(5);
    expect(planRecallMaxChars()).toBe(120);

    for (const raw of ['', 'abc', '0', '-3']) {
      vi.stubEnv('PLAN_RECALL_MAX_LINES', raw);
      vi.stubEnv('PLAN_RECALL_MAX_CHARS', raw);
      expect(planRecallMaxLines()).toBe(DEFAULT_PLAN_RECALL_MAX_LINES);
      expect(planRecallMaxChars()).toBe(DEFAULT_PLAN_RECALL_MAX_CHARS);
    }
  });
});

// ── R2 / AC-1: builder integration ───────────────────────────────────────────

const prunedAffordances: Affordance[] = [
  {
    id: 'water_plants',
    label: 'Water the plants',
    engineEffect: 'water_plants',
    preconditions: [],
    effects: { curiosity: 10, comfort: 5 },
  },
];

function makeOversizedPerception(): PerceptionResult {
  return {
    passive: {
      roomId: 'garden',
      objectsPresent: [{ objectId: 'planter-1', name: 'Planter', type: 'furniture' }],
      drives: { energy: 45, hunger: 50, social: 50, comfort: 50, curiosity: 60 },
      socialContext: Array.from({ length: 80 }, (_, i) => ({
        fromAgentId: `agent-${i}`,
        fromName: 'Ada',
        content: `message ${i} `.repeat(6),
        timestamp: i,
      })),
    },
    prunedAffordances,
    primaryDriveLabel: 'low curiosity, need to restore curiosity',
    knownAreas: ['garden', 'workshop'],
    unexploredAreas: ['cellar', 'attic'],
  };
}

describe('spec 061 R2 — builder bounds the context without touching legality', () => {
  const builder = new PlanBuilderImpl();

  it('keeps estimatePlanPrompt at or under the ceiling and the separator in-stream', () => {
    vi.stubEnv('PLAN_PROMPT_MAX_CHARS', '100000');
    const roomy = builder.build(makeOversizedPerception());
    const prefixChars = roomy.systemPrompt.length + JSON.stringify(roomy.tools).length;
    expect(prefixChars).toBeLessThan(100000);

    const ceiling = prefixChars + 300;
    vi.stubEnv('PLAN_PROMPT_MAX_CHARS', String(ceiling));
    const tight = builder.build(makeOversizedPerception());

    expect(estimatePlanPrompt(tight).chars).toBeLessThanOrEqual(ceiling);
    expect(estimatePlanPrompt(tight).chars).toBeGreaterThan(prefixChars);
    expect(tight.perceptionContext).toContain('\n---\n');
  });

  it('never budgets, reorders, truncates or regenerates systemPrompt / tools', () => {
    vi.stubEnv('PLAN_PROMPT_MAX_CHARS', '100000');
    const roomy = builder.build(makeOversizedPerception());

    vi.stubEnv('PLAN_PROMPT_MAX_CHARS', '1');
    const tight = builder.build(makeOversizedPerception());

    expect(tight.systemPrompt).toBe(roomy.systemPrompt);
    expect(tight.tools).toEqual(roomy.tools);
    // The formulate_plan enum (plan legality, spec 037/058) is untouched.
    expect(tight.tools.find((t) => t.name === 'formulate_plan')).toEqual(
      roomy.tools.find((t) => t.name === 'formulate_plan'),
    );
    expect(tight.perceptionContext.length).toBeLessThan(roomy.perceptionContext.length);
  });
});
