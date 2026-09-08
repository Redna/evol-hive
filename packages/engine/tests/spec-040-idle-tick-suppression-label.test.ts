/**
 * Spec 040 — Idle-Tick Memory Suppression: System 1 outcome label
 * verification (issue #149, R4 / AC-4 — engine verification only).
 *
 * The recorder (spec 035 Req 9) counts `memoryWritten` (memoryCount growth)
 * as a meaningful-change signal. Spec 040 breaks the last domino: cognition
 * no longer stores the auto-fallback idle-tick memory on wait-only (skipped)
 * cycles, so a wait-only cycle with no plan change, no meaningful drive
 * delta, no memory write, and no conversation continuation produces no delta
 * on any dimension → labeled IGNORE.
 *
 * These tests encode that exact scenario at the recorder level (the probe
 * wiring): memoryCount UNCHANGED across a wait-only cycle → IGNORE, while
 * the pre-spec-040 behavior (idle memory written → memoryCount grows) is
 * REACT. No engine or recorder source changes are made or needed (R4.2).
 */
import { describe, it, expect, vi } from 'vitest';
import type {
  GameTick,
  HardTriggerFlags,
  OutcomeSnapshot,
  PPEROrchestratorPort,
  PPERSchedulerConfig,
  ReactGateDecision,
  System1GatePort,
  System1OutcomeProbePort,
  CycleOutcomeSample,
} from '@evol-hive/shared';
import { FEATURE_SCHEMA_VERSION } from '@evol-hive/shared';
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

class FakeOrchestrator implements PPEROrchestratorPort {
  runCycleCalls: string[] = [];
  llmCallCount = 0;

  async runCycle(agentId: string): Promise<void> {
    this.runCycleCalls.push(agentId);
    this.llmCallCount += 1;
  }

  getPhase(_agentId: string) {
    return 'perceive' as const;
  }
}

class ScriptedGate implements System1GatePort {
  decisions: ReactGateDecision[] = [];
  calls: { agentId: string; tickNumber: number; hardTriggers: HardTriggerFlags }[] = [];

  decide(agentId: string, tickNumber: number, hardTriggers: HardTriggerFlags): ReactGateDecision {
    this.calls.push({ agentId, tickNumber, hardTriggers });
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

function makeRecorder() {
  const sink = new RecordingSink();
  const probe = new ScriptedProbe();
  const tracker = new System1AgentTracker();
  const recorder = new System1OutcomeRecorderImpl({
    probe,
    sink: { append: (s) => sink.samples.push(s) },
    tracker,
    featureSource: undefined,
  });
  return { sink, probe, tracker, recorder };
}

function decision(pReact: number, react: boolean): ReactGateDecision {
  return { pReact, react, hardTrigger: false, headVersion: 1, failOpen: false };
}

const DRIVES = { energy: 50, hunger: 50, social: 50, comfort: 50, curiosity: 50 };

/**
 * A wait-only cycle snapshot: same plan (no plan change), wait-only step
 * ids, and a configurable memoryCount (before vs after is where the idle
 * memory would appear — spec 040 suppresses that write, so the count is
 * unchanged).
 */
function waitCycleSnapshot(planId: string, memoryCount: number): OutcomeSnapshot {
  return {
    planId,
    planStepIndex: 1,
    planStepIds: ['wait', 'wait'],
    drives: { ...DRIVES },
    memoryCount,
    conversationTurns: 3,
  };
}

async function runCycle(probe: ScriptedProbe): Promise<CycleOutcomeSample[]> {
  const agents = new AgentManagerImpl();
  agents.spawn(makeAgent('a1'));
  const orch = new FakeOrchestrator();
  const gate = new ScriptedGate();
  gate.decisions = [decision(0.9, true)];
  const { sink, recorder } = (() => {
    const sink = new RecordingSink();
    const tracker = new System1AgentTracker();
    const recorder = new System1OutcomeRecorderImpl({
      probe,
      sink: { append: (s) => sink.samples.push(s) },
      tracker,
      featureSource: undefined,
    });
    return { sink, recorder };
  })();

  const scheduler = new PPERScheduler(
    agents,
    orch,
    { maxConcurrentCycles: 8 } as PPERSchedulerConfig,
    {
      gate,
      outcomeRecorder: recorder,
    },
  );

  scheduler.update(TICK);
  await vi.waitFor(() => expect(sink.samples).toHaveLength(1));
  return sink.samples;
}

describe('Spec 040 — wait-only cycle with suppressed memory labels IGNORE (R4, AC-4)', () => {
  it('memoryCount unchanged + no plan change + no drive delta + no conversation → IGNORE (AC-4)', async () => {
    const probe = new ScriptedProbe();
    // Before/after: same plan, memory count FLAT — cognition suppressed the
    // idle-tick fallback, so the memoryWritten signal never fires.
    probe.snapshots = [waitCycleSnapshot('plan_W', 5), waitCycleSnapshot('plan_W', 5)];
    const samples = await runCycle(probe);

    expect(samples).toHaveLength(1);
    expect(samples[0]!.label).toBe('ignore');
    const outcome = samples[0]!.outcome!;
    expect(outcome.planChanged).toBe(false);
    expect(outcome.memoryWritten).toBe(false);
    expect(outcome.drivesChanged).toBe(false);
  });

  it('the PRE-spec-040 behavior (idle memory written) still labels REACT — the domino this spec breaks', async () => {
    const probe = new ScriptedProbe();
    // Before/after: same plan, but memoryCount grew by one — the idle-tick
    // memory that used to be written unconditionally. This is the exact
    // signal that forced REACT on every cycle before spec 040.
    probe.snapshots = [waitCycleSnapshot('plan_W', 5), waitCycleSnapshot('plan_W', 6)];
    const samples = await runCycle(probe);

    expect(samples).toHaveLength(1);
    expect(samples[0]!.label).toBe('react');
    expect(samples[0]!.outcome!.memoryWritten).toBe(true);
  });

  it('a suppressed wait-only cycle with an existing plan (no plan change) carries schema + head versions', async () => {
    const probe = new ScriptedProbe();
    probe.snapshots = [waitCycleSnapshot('plan_W', 12), waitCycleSnapshot('plan_W', 12)];
    const samples = await runCycle(probe);

    expect(samples[0]!.schemaVersion).toBe(FEATURE_SCHEMA_VERSION);
    expect(samples[0]!.headVersion).toBe(1);
    expect(samples[0]!.label).toBe('ignore');
  });

  it('a wait-only cycle where the LLM wrote an explicit memory still labels REACT (R2.3 end-to-end)', async () => {
    const probe = new ScriptedProbe();
    // Explicit LLM memory on a skipped cycle IS stored (spec 040 R2.3) —
    // memoryCount grows → memoryWritten → REACT. Correct behavior.
    probe.snapshots = [waitCycleSnapshot('plan_W', 5), waitCycleSnapshot('plan_W', 6)];
    const samples = await runCycle(probe);

    expect(samples[0]!.label).toBe('react');
  });
});
