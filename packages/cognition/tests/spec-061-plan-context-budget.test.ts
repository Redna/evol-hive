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
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
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
import { estimatePlanPrompt, logPlanContext } from '../src/pper/plan-shape-diagnostic.js';
import { PlanBuilderImpl } from '../src/pper/plan-builder.js';
import { writeLargestPlanPayload } from '../src/llm/plan-payload-dump.js';
import { OpenAICompatibleLLMClient } from '../src/llm/openai-client.js';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as pathJoin } from 'node:path';

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

// ── R4 / AC-1: [plan-context] grower diagnostic + largest-payload dump ──────

function toolCallResponse(args: unknown): Response {
  return new Response(
    JSON.stringify({
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call-1',
                type: 'function',
                function: { name: 'formulate_plan', arguments: JSON.stringify(args) },
              },
            ],
          },
        },
      ],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

describe('spec 061 R4 — [plan-context] grower diagnostic + largest-payload dump', () => {
  const builder = new PlanBuilderImpl();

  it('attaches planContextDiagnostic with orig/budget/kept and top on every build', () => {
    vi.stubEnv('PLAN_PROMPT_MAX_CHARS', '100000');
    const roomy = builder.build(makeOversizedPerception());
    const d = roomy.planContextDiagnostic;
    expect(d).toBeDefined();
    expect(d!.originalChars).toBe(roomy.perceptionContext.length);
    expect(d!.keptChars).toBe(roomy.perceptionContext.length);
    expect(d!.droppedBlockIds).toEqual([]);
    expect(d!.truncatedBlockId).toBeUndefined();
    expect(d!.budgetChars).toBeGreaterThan(0);
    expect(d!.topBlockId).toMatch(/^[a-z-]+$/);
    expect(d!.topBlockChars).toBeGreaterThan(0);
  });

  it('reports dropped blocks (lowest tier first) and top names the surviving grower', () => {
    vi.stubEnv('PLAN_PROMPT_MAX_CHARS', '100000');
    const roomy = builder.build(makeOversizedPerception());
    const prefixChars = roomy.systemPrompt.length + JSON.stringify(roomy.tools).length;
    vi.stubEnv('PLAN_PROMPT_MAX_CHARS', String(prefixChars + 200));
    const tight = builder.build(makeOversizedPerception());
    const d = tight.planContextDiagnostic!;
    expect(d.keptChars).toBe(tight.perceptionContext.length);
    expect(d.keptChars).toBeLessThan(d.originalChars);
    expect(d.droppedBlockIds.length).toBeGreaterThan(0);
    // required Tier 0 blocks survive and can never be in the drop set
    expect(d.droppedBlockIds).not.toContain('room');
    expect(d.droppedBlockIds).not.toContain('objects');
    // the named top block survived
    expect(d.droppedBlockIds).not.toContain(d.topBlockId);
  });

  it('renders the [plan-context] line exactly (dropped=none and trunc suffix)', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    logPlanContext('a1', {
      originalChars: 10,
      budgetChars: 5,
      keptChars: 5,
      droppedBlockIds: [],
      topBlockId: 'room',
      topBlockChars: 4,
    });
    logPlanContext(undefined, {
      originalChars: 10,
      budgetChars: 5,
      keptChars: 3,
      droppedBlockIds: ['x'],
      truncatedBlockId: 'drives',
      topBlockId: 'room',
      topBlockChars: 4,
    });
    const calls = err.mock.calls.map((c) => String(c[0]));
    expect(calls[0]).toBe(
      '[plan-context] agent=a1 orig=10 budget=5 kept=5 dropped=none top=room:4',
    );
    expect(calls[1]).toBe(
      '[plan-context] agent=? orig=10 budget=5 kept=3 dropped=x top=room:4 trunc=drives',
    );
    err.mockRestore();
  });

  it('writeLargestPlanPayload writes only the largest payload per agent', () => {
    const dir = mkdtempSync(pathJoin(tmpdir(), 'spec-061-dump-'));
    try {
      const small = {
        messages: [],
        tools: [],
        systemPrompt: 's',
        perceptionContext: 'a',
        agentId: 'a1',
      };
      const big = {
        messages: [],
        tools: [],
        systemPrompt: 's',
        perceptionContext: 'a'.repeat(500),
        agentId: 'a1',
      };
      writeLargestPlanPayload(dir, small);
      const first = readFileSync(pathJoin(dir, 'plan-payload-a1.json'), 'utf8');
      writeLargestPlanPayload(dir, big);
      const second = readFileSync(pathJoin(dir, 'plan-payload-a1.json'), 'utf8');
      expect(second.length).toBeGreaterThan(first.length);
      expect(JSON.parse(second).perceptionContext.length).toBe(500);
      // a smaller payload must not shrink it back
      writeLargestPlanPayload(dir, small);
      expect(readFileSync(pathJoin(dir, 'plan-payload-a1.json'), 'utf8')).toBe(second);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('emits [plan-context] once per completePlan call (client seam)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        toolCallResponse({
          description: 'Restore energy',
          steps: [{ description: 'Brew coffee', targetAffordance: 'brew_coffee' }],
        }),
      ),
    );
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const client = new OpenAICompatibleLLMClient({ baseUrl: 'http://localhost:1', model: 'test' });
    await client.completePlan({
      systemPrompt: 'You are an agent.',
      perceptionContext: 'Room: garden',
      availableAffordances: [],
      cognitiveTools: [],
      tools: [],
      agentId: 'a1',
      planContextDiagnostic: {
        originalChars: 100,
        budgetChars: 50,
        keptChars: 40,
        droppedBlockIds: ['social-messages'],
        topBlockId: 'drives',
        topBlockChars: 22,
      },
    });
    const calls = err.mock.calls.map((c) => String(c[0]));
    const ctx = calls.filter((l) => l.includes('[plan-context]'));
    expect(ctx).toHaveLength(1);
    expect(ctx[0]).toBe(
      '[plan-context] agent=a1 orig=100 budget=50 kept=40 dropped=social-messages top=drives:22',
    );
    err.mockRestore();
    vi.unstubAllGlobals();
  });
});
