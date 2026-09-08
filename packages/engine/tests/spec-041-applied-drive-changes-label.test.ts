/**
 * Spec 041 — Applied-DriveChanges label signal: engine side
 * (issue #152, R3, R4 / AC-1, AC-2, AC-3).
 *
 * The scheduler captures the orchestrator's resolved `PPERCycleOutcome` and
 * passes it to `outcomeRecorder.onCycleSettled(agentId, outcome)`; on a
 * rejected cycle it passes `(agentId, undefined, message)`. The recorder
 * labels `drivesChanged` from `outcome?.appliedDriveChanges ?? false` — the
 * drives-diff dimension is REMOVED, so ambient decay (however large) is
 * invisible by construction, while ANY applied affordance delta (even 1
 * point) counts. Snapshots and `tracker.recordCycleCompleted` bookkeeping
 * are unchanged (the trigger source still depends on them).
 */
import { describe, it, expect, vi } from 'vitest';
import type {
  GameTick,
  HardTriggerFlags,
  OutcomeSnapshot,
  PPERCycleOutcome,
  PPEROrchestratorPort,
  PPERSchedulerConfig,
  ReactGateDecision,
  System1GatePort,
  System1OutcomeProbePort,
  CycleOutcomeSample,
} from '@evol-hive/shared';
import { AgentManagerImpl } from '../src/agents/index.js';
import { PPERScheduler } from '../src/systems/pper-scheduler.js';
import { System1OutcomeRecorderImpl, System1AgentTracker } from '../src/systems/index.js';

const TICK: GameTick = { tickNumber: 1, simulationTime: 0.0167, deltaSeconds: 0.0167 };

function makeAgent(id = 'a1') {
  return {
    id,
    name: id,
    description: 'test',
    traits: [],
    initialDrives: { energy: 50, hunger: 50, social: 50, comfort: 50, curiosity: 50 },
  };
}

/** Orchestrator stub with a scriptable resolved outcome (or a rejection). */
class FakeOrchestrator implements PPEROrchestratorPort {
  runCycleCalls: string[] = [];
  /** Queued outcomes; the last entry repeats. */
  outcomes: (PPERCycleOutcome | Error)[] = [];

  async runCycle(agentId: string): Promise<PPERCycleOutcome> {
    this.runCycleCalls.push(agentId);
    const next = this.outcomes.shift();
    if (next instanceof Error) throw next;
    return next ?? { appliedDriveChanges: false };
  }

  getPhase(_agentId: string) {
    return 'perceive' as const;
  }
}

class ScriptedGate implements System1GatePort {
  decisions: ReactGateDecision[] = [];
  decide(_agentId: string, _tickNumber: number, _hardTriggers: HardTriggerFlags): ReactGateDecision {
    const next = this.decisions.shift();
    if (next) return next;
    return { pReact: 0, react: false, hardTrigger: false, headVersion: 1, failOpen: false };
  }
}

const NO_TRIGGERS: HardTriggerFlags = {
  messagePending: false,
  conversationInvite: false,
  nearbyObjectMutation: false,
  driveThresholdCrossing: false,
};

class RecordingSink {
  readonly samples: CycleOutcomeSample[] = [];
  append(sample: CycleOutcomeSample): void {
    this.samples.push(sample);
  }
}

class ScriptedProbe implements System1OutcomeProbePort {
  snapshots: OutcomeSnapshot[] = [];
  async snapshot(_agentId: string): Promise<OutcomeSnapshot> {
    return (
      this.snapshots.shift() ?? {
        planId: null,
        planStepIndex: 0,
        drives: { energy: 50, hunger: 50, social: 50, comfort: 50, curiosity: 50 },
        memoryCount: 0,
        conversationTurns: 0,
      }
    );
  }
}

function baseSnapshot(planId: string | null = null): OutcomeSnapshot {
  return {
    planId,
    planStepIndex: 0,
    drives: { energy: 50, hunger: 50, social: 50, comfort: 50, curiosity: 50 },
    memoryCount: 0,
    conversationTurns: 0,
  };
}

function decision(react: boolean, hardTrigger = false): ReactGateDecision {
  return { pReact: react ? 0.9 : 0, react, hardTrigger, headVersion: 1, failOpen: false };
}

/** Spy recorder capturing settled calls + delegating to the real recorder. */
function makeRecorderHarness() {
  const sink = new RecordingSink();
  const probe = new ScriptedProbe();
  const tracker = new System1AgentTracker();
  const real = new System1OutcomeRecorderImpl({
    probe,
    sink: { append: (s) => sink.samples.push(s) },
    tracker,
    featureSource: undefined,
  });
  const settledCalls: {
    agentId: string;
    outcome: PPERCycleOutcome | undefined;
    error: string | undefined;
  }[] = [];
  const spy = {
    onCycleStart: real.onCycleStart.bind(real),
    onTick: real.onTick.bind(real),
    onCycleSettled: (agentId: string, outcome?: PPERCycleOutcome, error?: string): void => {
      settledCalls.push({ agentId, outcome, error });
      real.onCycleSettled(agentId, outcome, error);
    },
  };
  return { sink, probe, tracker, spy, settledCalls };
}

describe('Spec 041 — scheduler threads the outcome (R3.1)', () => {
  it('a resolved outcome is passed to onCycleSettled(agentId, outcome) in the finally block', async () => {
    const agents = new AgentManagerImpl();
    agents.spawn(makeAgent('a1'));
    const orch = new FakeOrchestrator();
    orch.outcomes = [{ appliedDriveChanges: true }];
    const gate = new ScriptedGate();
    gate.decisions = [{ pReact: 0.9, react: true, hardTrigger: false, headVersion: 1, failOpen: false }];
    const { spy, settledCalls } = makeRecorderHarness();
    const scheduler = new PPERScheduler(
      agents,
      orch,
      { maxConcurrentCycles: 8 } as PPERSchedulerConfig,
      { gate, outcomeRecorder: spy },
    );

    scheduler.update(TICK);
    await vi.waitFor(() => expect(settledCalls).toHaveLength(1));
    expect(settledCalls[0]!.agentId).toBe('a1');
    expect(settledCalls[0]!.outcome).toEqual({ appliedDriveChanges: true });
    expect(settledCalls[0]!.error).toBeUndefined();
  });

  it('a rejected cycle calls onCycleSettled(agentId, undefined, message)', async () => {
    const agents = new AgentManagerImpl();
    agents.spawn(makeAgent('a1'));
    const orch = new FakeOrchestrator();
    orch.outcomes = [new Error('LLM exploded')];
    const gate = new ScriptedGate();
    gate.decisions = [{ pReact: 0.9, react: true, hardTrigger: false, headVersion: 1, failOpen: false }];
    const { settledCalls } = makeRecorderHarness();
    const scheduler = new PPERScheduler(
      agents,
      orch,
      { maxConcurrentCycles: 8 } as PPERSchedulerConfig,
      { gate, outcomeRecorder: spyOnly(settledCalls) },
    );

    scheduler.update(TICK);
    await vi.waitFor(() => expect(settledCalls).toHaveLength(1));
    expect(settledCalls[0]!.agentId).toBe('a1');
    expect(settledCalls[0]!.outcome).toBeUndefined();
    expect(settledCalls[0]!.error).toBe('LLM exploded');
  });

  it('legacy orchestrators (resolve void, no outcome) → recorder receives no outcome, no crash', async () => {
    const agents = new AgentManagerImpl();
    agents.spawn(makeAgent('a1'));
    const legacy = {
      runCycleCalls: [] as string[],
      async runCycle(agentId: string): Promise<void> {
        this.runCycleCalls.push(agentId);
      },
      getPhase: () => 'perceive' as const,
    };
    const gate = new ScriptedGate();
    gate.decisions = [{ pReact: 0.9, react: true, hardTrigger: false, headVersion: 1, failOpen: false }];
    const { settledCalls } = makeRecorderHarness();
    const scheduler = new PPERScheduler(
      agents,
      legacy as unknown as PPEROrchestratorPort,
      { maxConcurrentCycles: 8 } as PPERSchedulerConfig,
      { gate, outcomeRecorder: spyOnly(settledCalls) },
    );

    scheduler.update(TICK);
    await vi.waitFor(() => expect(settledCalls).toHaveLength(1));
    expect(settledCalls[0]!.outcome).toBeUndefined();
  });
});

describe('Spec 041 — labeling from the applied signal (R3.2 / AC-1, AC-2)', () => {
  it('AC-1: wait-only cycle, no applied drive changes, drives decayed ≥5 points during the interval → IGNORE', async () => {
    // The regression this spec fixes: under maxConcurrentLLM=1 a cycle spans
    // 60–90s of sim time — 6–9 points of pure ambient decay. The OLD
    // snapshot-diff labeler flipped these to REACT; the new labeler ignores
    // decay by construction.
    const agents = new AgentManagerImpl();
    agents.spawn(makeAgent('a1'));
    const orch = new FakeOrchestrator();
    orch.outcomes = [{ appliedDriveChanges: false }]; // wait-only refinement path
    const gate = new ScriptedGate();
    gate.decisions = [{ pReact: 0.9, react: true, hardTrigger: false, headVersion: 1, failOpen: false }];
    const { sink, spy, probe, tracker } = makeRecorderHarness();

    const before = baseSnapshot('plan_W1');
    before.planStepIds = ['wait'];
    const after = baseSnapshot('plan_W2');
    after.planStepIds = ['wait'];
    after.drives = { energy: 44.9, hunger: 50, social: 50, comfort: 50, curiosity: 50 }; // 5.1 points of decay
    probe.snapshots = [before, after];

    const scheduler = new PPERScheduler(
      agents,
      orch,
      { maxConcurrentCycles: 8 } as PPERSchedulerConfig,
      { gate, outcomeRecorder: spy },
    );
    scheduler.update(TICK);
    await vi.waitFor(() => expect(sink.samples).toHaveLength(1));

    expect(sink.samples[0]!.label).toBe('ignore');
    expect(sink.samples[0]!.outcome!.drivesChanged).toBe(false);
    // Bookkeeping (R3.3) is unchanged: the tracker is still pinned to the
    // AFTER drive snapshot — the trigger source depends on it.
    expect(tracker.getDrivesAtLastCycle('a1')!.energy).toBeCloseTo(44.9, 5);
  });

  it('AC-2 (engine level): outcome appliedDriveChanges: true labels REACT even with identical drive snapshots', async () => {
    const agents = new AgentManagerImpl();
    agents.spawn(makeAgent('a1'));
    const orch = new FakeOrchestrator();
    orch.outcomes = [{ appliedDriveChanges: true }]; // a 1-point affordance delta upstream
    const gate = new ScriptedGate();
    gate.decisions = [{ pReact: 0.9, react: true, hardTrigger: false, headVersion: 1, failOpen: false }];
    const { sink, spy, probe } = makeRecorderHarness();

    // Identical before/after snapshots — under the old diff-based labeler
    // this cycle would be IGNORE despite the applied affordance delta.
    probe.snapshots = [baseSnapshot(null), baseSnapshot(null)];

    const scheduler = new PPERScheduler(
      agents,
      orch,
      { maxConcurrentCycles: 8 } as PPERSchedulerConfig,
      { gate, outcomeRecorder: spy },
    );
    scheduler.update(TICK);
    await vi.waitFor(() => expect(sink.samples).toHaveLength(1));

    expect(sink.samples[0]!.label).toBe('react');
    expect(sink.samples[0]!.outcome!.drivesChanged).toBe(true);
  });

  it('AC-3 (engine level): a reflect-applied override outcome (drivesUpdated) labels REACT', async () => {
    // The orchestrator-level test proves the deviation/normal reflect branch
    // sets appliedDriveChanges; here the scheduler threads it end-to-end.
    const agents = new AgentManagerImpl();
    agents.spawn(makeAgent('a1'));
    const orch = new FakeOrchestrator();
    orch.outcomes = [{ appliedDriveChanges: true }];
    const gate = new ScriptedGate();
    gate.decisions = [{ pReact: 0.9, react: true, hardTrigger: false, headVersion: 1, failOpen: false }];
    const { sink, spy, probe } = makeRecorderHarness();
    probe.snapshots = [baseSnapshot(null), baseSnapshot(null)];

    const scheduler = new PPERScheduler(
      agents,
      orch,
      { maxConcurrentCycles: 8 } as PPERSchedulerConfig,
      { gate, outcomeRecorder: spy },
    );
    scheduler.update(TICK);
    await vi.waitFor(() => expect(sink.samples).toHaveLength(1));

    expect(sink.samples[0]!.label).toBe('react');
  });

  it('R1.3 fallback: a legacy (undefined) outcome still labels REACT via memoryWritten — never via decay', async () => {
    const agents = new AgentManagerImpl();
    agents.spawn(makeAgent('a1'));
    const orch = new FakeOrchestrator();
    orch.outcomes = []; // legacy orchestrator — scheduler passes no outcome
    const gate = new ScriptedGate();
    gate.decisions = [{ pReact: 0.9, react: true, hardTrigger: false, headVersion: 1, failOpen: false }];
    const { sink, spy, probe } = makeRecorderHarness();

    const before = baseSnapshot(null);
    const after = baseSnapshot(null);
    after.memoryCount = before.memoryCount + 1; // failed-action fallback memory (spec 040 R3)
    after.drives = { energy: 42, hunger: 50, social: 50, comfort: 50, curiosity: 50 }; // big decay — must be invisible
    probe.snapshots = [before, after];

    const scheduler = new PPERScheduler(
      agents,
      orch,
      { maxConcurrentCycles: 8 } as PPERSchedulerConfig,
      { gate, outcomeRecorder: spy },
    );
    scheduler.update(TICK);
    await vi.waitFor(() => expect(sink.samples).toHaveLength(1));

    expect(sink.samples[0]!.label).toBe('react');
    expect(sink.samples[0]!.outcome!.memoryWritten).toBe(true);
    expect(sink.samples[0]!.outcome!.drivesChanged).toBe(false);
  });

  it('R4.3: hard-trigger samples still always REACT (override untouched)', async () => {
    const agents = new AgentManagerImpl();
    agents.spawn(makeAgent('a1'));
    const orch = new FakeOrchestrator();
    orch.outcomes = [{ appliedDriveChanges: false }];
    const gate = new ScriptedGate();
    gate.decisions = [{ pReact: 0, react: false, hardTrigger: true, headVersion: 1, failOpen: false }];
    const { sink, spy, probe } = makeRecorderHarness();
    probe.snapshots = [baseSnapshot(null), baseSnapshot(null)];

    const scheduler = new PPERScheduler(
      agents,
      orch,
      { maxConcurrentCycles: 8 } as PPERSchedulerConfig,
      {
        gate,
        triggerSource: { getHardTriggers: () => ({ ...NO_TRIGGERS, messagePending: true }) },
        outcomeRecorder: spy,
      },
    );
    scheduler.update(TICK);
    await vi.waitFor(() => expect(sink.samples).toHaveLength(1));

    expect(sink.samples[0]!.label).toBe('react');
    expect(sink.samples[0]!.hardTrigger).toBe(true);
  });
});

/** Minimal recorder spy used by the scheduler-threading-only tests. */
function spyOnly(
  settledCalls: { agentId: string; outcome: PPERCycleOutcome | undefined; error: string | undefined }[],
): {
  onCycleStart(agentId: string, ctx: import('@evol-hive/shared').CycleStartContext): void;
  onCycleSettled(agentId: string, outcome?: PPERCycleOutcome, error?: string): void;
} {
  return {
    onCycleStart: () => {},
    onCycleSettled: (agentId, outcome, error) => {
      settledCalls.push({ agentId, outcome, error });
    },
  };
}