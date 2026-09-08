/**
 * Spec 040 — Idle-Tick Memory Suppression: cross-package E2E (AC-4, R4.1).
 * ===========================================================================
 * The cognition suite proves Reflect stores NOTHING on a skipped wait-only
 * cycle (AC-1/AC-2); the engine suite proves the System 1 outcome recorder
 * labels a wait-only cycle with a FLAT memoryCount IGNORE (AC-4) — but its
 * probe snapshots are scripted, so nothing binds the two halves together.
 *
 * This test closes that link at full fidelity, using the only workspace
 * package that may depend on both cognition and engine (`@evol-hive/cli`):
 *
 *   real ExecuteServiceImpl (cognition)  → stepSkipped: true
 *   real ReflectServiceImpl (cognition)  → suppression, zero storeMemory
 *   probe adapter over the REAL reflect data provider (memoryCount =
 *   storeMemoryCalls.length — exactly what a production probe reads)
 *   real System1OutcomeRecorderImpl (engine) → label
 *
 * A wait-only cycle with an explicit LLM memory (R2.3) grows the count →
 * REACT; simulating the pre-spec-040 unconditional idle write also grows
 * the count → REACT (the domino this spec removes).
 */
import { describe, it, expect, vi } from 'vitest';
import type {
  AgentDrives,
  AgentInternalState,
  AgentProfile,
  CycleOutcomeSample,
  CycleStartContext,
  ExecuteDataProvider,
  ExecuteResult,
  HardTriggerFlags,
  MemoryEntryInput,
  OutcomeSnapshot,
  PlanStep,
  ReactGateDecision,
  ReflectDataProvider,
  ReflectLLMResponse,
  ReflectResult,
  System1OutcomeProbePort,
} from '@evol-hive/shared';
import { WAIT_AFFORDANCE } from '@evol-hive/shared';
import type { LLMClient } from '@evol-hive/cognition';
import { ExecuteServiceImpl, ReflectBuilderImpl, ReflectServiceImpl } from '@evol-hive/cognition';
import { System1AgentTracker, System1OutcomeRecorderImpl } from '@evol-hive/engine';

const AGENT_ID = 'a1';
const ROOM_ID = 'kitchen';

const DRIVES: AgentDrives = { energy: 50, hunger: 30, social: 80, comfort: 60, curiosity: 40 };

function makeWaitOnlyPlan(): AgentInternalState['currentPlan'] {
  const steps: PlanStep[] = [
    { description: 'Wait a moment', completed: false, targetAffordance: WAIT_AFFORDANCE },
  ];
  return {
    id: 'plan_wait',
    description: 'Wait out the noise',
    steps,
    currentStepIndex: 0,
    createdAt: 100,
  };
}

function makeAgentState(): AgentInternalState {
  return {
    agentId: AGENT_ID,
    drives: { ...DRIVES },
    currentGoal: 'Stay alive',
    currentPlan: makeWaitOnlyPlan(),
    isThinking: false,
    location: ROOM_ID,
    lastPerceptionTick: 0,
  };
}

// ─── Fakes (providers mirror the production bridge surface) ─────────────────

class FakeExecuteDataProvider implements ExecuteDataProvider {
  agentState: AgentInternalState = makeAgentState();
  currentStep: PlanStep = {
    description: 'Wait a moment',
    completed: false,
    targetAffordance: WAIT_AFFORDANCE,
  };

  advanceStepCalls: string[] = [];

  getAgentState(_agentId: string): AgentInternalState {
    return this.agentState;
  }
  getCurrentStep(_agentId: string): PlanStep {
    return this.currentStep;
  }
  isPlanComplete(_agentId: string): boolean {
    return false;
  }
  resolveAffordance(
    _roomId: string,
    _affordanceId: string,
  ): { objectId: string; affordance: import('@evol-hive/shared').Affordance } | null {
    return null;
  }
  checkPreconditions(
    _affordanceId: string,
    _objectId: string,
  ): { satisfied: boolean; failed: string[] } {
    return { satisfied: true, failed: [] };
  }
  async executeAffordance(
    _objectId: string,
    _affordanceId: string,
    _agentId: string,
  ): Promise<import('@evol-hive/shared').AffordanceResult> {
    return { success: true };
  }
  advanceStep(agentId: string): void {
    this.advanceStepCalls.push(agentId);
  }
  applyDriveChanges(_agentId: string, _changes: Partial<Record<string, number>>): void {}
  setSystemFeedback(_agentId: string, _feedback: string): void {}
  setThinking(_agentId: string, _isThinking: boolean): void {}
}

/**
 * Reflect data provider whose memory store is COUNTABLE: `storeMemoryCalls`
 * doubles as the memory store the production probe would read memoryCount
 * from. Drive changes and plan clearing are no-ops so the ONLY dimension
 * that can move across a cycle is the memory count — isolating the exact
 * signal spec 040 suppresses.
 */
class FakeReflectDataProvider implements ReflectDataProvider {
  agentState: AgentInternalState = makeAgentState();
  storeMemoryCalls: MemoryEntryInput[] = [];

  getAgentState(_agentId: string): AgentInternalState | null {
    return this.agentState;
  }
  applyDriveChanges(_agentId: string, _changes: Partial<Record<string, number>>): void {}
  updateGoal(_agentId: string, _goal: string): void {}
  async storeMemory(_agentId: string, entry: MemoryEntryInput): Promise<void> {
    this.storeMemoryCalls.push(entry);
  }
  clearPlanIfComplete(_agentId: string): boolean {
    return false;
  }
  setThinking(_agentId: string, _isThinking: boolean): void {}
  getAgentProfile(_agentId: string): AgentProfile | null {
    return null;
  }
}

/** Probe adapter over the fake reflect provider — the production wiring shape. */
class ProviderProbe implements System1OutcomeProbePort {
  constructor(private readonly provider: FakeReflectDataProvider) {}

  async snapshot(_agentId: string): Promise<OutcomeSnapshot> {
    const plan = this.provider.agentState.currentPlan;
    return {
      planId: plan?.id ?? null,
      planStepIndex: plan?.currentStepIndex ?? 0,
      drives: { ...this.provider.agentState.drives },
      memoryCount: this.provider.storeMemoryCalls.length,
      conversationTurns: 0,
      planStepIds: plan?.steps.map((step) => step.targetAffordance ?? 'narrative'),
    };
  }
}

class FakeLLMClient implements LLMClient {
  completeStructured = vi.fn();
  completeReflection = vi.fn();
  completePlan = vi.fn();
  completeReflect = vi.fn();
}

const NO_TRIGGERS: HardTriggerFlags = {
  messagePending: false,
  conversationInvite: false,
  nearbyObjectMutation: false,
  driveThresholdCrossing: false,
};

const NO_REACT_DECISION: ReactGateDecision = {
  pReact: 0,
  react: false,
  hardTrigger: false,
  headVersion: 1,
  failOpen: false,
};

async function flushProbePromises(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

interface CycleRun {
  executeResult: ExecuteResult;
  reflectResult: ReflectResult;
  storeMemoryCalls: MemoryEntryInput[];
  samples: CycleOutcomeSample[];
}

/**
 * Drive ONE wait-only PPER cycle through the REAL Execute + Reflect services
 * and label it with the REAL System 1 outcome recorder (probe = the provider's
 * memory store). `legacyIdleWrite` simulates the PRE-spec-040 behavior — the
 * unconditional auto-fallback idle memory that used to be written during
 * Reflect (issue #149's exact domino).
 */
async function runWaitOnlyCycle(
  llmResponse: ReflectLLMResponse,
  legacyIdleWrite = false,
): Promise<CycleRun> {
  const execProvider = new FakeExecuteDataProvider();
  const executeService = new ExecuteServiceImpl({ dataProvider: execProvider });

  const reflectProvider = new FakeReflectDataProvider();
  const llm = new FakeLLMClient();
  if (legacyIdleWrite) {
    // The old resolveMemoryEntry auto-fallback: an importance-3 idle node on
    // EVERY cycle, regardless of the wait-only no-op.
    llm.completeReflect = vi.fn().mockImplementation(async () => {
      await reflectProvider.storeMemory(AGENT_ID, {
        content: `Idle tick — no action taken. Goal: ${reflectProvider.agentState.currentGoal}`,
        importance: 3,
        type: 'observation',
        location: ROOM_ID,
      });
      return {} as ReflectLLMResponse;
    });
  } else {
    llm.completeReflect = vi.fn().mockResolvedValue(llmResponse);
  }
  const reflectService = new ReflectServiceImpl({
    reflectBuilder: new ReflectBuilderImpl(),
    llmClient: llm,
    dataProvider: reflectProvider,
  });

  const samples: CycleOutcomeSample[] = [];
  const recorder = new System1OutcomeRecorderImpl({
    probe: new ProviderProbe(reflectProvider),
    sink: { append: (sample) => samples.push(sample) },
    tracker: new System1AgentTracker(),
    featureSource: undefined,
  });

  const ctx: CycleStartContext = {
    decision: NO_REACT_DECISION,
    hardTriggers: NO_TRIGGERS,
    tickNumber: 1,
    simTime: 0.0167,
  };
  recorder.onCycleStart(AGENT_ID, ctx);
  await flushProbePromises(); // before-snapshot lands (memoryCount = 0)

  const executeResult = await executeService.execute(AGENT_ID);
  const reflectResult = await reflectService.reflect(AGENT_ID, executeResult);

  recorder.onCycleSettled(AGENT_ID);
  await vi.waitFor(() => expect(samples).toHaveLength(1));

  return {
    executeResult,
    reflectResult,
    storeMemoryCalls: reflectProvider.storeMemoryCalls,
    samples,
  };
}

describe('Spec 040 E2E — wait-only suppression through the REAL recorder (AC-4, R4.1)', () => {
  it(
    'suppressed wait-only cycle: Execute reports stepSkipped, Reflect stores nothing, ' +
      'probe sees a FLAT memoryCount → recorder labels IGNORE',
    async () => {
      const run = await runWaitOnlyCycle({});

      // Cognition half (AC-3 + AC-1): wait step skipped, nothing stored.
      expect(run.executeResult.success).toBe(true);
      expect(run.executeResult.stepSkipped).toBe(true);
      expect(run.reflectResult.memoryStored).toBe(false);
      expect(run.storeMemoryCalls).toHaveLength(0);

      // Engine half (AC-4): no delta on any dimension → IGNORE.
      expect(run.samples).toHaveLength(1);
      expect(run.samples[0]!.label).toBe('ignore');
      const outcome = run.samples[0]!.outcome!;
      expect(outcome.memoryWritten).toBe(false);
      expect(outcome.planChanged).toBe(false);
      expect(outcome.drivesChanged).toBe(false);
      expect(outcome.conversationContinued).toBe(false);
    },
  );

  it(
    'explicit LLM memory on a wait-only cycle: Reflect stores it, memoryCount grows → ' +
      'recorder labels REACT (AC-2 + R2.3 end-to-end)',
    async () => {
      const run = await runWaitOnlyCycle({
        memoryContent: 'Noticed the coffee machine humming while waiting',
        memoryImportance: 6,
        memoryType: 'observation',
      });

      // Explicit memories still win over suppression (R2.3).
      expect(run.reflectResult.memoryStored).toBe(true);
      expect(run.storeMemoryCalls).toHaveLength(1);
      expect(run.storeMemoryCalls[0]!.content).toBe(
        'Noticed the coffee machine humming while waiting',
      );

      // memoryWritten signal fires → REACT (correct — something WAS noted).
      expect(run.samples[0]!.label).toBe('react');
      expect(run.samples[0]!.outcome!.memoryWritten).toBe(true);
    },
  );

  it(
    'the PRE-spec-040 unconditional idle write on the same wait-only cycle labels REACT — ' +
      'the exact domino spec 040 removes',
    async () => {
      const run = await runWaitOnlyCycle({}, true);

      // The legacy path wrote one importance-3 idle node during Reflect.
      expect(run.storeMemoryCalls).toHaveLength(1);
      expect(run.storeMemoryCalls[0]!.content).toContain('Idle tick');
      expect(run.storeMemoryCalls[0]!.importance).toBe(3);

      // memoryCount grew → memoryWritten → REACT. This is the mislabeling
      // that starved dream retraining of IGNORE labels before spec 040.
      expect(run.samples[0]!.label).toBe('react');
      expect(run.samples[0]!.outcome!.memoryWritten).toBe(true);
    },
  );
});
