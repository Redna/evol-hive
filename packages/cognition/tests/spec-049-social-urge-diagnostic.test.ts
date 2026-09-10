/**
 * Tests for spec 049 — R1: per-cycle urge/pending diagnostic line (issue #167).
 *
 * Covers:
 * - AC-1 (R1): after A `talk_to`s co-located B, B's next cycle emits exactly
 *   one `[social-urge]` console line containing B's persona seed, the pending
 *   entry (conversation id, from = A, age in ticks, fresh flag), and the urge
 *   entry for A with its four factor values and a rendered-line
 *   classification.
 * - AC-2 (R1): with agents present but no pending addresses and all urges
 *   below the surface threshold, exactly one `[social-urge]` line is still
 *   emitted per cycle (classification `none`); with no agents present, no
 *   line is emitted; a throw inside diagnostic construction (here: a throwing
 *   console.log) leaves the cycle outcome unchanged.
 *
 * The diagnostic lives at the perceive→plan seam in `PPEROrchestratorImpl`
 * (spec 049 Decision 1) and must perform zero LLM calls and never break the
 * cycle (R1 constraints).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type {
  Affordance,
  AgentInternalState,
  AgentProfile,
  AgentSummary,
  ConversationObject,
  PerceptionDataProvider,
  PlanDataProvider,
  ExecuteDataProvider,
  ReflectDataProvider,
} from '@evol-hive/shared';
import {
  SOCIAL_PENDING_FRESH_TICKS,
  computeSocialUrge,
  deriveSocialTalkativenessSeed,
} from '@evol-hive/shared';
import type { LLMClient, LLMContextPayload } from '../src/index.js';
import type { AffordanceClassifier } from '../src/classifier/index.js';
import { PPEROrchestratorImpl } from '../src/pper/orchestrator.js';

// ─── Fakes ───────────────────────────────────────────────────────────────────

const TICK = 5000;

function makeProfile(id: string, name: string, traits: string[]): AgentProfile {
  return {
    id,
    name,
    description: `agent ${id}`,
    traits,
    initialDrives: {},
  };
}

const PERSONA_B = makeProfile('agent-b', 'Bob', ['reserved']);
const PERSONA_A = makeProfile('agent-a', 'Alice', ['energetic']);

function makeState(agentId: string): AgentInternalState {
  return {
    agentId,
    drives: { energy: 50, hunger: 50, social: 40, comfort: 50, curiosity: 50 },
    currentGoal: '',
    currentPlan: null,
    isThinking: false,
    location: 'garden',
    lastPerceptionTick: 0,
  };
}

function makeAgentSummary(agentId: string, name: string): AgentSummary {
  return { agentId, name, currentActivity: 'idle', isThinking: false };
}

/**
 * A conversation object as the engine's `getConversationsAwaitingAgentReply`
 * would return it: open, B participates, A made the last turn at
 * `lastTurnTick`.
 */
function makePendingConversation(lastTurnTick: number): ConversationObject {
  return {
    id: 'conv-900-1',
    topic: 'herbs',
    roomId: 'garden',
    status: 'open',
    participants: [
      {
        agentId: 'agent-a',
        joinedAtTick: lastTurnTick,
        turnCount: 1,
        sentimentCounts: { positive: 0, neutral: 1, negative: 0 },
        role: 'initiator',
      },
      {
        agentId: 'agent-b',
        joinedAtTick: lastTurnTick,
        turnCount: 0,
        sentimentCounts: { positive: 0, neutral: 0, negative: 0 },
        role: 'listener',
      },
    ],
    turns: [
      {
        agentId: 'agent-a',
        content: 'Hello Bob!',
        sentiment: 'neutral',
        tick: lastTurnTick,
        role: 'initiator',
      },
    ],
    openedAt: lastTurnTick,
    lastActivity: lastTurnTick,
  };
}

interface ProviderOptions {
  agentsPresent: AgentSummary[];
  pending?: ConversationObject[];
  /** Overrides for relationship counters toward the present agents. */
  relationship?: { sentCount?: number; receivedCount?: number; trust: number; familiarity: number };
}

function makePerceptionProvider(agentId: string, opts: ProviderOptions): PerceptionDataProvider {
  return {
    getAgentLocation: () => 'garden',
    getObjectsInRoom: () => [],
    getAffordancesInRoom: () => [] as Affordance[],
    getAgentDrives: () => ({ energy: 50, hunger: 50, social: 40, comfort: 50, curiosity: 50 }),
    getPrimaryDriveLabel: () => 'low social, need to restore social',
    getSystemFeedback: () => undefined,
    getAgentsInRoom: () => opts.agentsPresent,
    getAgentProfile: (id: string) => (id === 'agent-b' ? PERSONA_B : PERSONA_A),
    getAgentState: () => makeState(agentId),
    getRelationships: () =>
      opts.relationship !== undefined ? { 'agent-a': opts.relationship } : {},
    getConversationsAwaitingAgentReply: () => opts.pending ?? [],
    getCurrentTick: () => TICK,
  };
}

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

function makeClassifier(): AffordanceClassifier {
  return {
    async prune(_drive, affordances) {
      return affordances;
    },
  };
}

/** LLM whose plan always fails — the cycle aborts right AFTER the diagnostic. */
function makeFailingPlanLLM(): LLMClient {
  return {
    async completeStructured() {
      return { reasoning: 'r', action: 'idle' };
    },
    async completeReflection() {
      return { agentId: 'agent-b', newMemories: [], consolidatedNodeIds: [] };
    },
    // Invalid plan result (no steps) → PlanService returns success:false.
    async completePlan() {
      return { description: '', steps: [] };
    },
    async completeReflect() {
      return { memoryEntry: { content: 'x', importance: 5, type: 'action' } };
    },
  };
}

function makeOrchestrator(agentId: string, opts: ProviderOptions): PPEROrchestratorImpl {
  const state = makeState(agentId);
  return new PPEROrchestratorImpl({
    perceptionProvider: makePerceptionProvider(agentId, opts),
    planProvider: makePlanProvider(state),
    executeProvider: makeExecuteProvider(state),
    reflectProvider: makeReflectProvider(state),
    classifier: makeClassifier(),
    llmClient: makeFailingPlanLLM(),
  });
}

function socialUrgeLines(spy: ReturnType<typeof vi.spyOn>): string[] {
  return spy.mock.calls
    .map((args) => args.map(String).join(' '))
    .filter((line) => line.includes('[social-urge]'));
}

// ─── AC-1 — the diagnostic after being addressed ─────────────────────────────

describe('spec 049 R1 — [social-urge] diagnostic (AC-1)', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
  });

  it("after A talk_to's co-located B, B's next cycle emits exactly one [social-urge] line with seed, pending entry, and urge entry", async () => {
    // A addressed B 100 ticks ago — well inside the fresh window.
    const pending = makePendingConversation(TICK - 100);
    const orch = makeOrchestrator('agent-b', {
      agentsPresent: [makeAgentSummary('agent-a', 'Alice')],
      pending: [pending],
    });

    await orch.runCycle('agent-b');

    const lines = socialUrgeLines(logSpy);
    expect(lines).toHaveLength(1);
    const line = lines[0]!;

    // Agent id + current tick.
    expect(line).toContain('agent=agent-b');
    expect(line).toContain(`tick=${TICK}`);

    // B's derived persona seed ('reserved' → 0.25).
    expect(line).toContain(`seed=${deriveSocialTalkativenessSeed(PERSONA_B)}`);

    // The pending entry: conversation id, from = A, age, fresh flag.
    expect(line).toContain('conv-900-1');
    expect(line).toContain('from=agent-a');
    expect(line).toContain('age=100');
    expect(line).toContain('fresh=true');

    // The urge entry for A with its four factor values and classification.
    const urge = computeSocialUrge({
      personaSeed: deriveSocialTalkativenessSeed(PERSONA_B),
      socialDrive: 40,
      currentTick: TICK,
      relationship: { trust: 50, familiarity: 0 },
    });
    expect(line).toContain('target=agent-a');
    expect(line).toContain(`urge=${urge.urge.toFixed(3)}`);
    expect(line).toContain(`persona=${urge.factors.personaSeed}`);
    expect(line).toContain(`drive=${urge.factors.socialDriveFactor}`);
    expect(line).toContain(`novelty=${urge.factors.noveltyFactor}`);
    expect(line).toContain(`reciprocity=${urge.factors.reciprocityFactor}`);
    expect(line).toContain('line=');
  });

  it('reports the fresh flag false for an address older than SOCIAL_PENDING_FRESH_TICKS', async () => {
    const staleAge = SOCIAL_PENDING_FRESH_TICKS + 5;
    const pending = makePendingConversation(TICK - staleAge);
    const orch = makeOrchestrator('agent-b', {
      agentsPresent: [makeAgentSummary('agent-a', 'Alice')],
      pending: [pending],
    });

    await orch.runCycle('agent-b');

    const lines = socialUrgeLines(logSpy);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(`age=${staleAge}`);
    expect(lines[0]).toContain('fresh=false');
  });
});

// ─── AC-2 — emission gating + failure containment ────────────────────────────

describe('spec 049 R1 — emission rules and failure containment (AC-2)', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
  });

  it('emits exactly one line per cycle with classification none when agents are present but nothing renders', async () => {
    // Low urge (well below the surface threshold), no decayed hint, no pending.
    const orch = makeOrchestrator('agent-b', {
      agentsPresent: [makeAgentSummary('agent-a', 'Alice')],
      relationship: { sentCount: 0, receivedCount: 0, trust: 50, familiarity: 0 },
    });

    await orch.runCycle('agent-b');

    const lines = socialUrgeLines(logSpy);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('line=none');
    expect(lines[0]).toContain('pending=[]');
  });

  it('emits no [social-urge] line when no agents are present', async () => {
    const orch = makeOrchestrator('agent-b', { agentsPresent: [] });

    await orch.runCycle('agent-b');

    expect(socialUrgeLines(logSpy)).toHaveLength(0);
  });

  it('a throwing console.log never changes the cycle outcome', async () => {
    const orch = makeOrchestrator('agent-b', {
      agentsPresent: [makeAgentSummary('agent-a', 'Alice')],
    });

    // The diagnostic (and everything else on console.log) throws — the cycle
    // must still complete with the same outcome as a silent run.
    logSpy.mockImplementation(() => {
      throw new Error('log sink exploded');
    });
    const outcome = await orch.runCycle('agent-b');
    expect(outcome).toEqual({ appliedDriveChanges: false });

    // Sanity: without the throwing sink the same cycle yields the same outcome.
    logSpy.mockImplementation(() => {});
    const quietOutcome = await orch.runCycle('agent-b');
    expect(quietOutcome).toEqual(outcome);
  });
});