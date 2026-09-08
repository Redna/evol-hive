/**
 * Spec 041 — Applied-DriveChanges Label Signal: cross-package E2E
 * (issue #152, AC-1, AC-2, AC-3, R2.1, R3.1).
 * ────────────────────────────────────────────────────────────────────────────
 * The cognition suite proves the REAL `PPEROrchestratorImpl` computes
 * `appliedDriveChanges` from what the phases DID (real ExecuteServiceImpl /
 * ReflectServiceImpl inside it); the engine suite proves `PPERScheduler`
 * threads a FAKE orchestrator's outcome into the recorder labeled from
 * SCRIPTED probe snapshots. Nothing bound the two halves together: if the
 * halves drift (the orchestrator stops returning the outcome, or the
 * scheduler drops it), each side's own tests still pass while production
 * mislabels. This test closes that seam at full fidelity, using the only
 * workspace package that may depend on both cognition and engine
 * (`@evol-hive/cli`), following the spec-040 E2E pattern (providers mirror
 * the production bridge surface; every LLM call is a scripted mock):
 *
 *   real PPEROrchestratorImpl (cognition) → resolves PPERCycleOutcome
 *     ├─ real PerceptionServiceImpl (passive) + PlanServiceImpl (mock LLM)
 *     ├─ real ExecuteServiceImpl (plain/compound driveChanges — spec 028's
 *     │  once-applied merged map; spec 040's wait branch; spec 025's
 *     │  auto-fallback memories)
 *     └─ real ReflectServiceImpl (sanitized driveOverrides; spec 040
 *        suppression)
 *   real PPERScheduler (engine) → onCycleSettled(agentId, outcome)
 *   real System1OutcomeRecorderImpl (engine) → label from the causal signal
 *
 * The mid-cycle "ambient decay" hooks (scripted LLM calls mutating drives)
 * are the exact production failure mode this spec fixes: under
 * ENGINE_MAX_CONCURRENT_LLM=1 a cycle interval spans 60–90s of sim time, so
 * the OLD snapshot-diff labeler saw 6–9 points of pure physics per cycle and
 * labeled every cycle REACT. Here the decay lands deterministically BETWEEN
 * the recorder's before/after snapshots — inside the LLM calls — so each
 * test pins the label decision at the point where the diff-based labeler
 * and the causal labeler disagree.
 */
import { describe, it, expect, vi } from 'vitest';
import type {
  Affordance,
  AgentDrives,
  AgentInternalState,
  AgentPlan,
  AgentProfile,
  CompoundAction,
  CycleOutcomeSample,
  ExecuteDataProvider,
  FormulatePlanResult,
  GameTick,
  HardTriggerFlags,
  LLMActionResponse,
  LLMContextPayload,
  MemoryEntryInput,
  OutcomeSnapshot,
  PPERCycleOutcome,
  PPERSchedulerConfig,
  PlanDataProvider,
  PlanStep,
  ReactGateDecision,
  ReflectDataProvider,
  ReflectionResult,
  ReflectLLMResponse,
  System1GatePort,
  System1OutcomeRecorderPort,
} from '@evol-hive/shared';
import { WAIT_AFFORDANCE } from '@evol-hive/shared';
import type { AffordanceClassifier, LLMClient } from '@evol-hive/cognition';
import { PPEROrchestratorImpl } from '@evol-hive/cognition';
import {
  AgentManagerImpl,
  PPERScheduler,
  System1AgentTracker,
  System1OutcomeRecorderImpl,
} from '@evol-hive/engine';

const AGENT_ID = 'a1';
const ROOM_ID = 'kitchen';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const BASE_DRIVES: AgentDrives = {
  energy: 50,
  hunger: 50,
  social: 50,
  comfort: 50,
  curiosity: 50,
};

/** Plain affordance whose handler applies a 1-point energy delta (AC-2). */
const brewCoffee: Affordance = {
  id: 'brew_coffee',
  label: 'Brew coffee',
  engineEffect: 'brew_coffee',
  preconditions: [],
  effects: {},
};

/**
 * Compound affordance (spec 028): one step that runs two sub-steps whose
 * driveChanges are merged into a single once-applied map (R2.1 "compound
 * actions: the once-applied merged map included"). It is listed in the
 * room's affordances so the plan enum binds it; plain resolution returns
 * null for it, so compound resolution runs (spec 028's fallback ordering).
 */
const brewCoffeeSequence: Affordance = {
  id: 'brew_coffee_sequence',
  label: 'Brew a cup of coffee',
  engineEffect: 'brew_coffee_sequence',
  preconditions: [],
  effects: {},
};

const addWater: Affordance = {
  id: 'add_water',
  label: 'Add water',
  engineEffect: 'add_water',
  preconditions: [],
  effects: {},
};

const brewCompound: CompoundAction = {
  id: 'brew_coffee_sequence',
  label: 'Brew a cup of coffee',
  steps: [
    { affordanceId: 'add_water', description: 'Add water to the machine' },
    { affordanceId: 'brew_coffee', description: 'Brew the coffee' },
  ],
};

function makeAgentProfile(): AgentProfile {
  return {
    id: AGENT_ID,
    name: 'Brewer',
    description: 'test',
    traits: [],
    initialDrives: { ...BASE_DRIVES },
  };
}

function makeAgentState(): AgentInternalState {
  return {
    agentId: AGENT_ID,
    drives: { ...BASE_DRIVES },
    currentGoal: 'make coffee',
    currentPlan: null,
    isThinking: false,
    location: ROOM_ID,
    lastPerceptionTick: 0,
  };
}

/** A two-step wait-only plan (spec 040: an intentional no-op, pre-seeded). */
function makeWaitOnlyPlan(): NonNullable<AgentInternalState['currentPlan']> {
  const steps: PlanStep[] = [
    { description: 'Wait a moment', completed: false, targetAffordance: WAIT_AFFORDANCE },
    { description: 'Wait some more', completed: false, targetAffordance: WAIT_AFFORDANCE },
  ];
  return {
    id: 'plan_wait',
    description: 'Wait out the noise',
    steps,
    currentStepIndex: 0,
    createdAt: 100,
  };
}

// ─── Fakes (providers mirror the production bridge surface) ─────────────────

/** Clamps like the engine's DriveSystem so drive math stays in range. */
function applyDelta(
  drives: Record<string, number>,
  changes: Partial<Record<string, number>>,
): void {
  for (const [drive, delta] of Object.entries(changes)) {
    const next = Math.min(100, Math.max(0, (drives[drive] ?? 0) + (delta ?? 0)));
    drives[drive] = next;
  }
}

class FakePerceptionDataProvider {
  /** Thrown by getAgentLocation — drives the scheduler's rejection path. */
  locationError: Error | null = null;

  constructor(
    public readonly agentState: AgentInternalState,
    public readonly roomAffordances: Affordance[],
  ) {}

  getAgentLocation(_agentId: string): string {
    if (this.locationError) throw this.locationError;
    return this.agentState.location;
  }
  getObjectsInRoom(_roomId: string): { id: string; name: string; type: string }[] {
    return [{ id: 'coffee-1', name: 'Coffee Machine', type: 'appliance' }];
  }
  getAffordancesInRoom(_roomId: string): Affordance[] {
    return this.roomAffordances;
  }
  getAgentDrives(_agentId: string): Record<string, number> {
    return { ...this.agentState.drives };
  }
  getPrimaryDriveLabel(_agentId: string): string {
    return 'low energy, need to restore energy';
  }
  getSystemFeedback(_agentId: string): string | undefined {
    return undefined;
  }
  getAgentProfile(_agentId: string): AgentProfile | null {
    return null;
  }
}

class FakePlanDataProvider implements PlanDataProvider {
  constructor(public readonly agentState: AgentInternalState) {}

  getAgentState(_agentId: string): AgentInternalState | null {
    return this.agentState;
  }
  storePlan(_agentId: string, result: FormulatePlanResult): AgentPlan {
    const plan: AgentPlan = {
      id: 'plan-1',
      description: result.description,
      steps: result.steps.map((s) => ({
        description: s.description,
        completed: false,
        ...(s.targetAffordance !== undefined ? { targetAffordance: s.targetAffordance } : {}),
      })),
      currentStepIndex: 0,
      createdAt: 0,
    };
    this.agentState.currentPlan = plan;
    return plan;
  }
  setThinking(_agentId: string, isThinking: boolean): void {
    this.agentState.isThinking = isThinking;
  }
}

class FakeExecuteDataProvider implements ExecuteDataProvider {
  /** Per-affordance-id execution results (default: plain success). */
  executionResults: Record<string, import('@evol-hive/shared').AffordanceResult> = {};
  /** Plain affordance lookup by ID (null = not resolvable as plain). */
  plainAffordances: Record<string, Affordance | null> = {};
  /** Compound lookup by ID (null = not resolvable as a compound). */
  compounds: Record<string, { objectId: string; compoundAction: CompoundAction } | null> = {};
  /** Recorded applyDriveChanges calls — proves once-applied merged maps. */
  applyDriveChangesCalls: { agentId: string; changes: Partial<Record<string, number>> }[] = [];

  constructor(public readonly agentState: AgentInternalState) {}

  getAgentState(_agentId: string): AgentInternalState | null {
    return this.agentState;
  }
  getCurrentStep(_agentId: string): PlanStep | null {
    const plan = this.agentState.currentPlan;
    if (!plan) return null;
    return plan.steps[plan.currentStepIndex] ?? null;
  }
  isPlanComplete(_agentId: string): boolean {
    const plan = this.agentState.currentPlan;
    if (!plan) return true;
    return plan.currentStepIndex >= plan.steps.length;
  }
  resolveAffordance(
    _roomId: string,
    affordanceId: string,
  ): { objectId: string; affordance: Affordance } | null {
    const affordance = this.plainAffordances[affordanceId];
    return affordance ? { objectId: 'coffee-1', affordance } : null;
  }
  checkPreconditions(
    _affordanceId: string,
    _objectId: string,
  ): { satisfied: boolean; failed: string[] } {
    return { satisfied: true, failed: [] };
  }
  async executeAffordance(
    _objectId: string,
    affordanceId: string,
    _agentId: string,
  ): Promise<import('@evol-hive/shared').AffordanceResult> {
    return this.executionResults[affordanceId] ?? { success: true };
  }
  advanceStep(_agentId: string): void {
    const plan = this.agentState.currentPlan;
    if (plan) {
      this.agentState.currentPlan = {
        ...plan,
        currentStepIndex: plan.currentStepIndex + 1,
      };
    }
  }
  /** Mirrors the engine's DriveSystem: clamped, mutating the LIVE drives the
   * probe reads — the after-snapshot must see applied changes. */
  applyDriveChanges(agentId: string, changes: Partial<Record<string, number>>): void {
    this.applyDriveChangesCalls.push({ agentId, changes: { ...changes } });
    applyDelta(this.agentState.drives, changes);
  }
  setSystemFeedback(_agentId: string, _feedback: string): void {}
  setThinking(_agentId: string, isThinking: boolean): void {
    this.agentState.isThinking = isThinking;
  }
  resolveCompoundAction(
    _roomId: string,
    compoundActionId: string,
  ): { objectId: string; compoundAction: CompoundAction } | null {
    return this.compounds[compoundActionId] ?? null;
  }
}

class FakeReflectDataProvider implements ReflectDataProvider {
  /** Countable memory store — the probe's memoryCount reads its length. */
  storeMemoryCalls: MemoryEntryInput[] = [];
  applyDriveChangesCalls: { agentId: string; changes: Partial<Record<string, number>> }[] = [];

  constructor(public readonly agentState: AgentInternalState) {}

  getAgentState(_agentId: string): AgentInternalState | null {
    return this.agentState;
  }
  applyDriveChanges(agentId: string, changes: Partial<Record<string, number>>): void {
    this.applyDriveChangesCalls.push({ agentId, changes: { ...changes } });
    applyDelta(this.agentState.drives, changes);
  }
  updateGoal(_agentId: string, _goal: string): void {}
  async storeMemory(_agentId: string, entry: MemoryEntryInput): Promise<void> {
    this.storeMemoryCalls.push(entry);
  }
  /** Returns false — the (wait-only) plan STAYS so the spec-040 wait-only
   * refinement keeps holding for the settled sample. */
  clearPlanIfComplete(_agentId: string): boolean {
    return false;
  }
  setThinking(_agentId: string, isThinking: boolean): void {
    this.agentState.isThinking = isThinking;
  }
  getAgentProfile(_agentId: string): AgentProfile | null {
    return null;
  }
}

/** Probe over the LIVE fake state — the production probe's shape (plan, drives,
 * memory count from the reflect provider's store, plan step IDs). */
class ProviderProbe {
  constructor(
    private readonly state: AgentInternalState,
    private readonly reflectProvider: FakeReflectDataProvider,
  ) {}

  async snapshot(_agentId: string): Promise<OutcomeSnapshot> {
    const plan = this.state.currentPlan;
    return {
      planId: plan?.id ?? null,
      planStepIndex: plan?.currentStepIndex ?? 0,
      drives: { ...this.state.drives },
      memoryCount: this.reflectProvider.storeMemoryCalls.length,
      conversationTurns: 0,
      planStepIds: plan?.steps.map((s) => s.targetAffordance ?? 'narrative') ?? [],
      mutationSeq: 0,
    };
  }
}

interface LLMScript {
  /** The formulate_plan result (the plan phase only runs without a plan). */
  plan?: FormulatePlanResult;
  /**
   * Mid-cycle ambient decay applied when the Plan-phase LLM call lands — the
   * simulated 60–90s cycle interval of pure physics, landing BETWEEN the
   * recorder's before-snapshot and the cycle's settle.
   */
  planPhaseDecay?: Partial<Record<string, number>>;
  /** The ReflectLLMResponse the reflect LLM returns. */
  reflect?: ReflectLLMResponse;
  /** Mid-cycle ambient decay applied when the Reflect-phase LLM is called. */
  reflectPhaseDecay?: Partial<Record<string, number>>;
}

class ScriptableLLM implements LLMClient {
  planCalls = 0;
  reflectCalls = 0;

  constructor(
    private readonly state: AgentInternalState,
    private readonly script: LLMScript,
  ) {}

  async completeStructured(_payload: LLMContextPayload): Promise<LLMActionResponse> {
    return { reasoning: 'r', action: 'brew_coffee' };
  }
  async completeReflection(): Promise<ReflectionResult> {
    return { agentId: AGENT_ID, newMemories: [], consolidatedNodeIds: [] };
  }
  async completePlan(_payload: LLMContextPayload): Promise<FormulatePlanResult> {
    this.planCalls += 1;
    // Simulated ambient decay while the LLM was "thinking" (spec 041's exact
    // production failure mode: physics runs DURING the cycle interval).
    if (this.script.planPhaseDecay) applyDelta(this.state.drives, this.script.planPhaseDecay);
    return this.script.plan!;
  }
  async completeReflect(_payload: LLMContextPayload): Promise<ReflectLLMResponse> {
    this.reflectCalls += 1;
    if (this.script.reflectPhaseDecay) {
      applyDelta(this.state.drives, this.script.reflectPhaseDecay);
    }
    return this.script.reflect ?? {};
  }
}

const PASS_THROUGH_CLASSIFIER: AffordanceClassifier = {
  async prune(_driveLabel, affordances) {
    return affordances;
  },
};

// ─── Scheduler-side fixtures (mirror the engine spec-041 harness) ────────────

const TICK: GameTick = { tickNumber: 1, simulationTime: 0.0167, deltaSeconds: 0.0167 };

class ScriptedGate implements System1GatePort {
  decisions: ReactGateDecision[] = [];
  decide(
    _agentId: string,
    _tickNumber: number,
    _hardTriggers: HardTriggerFlags,
  ): ReactGateDecision {
    const next = this.decisions.shift();
    if (next) return next;
    return { pReact: 0, react: false, hardTrigger: false, headVersion: 1, failOpen: false };
  }
}

class RecordingSink {
  readonly samples: CycleOutcomeSample[] = [];
  append(sample: CycleOutcomeSample): void {
    this.samples.push(sample);
  }
}

interface Harness {
  samples: CycleOutcomeSample[];
  settledCalls: {
    agentId: string;
    outcome: PPERCycleOutcome | undefined;
    error: string | undefined;
  }[];
  execProvider: FakeExecuteDataProvider;
  reflectProvider: FakeReflectDataProvider;
  llm: ScriptableLLM;
}

interface HarnessScript {
  /** Pre-seed the agent's plan (the Plan phase then short-circuits). */
  preseededPlan?: NonNullable<AgentInternalState['currentPlan']>;
  /** Affordances listed in the room (drives the plan enum). */
  roomAffordances?: Affordance[];
  /** Plain affordances resolvable by the Execute phase. */
  plainAffordances?: Record<string, Affordance | null>;
  /** Per-affordance execution results. */
  executionResults?: Record<string, import('@evol-hive/shared').AffordanceResult>;
  /** Compound resolution table. */
  compounds?: Record<string, { objectId: string; compoundAction: CompoundAction } | null>;
  llm: LLMScript;
  /** Thrown by the perception provider's getAgentLocation (rejection path). */
  perceptionError?: Error;
}

/**
 * Assemble the REAL stack (orchestrator → scheduler → recorder) and drive one
 * tick. The scheduler fires the cycle; `vi.waitFor` awaits the labeled sample.
 */
function makeHarness(script: HarnessScript): Harness {
  const agents = new AgentManagerImpl();
  agents.spawn(makeAgentProfile());
  const state = makeAgentState();
  if (script.preseededPlan) state.currentPlan = script.preseededPlan;

  const perceptionProvider = new FakePerceptionDataProvider(state, script.roomAffordances ?? []);
  if (script.perceptionError) perceptionProvider.locationError = script.perceptionError;
  const planProvider = new FakePlanDataProvider(state);
  const execProvider = new FakeExecuteDataProvider(state);
  execProvider.plainAffordances = script.plainAffordances ?? {};
  execProvider.executionResults = script.executionResults ?? {};
  execProvider.compounds = script.compounds ?? {};
  const reflectProvider = new FakeReflectDataProvider(state);

  const llm = new ScriptableLLM(state, script.llm);
  const orchestrator = new PPEROrchestratorImpl({
    perceptionProvider,
    planProvider,
    executeProvider: execProvider,
    reflectProvider,
    classifier: PASS_THROUGH_CLASSIFIER,
    llmClient: llm,
  });

  const gate = new ScriptedGate();
  gate.decisions = [
    { pReact: 0.9, react: true, hardTrigger: false, headVersion: 1, failOpen: false },
  ];
  const sink = new RecordingSink();
  const settledCalls: Harness['settledCalls'] = [];
  const real = new System1OutcomeRecorderImpl({
    probe: new ProviderProbe(state, reflectProvider),
    sink: { append: (s) => sink.samples.push(s) },
    tracker: new System1AgentTracker(),
    featureSource: undefined,
  });
  const spy: System1OutcomeRecorderPort = {
    onCycleStart: real.onCycleStart.bind(real),
    onCycleSettled: (agentId, outcome, error) => {
      settledCalls.push({ agentId, outcome, error });
      real.onCycleSettled(agentId, outcome, error);
    },
  };

  const scheduler = new PPERScheduler(
    agents,
    orchestrator,
    { maxConcurrentCycles: 8 } as PPERSchedulerConfig,
    { gate, outcomeRecorder: spy },
  );
  scheduler.update(TICK);

  return { samples: sink.samples, settledCalls, execProvider, reflectProvider, llm };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Spec 041 E2E — real orchestrator → scheduler → recorder (AC-2, AC-3)', () => {
  it(
    'AC-2: a real cycle whose Execute applies a 1-point affordance driveChange labels REACT ' +
      'with drivesChanged=true — even when ambient decay exactly cancels the delta ' +
      '(identical before/after drive snapshots)',
    async () => {
      // before-snapshot: energy 50, no plan. Mid-cycle: the plan LLM call
      // decays energy by 1 (physics, 49) — then Execute applies +1 (50).
      // The snapshots are IDENTICAL: the removed diff-based labeler would
      // have read drivesChanged=false. The causal signal must survive the
      // real orchestrator → scheduler → recorder path and label REACT.
      const harness = makeHarness({
        roomAffordances: [brewCoffee],
        plainAffordances: { brew_coffee: brewCoffee },
        executionResults: {
          brew_coffee: { success: true, driveChanges: { energy: 1 } },
        },
        llm: {
          plan: {
            description: 'Brew coffee to restore energy',
            steps: [{ description: 'Brew coffee', targetAffordance: 'brew_coffee' }],
          },
          planPhaseDecay: { energy: -1 },
        },
      });

      await vi.waitFor(() => expect(harness.samples).toHaveLength(1));
      expect(harness.settledCalls).toHaveLength(1);
      expect(harness.settledCalls[0]!.outcome).toEqual({ appliedDriveChanges: true });
      expect(harness.settledCalls[0]!.error).toBeUndefined();

      const sample = harness.samples[0]!;
      expect(sample.label).toBe('react');
      expect(sample.outcome!.drivesChanged).toBe(true);
      // The 1-point delta WAS applied (clamped) and canceled by decay — the
      // live drives end where they started, proving the label came from the
      // causal outcome, not from diffed state.
      expect(harness.execProvider.applyDriveChangesCalls).toEqual([
        { agentId: AGENT_ID, changes: { energy: 1 } },
      ]);
      expect(harness.reflectProvider.agentState.drives['energy']).toBe(50);
    },
  );

  it(
    'R2.1: a compound action labels the cycle drive-changing from the ONCE-APPLIED merged map ' +
      '(both sub-step deltas merged, applyDriveChanges called exactly once)',
    async () => {
      // The compound's merged map: { energy: +1, comfort: +2 }. Mid-cycle
      // decay of −1 energy / −2 comfort cancels BOTH deltas → identical
      // snapshots. Only the causal outcome can label this REACT.
      const harness = makeHarness({
        roomAffordances: [brewCoffeeSequence, brewCoffee, addWater],
        plainAffordances: {
          // The compound ID is NOT resolvable as a plain affordance —
          // compound resolution only runs after plain fails (spec 028).
          brew_coffee: brewCoffee,
          add_water: addWater,
          brew_coffee_sequence: null,
        },
        executionResults: {
          add_water: { success: true, driveChanges: { energy: 1 } },
          brew_coffee: { success: true, driveChanges: { comfort: 2 } },
        },
        compounds: {
          brew_coffee_sequence: { objectId: 'coffee-1', compoundAction: brewCompound },
        },
        llm: {
          plan: {
            description: 'Brew a cup of coffee',
            steps: [
              { description: 'Brew a cup of coffee', targetAffordance: 'brew_coffee_sequence' },
            ],
          },
          planPhaseDecay: { energy: -1, comfort: -2 },
        },
      });

      await vi.waitFor(() => expect(harness.samples).toHaveLength(1));
      expect(harness.settledCalls[0]!.outcome).toEqual({ appliedDriveChanges: true });

      // The merged map was applied ONCE (spec 028's once-applied semantics),
      // and the outcome saw it (the merged map is execute.result.driveChanges).
      expect(harness.execProvider.applyDriveChangesCalls).toEqual([
        { agentId: AGENT_ID, changes: { energy: 1, comfort: 2 } },
      ]);
      expect(harness.samples[0]!.label).toBe('react');
      expect(harness.samples[0]!.outcome!.drivesChanged).toBe(true);
      // Both deltas landed on the live drives (decay −1/−2 canceled each).
      expect(harness.reflectProvider.agentState.drives['energy']).toBe(50);
      expect(harness.reflectProvider.agentState.drives['comfort']).toBe(50);
    },
  );

  it(
    'AC-3: a real Reflect applying sanitized driveOverrides (drivesUpdated: true) labels REACT ' +
      'with drivesChanged=true through the seam',
    async () => {
      // Execute succeeds WITHOUT driveChanges; the Reflect LLM supplies a
      // sanitized override — the real ReflectServiceImpl applies it via
      // applyDriveChanges and reports drivesUpdated=true.
      const harness = makeHarness({
        roomAffordances: [brewCoffee],
        plainAffordances: { brew_coffee: brewCoffee },
        executionResults: { brew_coffee: { success: true } },
        llm: {
          plan: {
            description: 'Brew coffee',
            steps: [{ description: 'Brew coffee', targetAffordance: 'brew_coffee' }],
          },
          reflect: { driveOverrides: { energy: 5 } },
        },
      });

      await vi.waitFor(() => expect(harness.samples).toHaveLength(1));
      expect(harness.settledCalls[0]!.outcome).toEqual({ appliedDriveChanges: true });

      // The override flowed through the REAL sanitize → applyDriveChanges path.
      expect(harness.reflectProvider.applyDriveChangesCalls).toEqual([
        { agentId: AGENT_ID, changes: { energy: 5 } },
      ]);
      expect(harness.reflectProvider.agentState.drives['energy']).toBe(55);

      expect(harness.samples[0]!.label).toBe('react');
      expect(harness.samples[0]!.outcome!.drivesChanged).toBe(true);
    },
  );
});

describe('Spec 041 E2E — wait-only cycles and failures through the seam', () => {
  it(
    'AC-1: a real wait-only cycle (spec 040 suppression, zero memories) with ≥5 points of ' +
      'ambient decay between the probe snapshots labels IGNORE — the diff-based labeler ' +
      'this spec removes flipped it to REACT',
    async () => {
      // Pre-seeded 2-step wait plan → the plan phase short-circuits (no LLM).
      // Execute skips the wait step (stepSkipped, spec 040 R1.1); Reflect
      // stores NOTHING (spec 040 R2.1). Mid-cycle the reflect LLM call
      // decays energy by 12 points (120s of sim time at 0.1/s) — far above
      // the old ±1.0 epsilon. The causal labeler must IGNORE.
      const harness = makeHarness({
        preseededPlan: makeWaitOnlyPlan(),
        llm: {
          reflectPhaseDecay: { energy: -12 },
        },
      });

      await vi.waitFor(() => expect(harness.samples).toHaveLength(1));
      expect(harness.settledCalls[0]!.outcome).toEqual({ appliedDriveChanges: false });
      expect(harness.reflectProvider.storeMemoryCalls).toHaveLength(0); // suppression
      expect(harness.llm.planCalls).toBe(0); // pre-seeded plan → no plan LLM call

      const sample = harness.samples[0]!;
      expect(sample.label).toBe('ignore');
      expect(sample.outcome!.drivesChanged).toBe(false);
      expect(sample.outcome!.memoryWritten).toBe(false);
      // planStepIndex advanced (0 → 1) so planChanged fired — the spec-040
      // wait-only refinement (planStepIds all 'wait') refines it away.
      expect(sample.outcome!.planChanged).toBe(true);
    },
  );

  it(
    'R3.1 error path: a cycle whose Perceive phase rejects settles as ' +
      'onCycleSettled(agentId, undefined, message) — the recorder still records a sample ' +
      'with an all-false outcome (ignore), never via decay',
    async () => {
      const harness = makeHarness({
        roomAffordances: [brewCoffee],
        llm: {},
        perceptionError: new Error('world exploded'),
      });

      // The rejection must not escape the scheduler (Req 19 resilience) —
      // update() already returned; the error surfaced in the settle payload.
      await vi.waitFor(() => expect(harness.settledCalls).toHaveLength(1));
      expect(harness.settledCalls[0]!.agentId).toBe(AGENT_ID);
      expect(harness.settledCalls[0]!.outcome).toBeUndefined();
      expect(harness.settledCalls[0]!.error).toBe('world exploded');

      // The settled sample is recorded with the safe fallback: every causal
      // dimension false → ignore (drive snapshots are untouched here).
      await vi.waitFor(() => expect(harness.samples).toHaveLength(1));
      expect(harness.samples[0]!.label).toBe('ignore');
      expect(harness.samples[0]!.outcome!.drivesChanged).toBe(false);
      expect(harness.samples[0]!.outcome!.planChanged).toBe(false);
      expect(harness.samples[0]!.outcome!.memoryWritten).toBe(false);
    },
  );
});
