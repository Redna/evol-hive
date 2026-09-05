/**
 * Spec 035 — Scheduler gating + outcome labeling (Req 5, 7, 8, 9 / AC-3, AC-4).
 * AC-3 (mock orchestrator): p(react) < threshold & no hard trigger → no cycle;
 * p(react) ≥ threshold → cycle; each hard trigger forces a cycle at p = 0; an
 * idled tick performs no associative injection; gating adds zero LLM calls.
 * AC-4: a plan-changing cycle writes a REACT sample; a no-op cycle writes an
 * IGNORE sample; hard-trigger samples are always REACT; samples carry schema
 * + head versions.
 */
import { describe, it, expect, vi } from 'vitest';
import type {
  GameTick,
  HardTriggerFlags,
  PPEROrchestratorPort,
  PPERSchedulerConfig,
  ReactGateDecision,
  System1GatePort,
  System1OutcomeProbePort,
  OutcomeSnapshot,
  CycleOutcomeSample,
} from '@evol-hive/shared';
import { FEATURE_SCHEMA_VERSION } from '@evol-hive/shared';
import { AgentManagerImpl, PlanManagerImpl } from '../src/agents/index.js';
import { PPERScheduler } from '../src/systems/pper-scheduler.js';
import {
  System1OutcomeRecorderImpl,
  System1AgentTracker,
} from '../src/systems/index.js';
const TICK: GameTick = { tickNumber: 1, simulationTime: 0.0167, deltaSeconds: 0.0167 };

function makeAgent(id = 'a1', energy = 50) {
  return {
    id,
    name: id,
    description: 'test',
    traits: [],
    initialDrives: { energy, hunger: 50, social: 50, comfort: 50, curiosity: 50 },
  };
}

class FakeOrchestrator implements PPEROrchestratorPort {
  runCycleCalls: string[] = [];
  llmCallCount = 0;

  async runCycle(agentId: string): Promise<void> {
    this.runCycleCalls.push(agentId);
    // Stand-in for the LLM-driven cycle: every cycle costs one "LLM call".
    this.llmCallCount += 1;
  }

  getPhase(_agentId: string) {
    return 'perceive' as const;
  }
}

/** Scripted gate: returns the next decision per call (or a fixed one). */
class ScriptedGate implements System1GatePort {
  decisions: ReactGateDecision[] = [];
  calls: { agentId: string; hardTriggers: HardTriggerFlags }[] = [];

  decide(agentId: string, hardTriggers: HardTriggerFlags): ReactGateDecision {
    this.calls.push({ agentId, hardTriggers });
    const next = this.decisions.shift();
    if (next) return next;
    return {
      pReact: 0,
      react: false,
      hardTrigger: false,
      headVersion: 1,
      failOpen: false,
    };
  }
}

function decision(pReact: number, react: boolean, hardTrigger = false): ReactGateDecision {
  return { pReact, react, hardTrigger, headVersion: 1, failOpen: false };
}

const NO_TRIGGERS: HardTriggerFlags = {
  messagePending: false,
  conversationInvite: false,
  nearbyObjectMutation: false,
  driveThresholdCrossing: false,
};

function oneTrigger(flag: keyof HardTriggerFlags): HardTriggerFlags {
  return { ...NO_TRIGGERS, [flag]: true };
}

/** In-memory sample sink. */
class RecordingSink {
  readonly samples: CycleOutcomeSample[] = [];
  append(sample: CycleOutcomeSample): void {
    this.samples.push(sample);
  }
}

/** Scriptable outcome probe: before/after snapshots queued per snapshot call. */
class ScriptedProbe implements System1OutcomeProbePort {
  snapshots: OutcomeSnapshot[] = [];
  async snapshot(_agentId: string): Promise<OutcomeSnapshot> {
    return this.snapshots.shift() ?? {
      planId: null,
      planStepIndex: 0,
      drives: { energy: 50, hunger: 50, social: 50, comfort: 50, curiosity: 50 },
      memoryCount: 0,
      conversationTurns: 0,
    };
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

/** A recorder harness wiring the real System1OutcomeRecorderImpl with scripted probe + sink. */
function makeRecorder() {
  const sink = new RecordingSink();
  const probe = new ScriptedProbe();
  const tracker = new System1AgentTracker();
  const recorder = new System1OutcomeRecorderImpl({
    probe,
    sink: { append: (s) => sink.samples.push(s) },
    tracker,
    /** No feature source wired in this harness → features are optional. */
    featureSource: undefined,
  });
  return { sink, probe, tracker, recorder };
}

describe('Spec 035 — gate before cycle (Req 7 / AC-3)', () => {
  it('p(react) < threshold and no hard trigger → no cycle starts', () => {
    const agents = new AgentManagerImpl();
    agents.spawn(makeAgent('a1'));
    const orch = new FakeOrchestrator();
    const gate = new ScriptedGate();
    gate.decisions = [decision(0.2, false)];
    const scheduler = new PPERScheduler(agents, orch, { maxConcurrentCycles: 8 } as PPERSchedulerConfig, {
      gate,
    });

    scheduler.update(TICK);
    expect(orch.runCycleCalls).toHaveLength(0);
    expect(gate.calls).toHaveLength(1);
    expect(gate.calls[0]!.agentId).toBe('a1');
  });

  it('p(react) ≥ threshold → a cycle starts', () => {
    const agents = new AgentManagerImpl();
    agents.spawn(makeAgent('a1'));
    const orch = new FakeOrchestrator();
    const gate = new ScriptedGate();
    gate.decisions = [decision(0.9, true)];
    const scheduler = new PPERScheduler(agents, orch, { maxConcurrentCycles: 8 } as PPERSchedulerConfig, {
      gate,
    });

    scheduler.update(TICK);
    expect(orch.runCycleCalls).toEqual(['a1']);
  });

  it('each hard trigger forces a cycle even at p(react) = 0 (Req 5)', () => {
    for (const flag of [
      'messagePending',
      'conversationInvite',
      'nearbyObjectMutation',
      'driveThresholdCrossing',
    ] as const) {
      const agents = new AgentManagerImpl();
      agents.spawn(makeAgent('a1'));
      const orch = new FakeOrchestrator();
      const gate = new ScriptedGate();
      gate.decisions = [decision(0, false, true)]; // p = 0, but hard trigger
      const scheduler = new PPERScheduler(
        agents,
        orch,
        { maxConcurrentCycles: 8 } as PPERSchedulerConfig,
        {
          gate,
          triggerSource: { getHardTriggers: () => oneTrigger(flag) },
        },
      );

      scheduler.update(TICK);
      expect(orch.runCycleCalls, `trigger ${flag} must force a cycle`).toEqual(['a1']);
    }
  });

  it('the scheduler forwards engine-state hard triggers to the gate', () => {
    const agents = new AgentManagerImpl();
    agents.spawn(makeAgent('a1'));
    const orch = new FakeOrchestrator();
    const gate = new ScriptedGate();
    const scheduler = new PPERScheduler(agents, orch, { maxConcurrentCycles: 8 } as PPERSchedulerConfig, {
      gate,
      triggerSource: { getHardTriggers: () => oneTrigger('messagePending') },
    });

    scheduler.update(TICK);
    expect(gate.calls[0]!.hardTriggers).toEqual(oneTrigger('messagePending'));
  });

  it('an idled agent is retried on the next tick (gate consulted again, not skipped forever)', () => {
    const agents = new AgentManagerImpl();
    agents.spawn(makeAgent('a1'));
    const orch = new FakeOrchestrator();
    const gate = new ScriptedGate();
    gate.decisions = [decision(0.1, false), decision(0.8, true)];
    const scheduler = new PPERScheduler(agents, orch, { maxConcurrentCycles: 8 } as PPERSchedulerConfig, {
      gate,
    });

    scheduler.update(TICK);
    expect(orch.runCycleCalls).toHaveLength(0);
    scheduler.update({ ...TICK, tickNumber: 2 });
    expect(orch.runCycleCalls).toEqual(['a1']);
  });

  it('without a gate, behavior is unchanged (every idle agent cycles — back-compat)', () => {
    const agents = new AgentManagerImpl();
    agents.spawn(makeAgent('a1'));
    const orch = new FakeOrchestrator();
    const scheduler = new PPERScheduler(agents, orch, { maxConcurrentCycles: 8 });

    scheduler.update(TICK);
    expect(orch.runCycleCalls).toEqual(['a1']);
  });
});

describe('Spec 035 — associative injection gating (Req 8 / AC-3)', () => {
  it('an idled tick performs no associative injection (no cycle → no injection path)', () => {
    const agents = new AgentManagerImpl();
    agents.spawn(makeAgent('a1'));
    const orch = new FakeOrchestrator();
    const gate = new ScriptedGate();
    gate.decisions = [decision(0.1, false)];
    const scheduler = new PPERScheduler(agents, orch, { maxConcurrentCycles: 8 } as PPERSchedulerConfig, {
      gate,
    });

    scheduler.update(TICK);
    // The orchestrator (and therefore the Perceive phase and its associative
    // injection) never ran on the idled tick.
    expect(orch.runCycleCalls).toHaveLength(0);
  });
});

describe('Spec 035 — gating adds zero LLM calls (AC-3)', () => {
  it('the mock LLM call counter is unchanged by gate evaluation across many ticks', () => {
    const agents = new AgentManagerImpl();
    agents.spawn(makeAgent('a1'));
    agents.spawn(makeAgent('a2'));
    const orch = new FakeOrchestrator();
    const gate = new ScriptedGate();
    // Gate idles everything for 50 ticks.
    const scheduler = new PPERScheduler(agents, orch, { maxConcurrentCycles: 8 } as PPERSchedulerConfig, {
      gate,
    });

    const before = orch.llmCallCount;
    for (let i = 0; i < 50; i++) {
      scheduler.update({ ...TICK, tickNumber: i + 1 });
    }
    expect(orch.llmCallCount).toBe(before); // 0 — no LLM calls from gating
    expect(gate.calls.length).toBeGreaterThan(0); // but the gate ran every tick
  });
});

describe('Spec 035 — outcome labeling (Req 9 / AC-4)', () => {
  it('a scripted cycle that changes the plan writes a REACT-labeled sample', async () => {
    const agents = new AgentManagerImpl();
    agents.spawn(makeAgent('a1'));
    const orch = new FakeOrchestrator();
    const gate = new ScriptedGate();
    gate.decisions = [decision(0.9, true)];
    const { sink, probe, recorder } = makeRecorder();

    const scheduler = new PPERScheduler(agents, orch, { maxConcurrentCycles: 8 } as PPERSchedulerConfig, {
      gate,
      outcomeRecorder: recorder,
    });

    // Before: plan X. After: plan Y (the cycle changed the plan).
    probe.snapshots = [baseSnapshot('plan_X'), baseSnapshot('plan_Y')];
    scheduler.update(TICK);
    await vi.waitFor(() => expect(sink.samples).toHaveLength(1));
    expect(sink.samples[0]!.label).toBe('react');
    expect(sink.samples[0]!.outcome!.planChanged).toBe(true);
  });

  it('a no-op cycle writes an IGNORE-labeled sample', async () => {
    const agents = new AgentManagerImpl();
    agents.spawn(makeAgent('a1'));
    const orch = new FakeOrchestrator();
    const gate = new ScriptedGate();
    gate.decisions = [decision(0.9, true)];
    const { sink, probe, recorder } = makeRecorder();

    const scheduler = new PPERScheduler(agents, orch, { maxConcurrentCycles: 8 } as PPERSchedulerConfig, {
      gate,
      outcomeRecorder: recorder,
    });

    // Nothing changed before → after.
    probe.snapshots = [baseSnapshot(null), baseSnapshot(null)];
    scheduler.update(TICK);
    await vi.waitFor(() => expect(sink.samples).toHaveLength(1));
    expect(sink.samples[0]!.label).toBe('ignore');
  });

  it('drive-delta outcomes label REACT even without a plan change', async () => {
    const agents = new AgentManagerImpl();
    agents.spawn(makeAgent('a1'));
    const orch = new FakeOrchestrator();
    const gate = new ScriptedGate();
    gate.decisions = [decision(0.9, true)];
    const { sink, probe, recorder } = makeRecorder();

    const scheduler = new PPERScheduler(agents, orch, { maxConcurrentCycles: 8 } as PPERSchedulerConfig, {
      gate,
      outcomeRecorder: recorder,
    });

    const before = baseSnapshot(null);
    const afterDrives = baseSnapshot(null);
    afterDrives.drives = { energy: 62, hunger: 50, social: 50, comfort: 50, curiosity: 50 };
    probe.snapshots = [before, afterDrives];
    scheduler.update(TICK);
    await vi.waitFor(() => expect(sink.samples).toHaveLength(1));
    expect(sink.samples[0]!.label).toBe('react');
    expect(sink.samples[0]!.outcome!.drivesChanged).toBe(true);
  });

  it('hard-trigger samples are always labeled REACT (Req 9)', async () => {
    const agents = new AgentManagerImpl();
    agents.spawn(makeAgent('a1'));
    const orch = new FakeOrchestrator();
    const gate = new ScriptedGate();
    gate.decisions = [decision(0, false, true)];
    const { sink, probe, recorder } = makeRecorder();

    const scheduler = new PPERScheduler(
      agents,
      orch,
      { maxConcurrentCycles: 8 } as PPERSchedulerConfig,
      {
        gate,
        triggerSource: { getHardTriggers: () => oneTrigger('messagePending') },
        outcomeRecorder: recorder,
      },
    );

    probe.snapshots = [baseSnapshot(null), baseSnapshot(null)]; // nothing changed
    scheduler.update(TICK);
    await vi.waitFor(() => expect(sink.samples).toHaveLength(1));
    expect(sink.samples[0]!.label).toBe('react'); // despite no-op outcome
    expect(sink.samples[0]!.hardTrigger).toBe(true);
  });

  it('samples in the log carry schema + head versions and the decision p', async () => {
    const agents = new AgentManagerImpl();
    agents.spawn(makeAgent('a1'));
    const orch = new FakeOrchestrator();
    const gate = new ScriptedGate();
    gate.decisions = [{ pReact: 0.77, react: true, hardTrigger: false, headVersion: 11, failOpen: false }];
    const { sink, probe, recorder } = makeRecorder();

    const scheduler = new PPERScheduler(agents, orch, { maxConcurrentCycles: 8 } as PPERSchedulerConfig, {
      gate,
      outcomeRecorder: recorder,
    });

    probe.snapshots = [baseSnapshot('plan_X'), baseSnapshot('plan_Y')];
    scheduler.update(TICK);
    await vi.waitFor(() => expect(sink.samples).toHaveLength(1));
    const sample = sink.samples[0]!;
    expect(sample.schemaVersion).toBe(FEATURE_SCHEMA_VERSION);
    expect(sample.headVersion).toBe(11);
    expect(sample.pReact).toBeCloseTo(0.77, 12);
    expect(sample.agentId).toBe('a1');
   expect(sample.tickNumber).toBe(TICK.tickNumber);
  });

  it('idled ticks write no samples (only completed cycles are labeled)', async () => {
    const agents = new AgentManagerImpl();
    agents.spawn(makeAgent('a1'));
    const orch = new FakeOrchestrator();
    const gate = new ScriptedGate();
    gate.decisions = [decision(0.1, false)];
    const { sink, recorder } = makeRecorder();

    const scheduler = new PPERScheduler(agents, orch, { maxConcurrentCycles: 8 } as PPERSchedulerConfig, {
      gate,
      outcomeRecorder: recorder,
    });

    scheduler.update(TICK);
    await new Promise((r) => setTimeout(r, 5));
    expect(sink.samples).toHaveLength(0);
  });

  it('a completed cycle marks the tracker: ticks-since-cycle resets (scheduler integration)', async () => {
    const agents = new AgentManagerImpl();
    agents.spawn(makeAgent('a1'));
    const orch = new FakeOrchestrator();
    const gate = new ScriptedGate();
    gate.decisions = [decision(0.9, true)];
    const { probe, tracker, recorder } = makeRecorder();

    const scheduler = new PPERScheduler(agents, orch, { maxConcurrentCycles: 8 } as PPERSchedulerConfig, {
      gate,
      outcomeRecorder: recorder,
    });

    probe.snapshots = [baseSnapshot(null), baseSnapshot(null)];
    scheduler.update(TICK);
    await vi.waitFor(() => expect(tracker.getTicksSinceLastCycle('a1')).toBe(0));
    // On the following tick, the counter increments from the settled cycle.
    scheduler.update({ ...TICK, tickNumber: 2 });
    expect(tracker.getTicksSinceLastCycle('a1')).toBe(1);
    expect(tracker.getDrivesAtLastCycle('a1')).toEqual({
      energy: 50, hunger: 50, social: 50, comfort: 50, curiosity: 50,
    });
  });
});

describe('Spec 035 — recorder carries features when a feature source is wired (Req 9)', () => {
  it('the sample includes the cached feature vector for training', async () => {
    const agents = new AgentManagerImpl();
    agents.spawn(makeAgent('a1'));
    const orch = new FakeOrchestrator();
    const gate = new ScriptedGate();
    gate.decisions = [decision(0.9, true)];
    const { sink, probe } = makeRecorder();

    const features = {
      schemaVersion: FEATURE_SCHEMA_VERSION,
      embedding: [0.1, 0.2, 0.3],
      scalar: {
        driveEnergy: 0.5, driveHunger: 0.5, driveSocial: 0.5, driveComfort: 0.5, driveCuriosity: 0.5,
        deltaEnergy: 0, deltaHunger: 0, deltaSocial: 0, deltaComfort: 0, deltaCuriosity: 0,
        novelty: 0.9, messagePending: 0, conversationOpen: 0, conversationTurns: 0,
        nearbyObjectStateChange: 0, worldMutation: 0, driveThresholdCrossing: 0,
        ticksSinceLastCycle: 0.5,
      },
    };

    const tracker = new System1AgentTracker();
    const recorder = new System1OutcomeRecorderImpl({
      probe,
      sink: { append: (s) => sink.samples.push(s) },
      tracker,
      featureSource: { getFeatures: () => features },
    });

    const scheduler = new PPERScheduler(agents, orch, { maxConcurrentCycles: 8 } as PPERSchedulerConfig, {
      gate,
      outcomeRecorder: recorder,
    });

    probe.snapshots = [baseSnapshot('plan_X'), baseSnapshot('plan_Y')];
    scheduler.update(TICK);
    await vi.waitFor(() => expect(sink.samples).toHaveLength(1));
    expect(sink.samples[0]!.scalar).toEqual(features.scalar);
    expect(sink.samples[0]!.embedding).toEqual([0.1, 0.2, 0.3]);
  });
});