/**
 * Issue #212 — QA coverage audit for the plan-phase contract alignment
 * (PR #226, proven by the spec-061 R5 probe).
 * ────────────────────────────────────────────────────────────────────────────
 * The Developer suite (`spec-212-plan-phase-contract-alignment.test.ts`) locks
 * the two new social directive strings and the initial-call wrong-tool
 * diagnostic. This audit closes the gaps that suite leaves open, without
 * touching the implementation:
 *
 *   AC-3 — the PLAN-form drive/chain renderers (`formatPlanDriveHint` /
 *          `formatPlanChainHint`) are asserted directly (the Developer suite
 *          only sweeps the social blocks).
 *   AC-1/AC-2/AC-3 — a banned-phrase sweep over the WHOLE assembled plan
 *          payload across four scenarios (social, direct drive, chain, plain),
 *          plus the legality pin that `formulate_plan` is still offered.
 *   AC-5 — the BOUNDED-REPAIR path: a non-`formulate_plan` repair response is
 *          named `reason=wrong-tool`, not hidden behind the repair reason.
 *   AC-6 — a throwing wrong-tool writer never propagates (spec 049).
 *
 * Known residual (reported, not asserted as green): the `agents-present`
 * context block still renders "You can call talk_to, observe_agent, help, or
 * ignore directly to interact with other agents." — a direct-call instruction
 * the plan phase rejects. It is outside the Developer suite's banned list and
 * is filed as a gap in the QA report for issue #212.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Affordance, PassivePerception, PerceptionResult } from '@evol-hive/shared';
import { PlanBuilderImpl } from '../src/pper/plan-builder.js';
import {
  matchDrivesToAffordances,
  formatPlanDriveHint,
  formatPlanChainHint,
} from '../src/pper/drive-affordance-matcher.js';
import { logPlanWrongTool } from '../src/pper/plan-shape-diagnostic.js';
import { OpenAICompatibleLLMClient, LLMResponseError } from '../src/llm/openai-client.js';

const builder = new PlanBuilderImpl();

// ── Fixtures ─────────────────────────────────────────────────────────────────

/** A garden-bench restorer copied from the real scene (spec 034). */
function sitOutside(): Affordance {
  return {
    id: 'sit_outside',
    label: 'Sit outside',
    engineEffect: 'sit_outside',
    preconditions: [],
    effects: { energy: 3 },
    objectId: 'garden-bench-1',
    objectName: 'Garden Bench',
  } as Affordance;
}

/** The planter's first hunger-chain step copied from the real scene (spec 048). */
function plantSeeds(): Affordance {
  return {
    id: 'plant_seeds',
    label: 'Plant seeds (after 3 plantings, vegetables ripen for harvest)',
    engineEffect: 'plant_seeds',
    preconditions: [],
    effects: {},
    objectId: 'planter-1',
    objectName: 'Planter',
    progresses: { drive: 'hunger', note: 'harvest → eat restores hunger' },
  } as Affordance;
}

const DRIVES_CALM = { energy: 80, hunger: 80, social: 80, comfort: 80, curiosity: 80 };

function makeSocialPerception(): PerceptionResult {
  const passive: PassivePerception = {
    roomId: 'kitchen',
    objectsPresent: [],
    drives: { ...DRIVES_CALM, social: 10 },
    agentsPresent: [{ agentId: 'bob-1', name: 'Bob', currentActivity: 'idle', isThinking: false }],
  };
  return {
    passive,
    prunedAffordances: [],
    primaryDriveLabel: 'low social, need to restore social',
  };
}

function makePerception(overrides: Partial<PerceptionResult> = {}): PerceptionResult {
  const passive: PassivePerception = {
    roomId: 'garden',
    objectsPresent: [],
    drives: { ...DRIVES_CALM },
  };
  return {
    passive,
    prunedAffordances: [],
    primaryDriveLabel: 'content',
    ...overrides,
  };
}

/**
 * The phrases the plan phase removed: every one of them instructs the model to
 * bypass / not use `formulate_plan` or to call an affordance directly, which
 * `completePlan` rejects. `formulate_plan` is the only accepted call.
 */
const BANNED_PLAN_BYPASS_PHRASES = [
  'do not use formulate_plan',
  'Do not formulate a plan first',
  'do not formulate a search plan',
  'Call talk_to or help NOW',
  'Call such an affordance NOW',
  'call the next chain step NOW',
];

// ── AC-3: the plan-form renderers directly ───────────────────────────────────

describe('spec-212 QA — plan-form drive/chain renderers (AC-3)', () => {
  it('formatPlanDriveHint is plan-shaped (no "Call such an affordance NOW" tail)', () => {
    const match = matchDrivesToAffordances({ ...DRIVES_CALM, energy: 23 }, [sitOutside()]).find(
      (m) => m.drive === 'energy',
    )!;
    expect(formatPlanDriveHint(match)).toBe(
      "Your energy is low (23). The affordances in your tool list restore it directly (e.g., sit_outside at the Garden Bench). Make that affordance your plan's next step.",
    );
  });

  it('formatPlanChainHint is plan-shaped (no "call the next chain step NOW" tail)', () => {
    const match = matchDrivesToAffordances({ ...DRIVES_CALM, hunger: 23 }, [plantSeeds()]).find(
      (m) => m.drive === 'hunger',
    )!;
    expect(formatPlanChainHint(match)).toBe(
      'Your hunger is low (23). planter-1 "plant_seeds" progresses the hunger chain (harvest → eat restores hunger) — make the next chain step your plan\'s next step; the restoration lands at the chain\'s end.',
    );
  });
});

// ── AC-1/AC-2/AC-3: whole-payload banned-phrase sweep ────────────────────────

describe('spec-212 QA — the assembled plan payload never instructs a bypass (AC-1/2/3)', () => {
  const scenarios: Array<{ name: string; perception: PerceptionResult }> = [
    { name: 'social agents present', perception: makeSocialPerception() },
    {
      name: 'direct drive restorer',
      perception: makePerception({
        passive: {
          roomId: 'garden',
          objectsPresent: [],
          drives: { ...DRIVES_CALM, energy: 23 },
        },
        prunedAffordances: [sitOutside()],
        primaryDriveLabel: 'low energy, need to restore energy',
      }),
    },
    {
      name: 'hunger chain step',
      perception: makePerception({
        passive: {
          roomId: 'garden',
          objectsPresent: [],
          drives: { ...DRIVES_CALM, hunger: 23 },
        },
        prunedAffordances: [plantSeeds()],
        primaryDriveLabel: 'low hunger, need to restore hunger',
      }),
    },
    { name: 'plain context', perception: makePerception() },
  ];

  for (const { name, perception } of scenarios) {
    it(`[${name}] contains no bypass phrase in systemPrompt or perceptionContext`, () => {
      const payload = builder.build(perception);
      const all = `${payload.systemPrompt}\n${payload.perceptionContext}`;
      for (const banned of BANNED_PLAN_BYPASS_PHRASES) {
        expect(all).not.toContain(banned);
      }
    });

    it(`[${name}] still offers the formulate_plan tool (legality surface untouched)`, () => {
      const payload = builder.build(perception);
      expect(payload.tools.some((t) => t.function.name === 'formulate_plan')).toBe(true);
    });
  }

  it('renders the tool-routing social directive and primary hint for a co-located agent', () => {
    const payload = builder.build(makeSocialPerception());
    expect(payload.systemPrompt).toContain('calling the talk_to, observe_agent, or help tool directly');
    expect(payload.perceptionContext).toContain(
      'IMPORTANT: Other agents are present. If you want to interact with them, call the talk_to, observe_agent, or help tool directly — social actions are their own tools, not plan steps. Use formulate_plan only for the object affordances listed in its enum (or "wait").',
    );
    expect(payload.perceptionContext).toContain(
      'Your social drive is your most urgent need. Interact with another agent in this room by calling the talk_to tool directly (or observe_agent / help).',
    );
  });

  it('renders the plan-shaped drive hint for an urgent drive with a visible restorer', () => {
    const payload = builder.build(
      makePerception({
        passive: {
          roomId: 'garden',
          objectsPresent: [],
          drives: { ...DRIVES_CALM, energy: 23 },
        },
        prunedAffordances: [sitOutside()],
        primaryDriveLabel: 'low energy, need to restore energy',
      }),
    );
    expect(payload.perceptionContext).toContain("Make that affordance your plan's next step.");
  });
});

// ── AC-5/AC-6: the wrong-tool diagnostic at the client repair seam ───────────

const BASE_URL = 'http://localhost:8080/v1';
const MODEL = 'llama3.1';
const AGENT_ID = 'a1';

function toolCallResponse(toolName: string, argumentsObj: unknown): Response {
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
                function: { name: toolName, arguments: JSON.stringify(argumentsObj) },
              },
            ],
          },
        },
      ],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

interface PlanPayloadOverrides {
  systemPrompt?: string;
  perceptionContext?: string;
  agentId?: string;
}

function makePayload(
  overrides: PlanPayloadOverrides = {},
): Parameters<OpenAICompatibleLLMClient['completePlan']>[0] {
  return {
    systemPrompt: 'You are an agent.',
    perceptionContext: 'You are in a kitchen.',
    availableAffordances: [],
    cognitiveTools: [],
    tools: [],
    agentId: AGENT_ID,
    ...overrides,
  } as Parameters<OpenAICompatibleLLMClient['completePlan']>[0];
}

describe('spec-212 QA — wrong-tool naming at the repair seam (AC-5/AC-6)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const originalFetch = globalThis.fetch;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    errSpy.mockRestore();
    vi.restoreAllMocks();
  });

  function lines(): string[] {
    return errSpy.mock.calls.map((c) => String(c[0]));
  }

  it('logPlanWrongTool emits the exact diagnostic line with size units', () => {
    logPlanWrongTool('a1', 'talk_to', { chars: 123, estTokens: 31 });
    expect(lines()).toContain(
      '[plan-invalid] agent=a1 reason=wrong-tool tool=talk_to chars=123 estTokens=31',
    );
  });

  it('a non-formulate_plan REPAIR response is named wrong-tool, not the repair reason', async () => {
    // First response is a well-shaped formulate_plan with an empty step →
    // triggers the bounded repair. The repair answers with a physical
    // affordance tool the plan phase cannot accept.
    fetchMock
      .mockResolvedValueOnce(
        toolCallResponse('formulate_plan', {
          description: 'Restore energy',
          steps: [{ description: '', targetAffordance: 'sit_outside' }],
        }),
      )
      .mockResolvedValueOnce(toolCallResponse('sit_outside', { description: 'x' }));

    const client = new OpenAICompatibleLLMClient({ baseUrl: BASE_URL, model: MODEL });
    await expect(client.completePlan(makePayload())).rejects.toThrow(LLMResponseError);

    const invalid = lines().filter((l) => l.includes('[plan-invalid]'));
    expect(invalid).toHaveLength(2);
    // Pre-repair detection keeps the genuine shape reason.
    expect(invalid[0]).toContain('reason=empty-step-description');
    expect(invalid[0]).not.toContain('wrong-tool');
    // The repair's obedient-but-wrong tool choice is named honestly.
    expect(invalid[1]).toContain('reason=wrong-tool');
    expect(invalid[1]).toContain('tool=sit_outside');
    expect(invalid[1]).not.toContain('reason=empty-step-description');
  });

  it('a throwing wrong-tool writer never propagates (spec 049)', async () => {
    errSpy.mockImplementation((...args: unknown[]) => {
      if (String(args[0]).includes('reason=wrong-tool')) throw new Error('diag boom');
    });
    // Wrong tool first, then a valid repair — the cycle must still succeed.
    fetchMock
      .mockResolvedValueOnce(toolCallResponse('sit_outside', { description: 'x' }))
      .mockResolvedValueOnce(
        toolCallResponse('formulate_plan', {
          description: 'Restore energy',
          steps: [{ description: 'Sit outside', targetAffordance: 'sit_outside' }],
        }),
      );

    const client = new OpenAICompatibleLLMClient({ baseUrl: BASE_URL, model: MODEL });
    await expect(client.completePlan(makePayload())).resolves.toMatchObject({
      description: 'Restore energy',
    });
  });
});
