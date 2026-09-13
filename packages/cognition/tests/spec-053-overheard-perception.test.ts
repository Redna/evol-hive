/**
 * Tests for spec 053 — Room-Perceivable Conversation Content (issue #192)
 * — cognition layer: overheard rendering in the dynamic section, the
 * perception-service population, and the per-cycle `[overheard]` diagnostic.
 *
 * Covers:
 * - AC-1 (R1): the perception-builder renders
 *   `INFORMATION: Overheard — {speaker} to {addressee}: "{content}"` lines
 *   BELOW the `---` separator (dynamic section only, spec 021); display names
 *   come from `agentsPresent` with the agent-ID fallback for absent speakers.
 * - AC-4 (R1, R2): whatever lines the provider bounded (≤ 3, latest first)
 *   render exactly, in the given latest-first order.
 * - AC-5 (R5): overheard lines never modify the stable section (nothing above
 *   the `---` changes); participants get no overheard lines engine-side
 *   (asserted in the engine suite) — here: no overheard data → no lines.
 * - AC-7 (R6): when ≥ 1 overheard line renders, exactly one `[overheard]`
 *   line is logged at the perceive→plan seam with per-conversation
 *   rendered/available counts; when nothing is overheard, no line is logged;
 *   the diagnostic never throws on empty/missing fields.
 * - AC-9: no LLM call on any deterministic path — the overheard population is
 *   a pure provider read inside `PerceptionServiceImpl.perceive`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type {
  Affordance,
  AgentInternalState,
  AgentProfile,
  AgentSummary,
  OverheardConversation,
  PerceptionDataProvider,
  PerceptionResult,
  PlanDataProvider,
  ExecuteDataProvider,
  ReflectDataProvider,
} from '@evol-hive/shared';
import type { LLMClient } from '../src/index.js';
import type { AffordanceClassifier } from '../src/classifier/index.js';
import { PerceptionBuilderImpl } from '../src/pper/perception-builder.js';
import { PerceptionServiceImpl } from '../src/pper/index.js';
import { logOverheardDiagnostic } from '../src/pper/overheard-diagnostic.js';
import { PPEROrchestratorImpl } from '../src/pper/orchestrator.js';

// ── Shared fixtures ──────────────────────────────────────────────────────────

const ROOM_ID = 'garden';

const AGENTS_PRESENT: AgentSummary[] = [
  { agentId: 'agent-a', name: 'Fern', currentActivity: 'talking', isThinking: false },
  { agentId: 'agent-b', name: 'Willow', currentActivity: 'talking', isThinking: false },
];

function makeOverheard(): OverheardConversation[] {
  return [
    {
      conversationId: 'conv-100-1',
      topic: 'greenhouse repairs',
      availableLines: 2,
      lines: [
        { speakerId: 'agent-b', addresseeId: 'agent-a', content: 'I will bring a wrench' },
        { speakerId: 'agent-a', addresseeId: 'agent-b', content: 'the pump is clogged again' },
      ],
    },
  ];
}

function makePerceptionResult(overrides: Partial<PerceptionResult> = {}): PerceptionResult {
  return {
    passive: {
      roomId: ROOM_ID,
      objectsPresent: [],
      drives: { energy: 50, hunger: 50, social: 40, comfort: 50, curiosity: 50 },
      ...(AGENTS_PRESENT.length > 0 ? { agentsPresent: AGENTS_PRESENT } : {}),
    },
    prunedAffordances: [],
    primaryDriveLabel: 'curious, want to explore',
    ...overrides,
  };
}

function splitAtSeparator(context: string): { above: string[]; below: string[] } {
  const lines = context.split('\n');
  const sepIndex = lines.indexOf('---');
  expect(sepIndex, 'perceptionContext must contain a --- separator line').toBeGreaterThan(-1);
  return { above: lines.slice(0, sepIndex), below: lines.slice(sepIndex + 1) };
}

// ── AC-1 (R1) — dynamic-section rendering ────────────────────────────────────

describe('spec 053 R1 — overheard lines render in the dynamic section (AC-1)', () => {
  const builder = new PerceptionBuilderImpl();

  it('renders INFORMATION: Overheard lines with display names from agentsPresent', () => {
    const payload = builder.build(makePerceptionResult({ overheard: makeOverheard() }));
    expect(payload.perceptionContext).toContain(
      'INFORMATION: Overheard — Willow to Fern: "I will bring a wrench"',
    );
    expect(payload.perceptionContext).toContain(
      'INFORMATION: Overheard — Fern to Willow: "the pump is clogged again"',
    );
  });

  it('renders below the --- separator only — nothing above it changes (spec 021)', () => {
    const baseline = builder.build(makePerceptionResult());
    const withOverheard = builder.build(makePerceptionResult({ overheard: makeOverheard() }));

    const baseParts = splitAtSeparator(baseline.perceptionContext);
    const overheardParts = splitAtSeparator(withOverheard.perceptionContext);

    // Stable section byte-identical (AC-5 / spec 021 AC-3 discipline).
    expect(overheardParts.above).toEqual(baseParts.above);
    // The overheard lines live below the separator.
    const overheardLines = overheardParts.below.filter((l) => l.includes('INFORMATION: Overheard'));
    expect(overheardLines).toHaveLength(2);
    expect(withOverheard.perceptionContext).not.toMatch(/INFORMATION: Overheard[\s\S]*---/);
  });

  it('falls back to the raw agent ID for speakers not co-present (spec 046 pattern)', () => {
    const overheard: OverheardConversation[] = [
      {
        conversationId: 'conv-100-1',
        topic: 't',
        availableLines: 1,
        lines: [{ speakerId: 'agent-x', addresseeId: 'agent-b', content: 'hello from afar' }],
      },
    ];
    const payload = builder.build(makePerceptionResult({ overheard }));
    expect(payload.perceptionContext).toContain(
      'INFORMATION: Overheard — agent-x to Willow: "hello from afar"',
    );
  });

  it('renders nothing when the perception carries no overheard data (feature-off)', () => {
    const payload = builder.build(makePerceptionResult());
    expect(payload.perceptionContext).not.toContain('Overheard');
  });
});

// ── AC-4 (R1, R2) — bounded, latest-first rendering ──────────────────────────

describe('spec 053 R2 — bounded latest-first rendering (AC-4)', () => {
  const builder = new PerceptionBuilderImpl();

  it('renders exactly the provider-bounded lines, in the given latest-first order', () => {
    // The engine capped 8 window turns to the latest 3 (engine suite, AC-4);
    // the builder must not re-order, re-cap, or drop any of them.
    const overheard: OverheardConversation[] = [
      {
        conversationId: 'conv-100-1',
        topic: 't',
        availableLines: 8,
        lines: [
          { speakerId: 'agent-b', addresseeId: 'agent-a', content: 'turn-8' },
          { speakerId: 'agent-a', addresseeId: 'agent-b', content: 'turn-7' },
          { speakerId: 'agent-b', addresseeId: 'agent-a', content: 'turn-6' },
        ],
      },
    ];
    const payload = builder.build(makePerceptionResult({ overheard }));
    const { below } = splitAtSeparator(payload.perceptionContext);
    const rendered = below.filter((l) => l.includes('INFORMATION: Overheard'));
    expect(rendered).toHaveLength(3);
    expect(rendered[0]).toContain('"turn-8"');
    expect(rendered[1]).toContain('"turn-7"');
    expect(rendered[2]).toContain('"turn-6"');
  });

  it('a conversation bounded to 1 line renders exactly 1', () => {
    const overheard: OverheardConversation[] = [
      {
        conversationId: 'conv-100-1',
        topic: 't',
        availableLines: 1,
        lines: [{ speakerId: 'agent-a', addresseeId: 'agent-b', content: 'only' }],
      },
    ];
    const payload = builder.build(makePerceptionResult({ overheard }));
    const { below } = splitAtSeparator(payload.perceptionContext);
    expect(below.filter((l) => l.includes('INFORMATION: Overheard'))).toHaveLength(1);
  });
});

// ── AC-1 (R1) — perception-service population ────────────────────────────────

function makeProfile(id: string, name: string): AgentProfile {
  return { id, name, description: '', traits: [], initialDrives: {} };
}

function makeState(agentId: string): AgentInternalState {
  return {
    agentId,
    drives: { energy: 50, hunger: 50, social: 40, comfort: 50, curiosity: 50 },
    currentGoal: '',
    currentPlan: null,
    isThinking: false,
    location: ROOM_ID,
    lastPerceptionTick: 0,
  };
}

interface ServiceProviderOptions {
  overheard?: OverheardConversation[];
  /** Simulates a legacy provider that does not implement the R1 method. */
  omitOverheardMethod?: boolean;
  /** Simulates a provider fault — perception must survive (never break). */
  throwOnOverheard?: boolean;
}

function makeServiceProvider(opts: ServiceProviderOptions): PerceptionDataProvider {
  const provider: PerceptionDataProvider = {
    getAgentLocation: () => ROOM_ID,
    getObjectsInRoom: () => [],
    getAffordancesInRoom: () => [] as Affordance[],
    getAgentDrives: () => ({ energy: 50, hunger: 50, social: 40, comfort: 50, curiosity: 50 }),
    getPrimaryDriveLabel: () => 'curious',
    getSystemFeedback: () => undefined,
    getAgentsInRoom: () => AGENTS_PRESENT,
    getAgentProfile: () => makeProfile('agent-c', 'Cedar'),
    getAgentState: () => makeState('agent-c'),
    getConversationsAwaitingAgentReply: () => [],
    getCurrentTick: () => TICK,
  };
  const full = provider as PerceptionDataProvider & {
    getOverheardConversations?: (agentId: string) => OverheardConversation[];
  };
  if (!opts.omitOverheardMethod) {
    full.getOverheardConversations = () => {
      if (opts.throwOnOverheard) throw new Error('provider fault');
      return opts.overheard ?? [];
    };
  }
  return full;
}

function makeClassifier(): AffordanceClassifier {
  return { async prune(_drive, affordances) { return affordances; } } as AffordanceClassifier;
}

describe('spec 053 R1 — PerceptionServiceImpl population (AC-1, AC-9)', () => {
  it('populates PerceptionResult.overheard from the provider (no LLM involved)', async () => {
    const service = new PerceptionServiceImpl({
      provider: makeServiceProvider({ overheard: makeOverheard() }),
      classifier: makeClassifier(),
    });
    const result = await service.perceive('agent-c');
    expect(result.overheard).toEqual(makeOverheard());
  });

  it('keeps overheard undefined for legacy providers without the method', async () => {
    const service = new PerceptionServiceImpl({
      provider: makeServiceProvider({ omitOverheardMethod: true }),
      classifier: makeClassifier(),
    });
    const result = await service.perceive('agent-c');
    expect(result.overheard).toBeUndefined();
  });

  it('a provider fault never breaks perception (overheard undefined, no throw)', async () => {
    const service = new PerceptionServiceImpl({
      provider: makeServiceProvider({ throwOnOverheard: true }),
      classifier: makeClassifier(),
    });
    const result = await service.perceive('agent-c');
    expect(result.overheard).toBeUndefined();
  });
});

// ── AC-7 (R6) — the [overheard] diagnostic ───────────────────────────────────

describe('spec 053 R6 — logOverheardDiagnostic (AC-7)', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
  });

  function overheardLines(): string[] {
    return logSpy.mock.calls
      .map((args) => args.map(String).join(' '))
      .filter((line) => line.includes('[overheard]'));
  }

  it('logs exactly one [overheard] line with per-conversation counts when lines render', () => {
    logOverheardDiagnostic('agent-c', makePerceptionResult({ overheard: makeOverheard() }), 500);
    const lines = overheardLines();
    expect(lines).toHaveLength(1);
    const line = lines[0]!;
    expect(line).toContain('agent=agent-c');
    expect(line).toContain('tick=500');
    expect(line).toContain('conv-100-1');
    expect(line).toContain('rendered=2');
    expect(line).toContain('available=2');
  });

  it('lines-rendered respects the ≤3 cap in the counts; available can exceed it', () => {
    const overheard: OverheardConversation[] = [
      {
        conversationId: 'conv-1',
        topic: 't',
        availableLines: 8,
        lines: [
          { speakerId: 'agent-a', addresseeId: 'agent-b', content: 'turn-8' },
          { speakerId: 'agent-b', addresseeId: 'agent-a', content: 'turn-7' },
          { speakerId: 'agent-a', addresseeId: 'agent-b', content: 'turn-6' },
        ],
      },
    ];
    logOverheardDiagnostic('agent-c', makePerceptionResult({ overheard }), 7);
    const line = overheardLines()[0]!;
    expect(line).toContain('rendered=3');
    expect(line).toContain('available=8');
  });

  it('logs nothing when nothing is overheard (absence is meaningful)', () => {
    logOverheardDiagnostic('agent-c', makePerceptionResult(), 500);
    expect(overheardLines()).toHaveLength(0);
  });

  it('never throws on empty or missing fields', () => {
    expect(() =>
      logOverheardDiagnostic('agent-c', makePerceptionResult({ overheard: [] }), 500),
    ).not.toThrow();
    expect(() =>
      logOverheardDiagnostic(
        'agent-c',
        // Missing fields — malformed perception data must not break a cycle.
        { overheard: [{ conversationId: 'conv-1' }] } as unknown as PerceptionResult,
        undefined,
      ),
    ).not.toThrow();
    expect(() =>
      logOverheardDiagnostic('agent-c', undefined as unknown as PerceptionResult, undefined),
    ).not.toThrow();
    expect(overheardLines()).toHaveLength(0);
  });
});

// ── AC-7 (R6) — the diagnostic at the perceive→plan seam ─────────────────────

const TICK = 5000;

function makePlanProvider(state: AgentInternalState): PlanDataProvider {
  return {
    getAgentState: () => state,
    storePlan: (_id, result) => ({
      id: 'plan-1',
      description: result.description,
      steps: result.steps.map((s) => ({ description: s.description, completed: false })),
      currentStepIndex: 0,
      createdAt: 0,
    }),
    setThinking: () => {},
  };
}

function makeExecuteProvider(state: AgentInternalState): ExecuteDataProvider {
  return {
    getAgentState: () => state,
    getCurrentStep: () => undefined,
    isPlanComplete: () => true,
    resolveAffordance: () => null,
    checkPreconditions: () => ({ satisfied: true, failed: [] }),
    executeAffordance: async () => ({ success: true }),
    advanceStep: () => {},
    applyDriveChanges: () => {},
    setSystemFeedback: () => {},
    setThinking: () => {},
  };
}

function makeReflectProvider(state: AgentInternalState): ReflectDataProvider {
  return {
    getAgentState: () => state,
    applyDriveChanges: () => {},
    updateGoal: () => {},
    storeMemory: async () => {},
    clearPlanIfComplete: () => true,
    setThinking: () => {},
  };
}

/** LLM whose plan always fails — the cycle aborts right AFTER the diagnostic. */
function makeFailingPlanLLM(): LLMClient {
  return {
    async completeStructured() {
      return { reasoning: 'r', action: 'idle' };
    },
    async completeReflection() {
      return { agentId: 'agent-c', newMemories: [], consolidatedNodeIds: [] };
    },
    async completePlan() {
      return { description: '', steps: [] };
    },
    async completeReflect() {
      return { memoryEntry: { content: 'x', importance: 5, type: 'action' } };
    },
  } as unknown as LLMClient;
}

function makeOrchestrator(opts: ServiceProviderOptions): PPEROrchestratorImpl {
  const state = makeState('agent-c');
  return new PPEROrchestratorImpl({
    perceptionProvider: makeServiceProvider(opts),
    planProvider: makePlanProvider(state),
    executeProvider: makeExecuteProvider(state),
    reflectProvider: makeReflectProvider(state),
    classifier: makeClassifier(),
    llmClient: makeFailingPlanLLM(),
  });
}

describe('spec 053 R6 — [overheard] diagnostic at the perceive→plan seam (AC-7)', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
  });

  function overheardLines(): string[] {
    return logSpy.mock.calls
      .map((args) => args.map(String).join(' '))
      .filter((line) => line.includes('[overheard]'));
  }

  it('one cycle with overheard content emits exactly one [overheard] line', async () => {
    const orch = makeOrchestrator({ overheard: makeOverheard() });
    await orch.runCycle('agent-c');
    const lines = overheardLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('agent=agent-c');
    expect(lines[0]).toContain(`tick=${TICK}`);
    expect(lines[0]).toContain('conv-100-1');
  });

  it('a cycle with nothing overheard emits no [overheard] line', async () => {
    const orch = makeOrchestrator({ overheard: [] });
    await orch.runCycle('agent-c');
    expect(overheardLines()).toHaveLength(0);
  });

  it('a throwing console.log never breaks the cycle (logging failure is inert)', async () => {
    logSpy.mockImplementation(() => {
      throw new Error('log sink exploded');
    });
    const orch = makeOrchestrator({ overheard: makeOverheard() });
    const result = await orch.runCycle('agent-c');
    expect(result).toBeDefined();
  });
});