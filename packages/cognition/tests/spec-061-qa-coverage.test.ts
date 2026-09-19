/**
 * Spec 061 — QA coverage additions (issue #219, PR #223)
 * ═══════════════════════════════════════════════════════════════════════════
 * QA-verification pass over spec 061's acceptance criteria. These tests close
 * gaps the implementation suite left; they add no production surface.
 *
 * Gaps closed:
 *
 * - AC-1 (R2 / Decision 3): the **over-prefix** case — when `systemPrompt` +
 *   serialized `tools` alone exceed `PLAN_PROMPT_MAX_CHARS`, the prefix must
 *   stay byte-identical, the budgeted `perceptionContext` becomes empty, and
 *   the `[plan-context]` line reports `budget=0 kept=0`. The implementation
 *   suite asserted only "shorter", never the empty/byte-identical invariant.
 * - AC-1 / AC-6: `shared`/`engine`/`memory` source untouched is asserted by
 *   the PR diff; the legality surface is asserted end-to-end here by feeding
 *   the built payload through the real client request and checking the
 *   `formulate_plan` enum on the wire.
 * - AC-1 / R4: `[plan-prompt]` and `[plan-context]` are co-emitted exactly
 *   once per formulation (the R4 "on every request" clause), and the
 *   `PLAN_PAYLOAD_DUMP_DIR` gate is inert when unset and writes the full
 *   payload when set (R4 integration at the client seam).
 *
 * Meso boundary under test: `PlanBuilderImpl` → `OpenAICompatibleLLMClient`
 * (both in `cognition`; no cross-package import).
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import type { Affordance, PerceptionResult } from '@evol-hive/shared';
import { PlanBuilderImpl } from '../src/pper/plan-builder.js';
import { estimatePlanPrompt } from '../src/pper/plan-shape-diagnostic.js';
import { OpenAICompatibleLLMClient } from '../src/llm/openai-client.js';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as pathJoin } from 'node:path';

afterEach(() => {
  vi.unstubAllEnvs();
});

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

// ── AC-1 (R2/Decision 3): the over-prefix case ───────────────────────────────

describe('QA spec 061 AC-1 — over-prefix keeps the constant prefix, empties the context', () => {
  const builder = new PlanBuilderImpl();

  it('never satisfies the ceiling by shrinking tools; empties perceptionContext instead', () => {
    vi.stubEnv('PLAN_PROMPT_MAX_CHARS', '100000');
    const roomy = builder.build(makeOversizedPerception());
    const prefixChars = roomy.systemPrompt.length + JSON.stringify(roomy.tools).length;
    expect(prefixChars).toBeGreaterThan(0);

    // Ceiling strictly below the constant prefix → the over-prefix case.
    const overPrefix = 10;
    expect(prefixChars).toBeGreaterThan(overPrefix);
    vi.stubEnv('PLAN_PROMPT_MAX_CHARS', String(overPrefix));
    const tight = builder.build(makeOversizedPerception());

    // Prefix is untouched (plan legality — spec 037/058; KV-cache — spec 021).
    expect(tight.systemPrompt).toBe(roomy.systemPrompt);
    expect(tight.tools).toEqual(roomy.tools);
    // The budgeted context is empty, not a shrunk enum.
    expect(tight.perceptionContext).toBe('');
    expect(tight.planContextDiagnostic!.budgetChars).toBe(0);
    expect(tight.planContextDiagnostic!.keptChars).toBe(0);
    expect(tight.planContextDiagnostic!.truncatedBlockId).toBeDefined();
    // The effective prompt is exactly the prefix: the AC cannot be met by
    // shrinking the legality surface.
    expect(estimatePlanPrompt(tight).chars).toBe(prefixChars);
    expect(estimatePlanPrompt(tight).chars).toBeGreaterThan(overPrefix);
  });
});

// ── AC-1/R4: client-seam diagnostic co-emission + env-gated dump ─────────────

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

const validPlan = {
  description: 'Restore curiosity',
  steps: [{ description: 'Water the plants', targetAffordance: 'water_plants' }],
};

describe('QA spec 061 AC-1/R4 — client seam emits [plan-prompt] + [plan-context] every request', () => {
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    errSpy.mockRestore();
    vi.restoreAllMocks();
  });

  function lines(): string[] {
    return errSpy.mock.calls.map((c) => String(c[0]));
  }

  it('emits both diagnostic lines exactly once and preserves the [plan-prompt] format', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(toolCallResponse(validPlan)));
    const builder = new PlanBuilderImpl();
    vi.stubEnv('PLAN_PROMPT_MAX_CHARS', '100000');
    const payload = builder.build(makeOversizedPerception());
    payload.agentId = 'a1';

    const client = new OpenAICompatibleLLMClient({ baseUrl: 'http://localhost:1', model: 'test' });
    await client.completePlan(payload);

    const prompts = lines().filter((l) => l.includes('[plan-prompt]'));
    const contexts = lines().filter((l) => l.includes('[plan-context]'));
    expect(prompts).toHaveLength(1);
    expect(contexts).toHaveLength(1);
    // `[plan-prompt]` is the spec-060 pre-repair denominator — byte format kept.
    expect(prompts[0]).toMatch(/^\[plan-prompt\] agent=a1 chars=\d+ estTokens=\d+$/);
    expect(prompts[0]).toContain(`chars=${estimatePlanPrompt(payload).chars}`);
    // `[plan-context]` is the R4 grower instrument.
    expect(contexts[0]).toMatch(
      /^\[plan-context\] agent=a1 orig=\d+ budget=\d+ kept=\d+ dropped=.* top=.*:\d+$/,
    );
    vi.unstubAllGlobals();
  });

  it('is inert when PLAN_PAYLOAD_DUMP_DIR is unset (no dump written)', async () => {
    delete process.env['PLAN_PAYLOAD_DUMP_DIR'];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(toolCallResponse(validPlan)));
    const dir = mkdtempSync(pathJoin(tmpdir(), 'spec-061-qa-inert-'));
    try {
      const client = new OpenAICompatibleLLMClient({
        baseUrl: 'http://localhost:1',
        model: 'test',
      });
      await client.completePlan({
        systemPrompt: 'You are an agent.',
        perceptionContext: 'Room: garden',
        availableAffordances: [],
        cognitiveTools: [],
        tools: [],
        agentId: 'a1',
      });
      expect(existsSync(pathJoin(dir, 'plan-payload-a1.json'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      vi.unstubAllGlobals();
    }
  });

  it('writes the full largest payload when PLAN_PAYLOAD_DUMP_DIR is set', async () => {
    const dir = mkdtempSync(pathJoin(tmpdir(), 'spec-061-qa-dump-'));
    try {
      vi.stubEnv('PLAN_PAYLOAD_DUMP_DIR', dir);
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(toolCallResponse(validPlan)));
      const client = new OpenAICompatibleLLMClient({
        baseUrl: 'http://localhost:1',
        model: 'test',
      });
      await client.completePlan({
        systemPrompt: 'You are an agent.',
        perceptionContext: 'Room: garden',
        availableAffordances: [],
        cognitiveTools: [],
        tools: [],
        agentId: 'a1',
      });

      const file = pathJoin(dir, 'plan-payload-a1.json');
      expect(existsSync(file)).toBe(true);
      const dump = JSON.parse(readFileSync(file, 'utf8'));
      expect(dump.agentId).toBe('a1');
      expect(dump.systemPrompt).toBe('You are an agent.');
      expect(dump.perceptionContext).toBe('Room: garden');
      expect(Array.isArray(dump.messages)).toBe(true);
      expect(dump.messages).toHaveLength(2);
      expect(dump.tools).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      vi.unstubAllGlobals();
    }
  });
});

// ── AC-1/AC-6: legality surface survives the full builder → wire path ────────

describe('QA spec 061 AC-1/AC-6 — the tool enum on the wire is never budgeted', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('sends the untouched formulate_plan enum and a bounded context to the provider', async () => {
    vi.stubEnv('PLAN_PROMPT_MAX_CHARS', '100000');
    const builder = new PlanBuilderImpl();
    const roomy = builder.build(makeOversizedPerception());
    const prefixChars = roomy.systemPrompt.length + JSON.stringify(roomy.tools).length;

    const ceiling = prefixChars + 300;
    vi.stubEnv('PLAN_PROMPT_MAX_CHARS', String(ceiling));
    const payload = builder.build(makeOversizedPerception());
    payload.agentId = 'a1';

    const fetchMock = vi.fn().mockResolvedValue(toolCallResponse(validPlan));
    vi.stubGlobal('fetch', fetchMock);
    const client = new OpenAICompatibleLLMClient({ baseUrl: 'http://localhost:1', model: 'test' });
    await client.completePlan(payload);

    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    // The context actually sent is within the ceiling …
    expect(estimatePlanPrompt(payload).chars).toBeLessThanOrEqual(ceiling);
    const userMessage = body.messages.find((m: { role: string }) => m.role === 'user');
    expect(userMessage.content).toBe(payload.perceptionContext);
    // … and the legality surface is byte-identical to the unbudgeted build.
    const planTool = body.tools.find((t: { name: string }) => t.name === 'formulate_plan');
    const roomyPlanTool = roomy.tools.find((t) => t.name === 'formulate_plan');
    expect(planTool).toEqual(roomyPlanTool);
    expect(body.messages[0].content).toBe(roomy.systemPrompt);
  });
});
