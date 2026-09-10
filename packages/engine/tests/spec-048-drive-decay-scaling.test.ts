/**
 * Spec 048 — Per-Agent Decay Scaling (Engine Layer) — AC-4
 * ========================================================
 * Deterministic acceptance tests for Req 1 (issue #168): `DriveDecaySystem`
 * applies decay to each agent at an effective rate of `configuredDecayRate / N`
 * (N = live agent count at that tick); no-op at N = 1 (bit-identical to the
 * pre-048 path — `DriveSystemImpl.applyDecay` is untouched, spec-019 contract);
 * `decayScaling: 'none'` keeps the raw rate regardless of N.
 *
 * Coverage:
 *   AC-4a — 3 active agents → each agent decays at decayRate/3 per second.
 *   AC-4b — 1 active agent → decayRate (legacy rate; ratio assertion vs N=3).
 *   AC-4c — 'none' → raw rate regardless of N (2 agents, no division).
 *   AC-4d — N = 1 is BIT-identical to the legacy path (`x / 1 === x` in
 *           IEEE-754 — every drive value compares `toBe` with a twin state
 *           decayed through `DriveSystemImpl.applyDecay` directly).
 *   AC-4e — the divisor is the LIVE agent count per tick (dormant/late-spawned
 *           agents never skew it — spec 048 "What NOT to do").
 *   AC-4f — config surface: `defaultEngineConfig().decayScaling` is
 *           'per-agent'; `defaultDecayScaling()` reads ENGINE_DECAY_SCALING
 *           ('none' → 'none', unset/invalid → 'per-agent').
 *   AC-4g — plumbing: `createEngineCore` resolves EngineConfig.decayScaling
 *           onto the core; the assembled game loop's DriveDecaySystem honors
 *           it (raw rate at 'none' with 2 agents through a real loop tick).
 */
import { describe, it, expect, afterEach } from 'vitest';
import type {
  AgentProfile,
  GameTick,
  PPERCycleOutcome,
  PPEROrchestratorPort,
  PPERPhase,
} from '@evol-hive/shared';
import { defaultDecayScaling, defaultEngineConfig } from '@evol-hive/shared';
import { AgentManagerImpl } from '../src/agents/state/index.js';
import { DriveSystemImpl } from '../src/agents/drives/index.js';
import { DriveDecaySystem } from '../src/systems/drive-decay.js';
import { createEngineCore, assembleGameLoop } from '../src/assembly.js';
import type { EngineCore } from '../src/assembly.js';

/** Explicit rate for clean arithmetic (the default 0.1 is pinned by spec 019). */
const RATE = 0.3;

function makeProfile(id: string, energy: number): AgentProfile {
  return {
    id,
    name: id,
    description: 'test',
    traits: [],
    initialDrives: { energy, hunger: 50, social: 50, comfort: 50, curiosity: 50 },
  };
}

function spawn(agents: AgentManagerImpl, n: number, energy = 50): void {
  for (let i = 0; i < n; i++) agents.spawn(makeProfile(`agent-${i + 1}`, energy));
}

function tickOf(deltaSeconds: number): GameTick {
  return { tickNumber: 1, simulationTime: deltaSeconds, deltaSeconds };
}

/** All five drive values of an agent (stable order). */
function drives(core: AgentManagerImpl, id: string): Record<string, number> {
  return { ...core.getState(id)!.drives };
}

afterEach(() => {
  delete process.env['ENGINE_DECAY_SCALING'];
});

// ─── AC-4a: 3 active agents → decayRate/3 per second ─────────────────────────

describe('AC-4a: per-agent scaling divides the rate by the live agent count', () => {
  it('3 active agents, deltaSeconds = 3, rate 0.3 → each agent loses exactly 0.3 (0.3 × 3 / 3)', () => {
    const agents = new AgentManagerImpl();
    spawn(agents, 3);
    const sys = new DriveDecaySystem(agents, new DriveSystemImpl(agents, RATE));

    sys.update(tickOf(3));

    for (const id of ['agent-1', 'agent-2', 'agent-3']) {
      const d = drives(agents, id);
      // Effective rate = 0.3/3 per second over 3 sim-seconds → −0.3 per drive.
      expect(d.energy).toBeCloseTo(49.7, 10);
      expect(d.hunger).toBeCloseTo(49.7, 10);
      expect(d.social).toBeCloseTo(49.7, 10);
      expect(d.comfort).toBeCloseTo(49.7, 10);
      expect(d.curiosity).toBeCloseTo(49.7, 10);
    }
  });

  it('the N=3 per-tick loss is exactly 1/3 of the N=1 per-tick loss (same rate + delta)', () => {
    const single = new AgentManagerImpl();
    spawn(single, 1);
    const triple = new AgentManagerImpl();
    spawn(triple, 3);
    const one = new DriveDecaySystem(single, new DriveSystemImpl(single, RATE));
    const three = new DriveDecaySystem(triple, new DriveSystemImpl(triple, RATE));

    one.update(tickOf(3));
    three.update(tickOf(3));

    const lossOne = 50 - drives(single, 'agent-1').energy;
    const lossThree = 50 - drives(triple, 'agent-1').energy;
    expect(lossThree).toBeCloseTo(lossOne / 3, 10);
  });
});

// ─── AC-4b: 1 active agent → decayRate (no-op scaling) ───────────────────────

describe('AC-4b: N = 1 decays at the configured rate (scaling is a no-op)', () => {
  it('1 active agent, deltaSeconds = 3, rate 0.3 → loses 0.9 (raw legacy math)', () => {
    const agents = new AgentManagerImpl();
    spawn(agents, 1);
    const sys = new DriveDecaySystem(agents, new DriveSystemImpl(agents, RATE));

    sys.update(tickOf(3));

    expect(drives(agents, 'agent-1').energy).toBeCloseTo(49.1, 10);
  });
});

// ─── AC-4c: 'none' → raw rate regardless of N ────────────────────────────────

describe("AC-4c: decayScaling 'none' keeps the raw rate regardless of N", () => {
  it('3 active agents with scaling none → each agent loses rate × delta (NOT divided)', () => {
    const agents = new AgentManagerImpl();
    spawn(agents, 3);
    const sys = new DriveDecaySystem(agents, new DriveSystemImpl(agents, RATE), {
      decayScaling: 'none',
    });

    sys.update(tickOf(3));

    for (const id of ['agent-1', 'agent-2', 'agent-3']) {
      expect(drives(agents, id).energy).toBeCloseTo(49.1, 10);
    }
  });

  it('omitted options default to per-agent scaling', () => {
    const agents = new AgentManagerImpl();
    spawn(agents, 3);
    const sys = new DriveDecaySystem(agents, new DriveSystemImpl(agents, RATE));

    sys.update(tickOf(3));

    // Divided by 3 → 49.7, not the raw 49.1.
    expect(drives(agents, 'agent-1').energy).toBeCloseTo(49.7, 10);
  });
});

// ─── AC-4d: N = 1 is bit-identical to the pre-048 path ───────────────────────

describe('AC-4d: N = 1 is bit-identical to the legacy DriveSystemImpl path', () => {
  it('every drive of the scaled system equals the legacy applyDecay result exactly (toBe)', () => {
    const agents = new AgentManagerImpl();
    spawn(agents, 1, 73.5); // non-round start value to surface FP divergence
    const driveSystem = new DriveSystemImpl(agents, RATE);
    const sys = new DriveDecaySystem(agents, driveSystem);

    // Legacy twin: the pre-048 DriveDecaySystem called applyDecay(agent, delta)
    // per agent with the raw delta.
    const legacy = new AgentManagerImpl();
    spawn(legacy, 1, 73.5);
    const legacyDriveSystem = new DriveSystemImpl(legacy, RATE);

    const DELTA = 0.97; // awkward FP delta
    sys.update(tickOf(DELTA));
    legacyDriveSystem.applyDecay(legacy.getState('agent-1')!, DELTA);

    const scaled = drives(agents, 'agent-1');
    const reference = drives(legacy, 'agent-1');
    for (const key of Object.keys(scaled)) {
      // `toBe` = Object.is — bit-identical, not just close (AC-4 wording).
      expect(scaled[key]).toBe(reference[key]);
    }
  });
});

// ─── AC-4e: the divisor is the LIVE count at each tick ───────────────────────

describe('AC-4e: the divisor tracks the live agent count per tick', () => {
  it('a late-spawned agent raises N on the NEXT tick only (live count, not a cached one)', () => {
    const agents = new AgentManagerImpl();
    spawn(agents, 2);
    const sys = new DriveDecaySystem(agents, new DriveSystemImpl(agents, RATE));

    // Tick 1 with 2 agents: rate/2 per second.
    sys.update({ tickNumber: 1, simulationTime: 2, deltaSeconds: 2 });
    expect(drives(agents, 'agent-1').energy).toBeCloseTo(50 - (RATE * 2) / 2, 10);

    // A third agent spawns; tick 2 divides by 3.
    agents.spawn(makeProfile('agent-3', 50));
    sys.update({ tickNumber: 2, simulationTime: 5, deltaSeconds: 3 });
    expect(drives(agents, 'agent-1').energy).toBeCloseTo(50 - (RATE * 2) / 2 - (RATE * 3) / 3, 10);

    // Despawn back to 2: tick 3 divides by 2 again (dormant agents excluded —
    // getActiveAgents(), spec 048 "What NOT to do": never maxConcurrentCycles).
    agents.despawn('agent-3');
    sys.update({ tickNumber: 3, simulationTime: 7, deltaSeconds: 2 });
    expect(drives(agents, 'agent-1').energy).toBeCloseTo(
      50 - (RATE * 2) / 2 - (RATE * 3) / 3 - (RATE * 2) / 2,
      10,
    );
  });
});

// ─── AC-4f: config surface (EngineConfig field + env) ────────────────────────

describe('AC-4f: EngineConfig.decayScaling surfaced from ENGINE_DECAY_SCALING', () => {
  it('defaultEngineConfig() defaults to per-agent', () => {
    delete process.env['ENGINE_DECAY_SCALING'];
    expect(defaultEngineConfig().decayScaling).toBe('per-agent');
  });

  it("ENGINE_DECAY_SCALING='none' → 'none'", () => {
    process.env['ENGINE_DECAY_SCALING'] = 'none';
    expect(defaultDecayScaling()).toBe('none');
  });

  it('ENGINE_DECAY_SCALING unset or invalid → per-agent (typos cannot disable scaling)', () => {
    delete process.env['ENGINE_DECAY_SCALING'];
    expect(defaultDecayScaling()).toBe('per-agent');
    process.env['ENGINE_DECAY_SCALING'] = 'per_agent'; // invalid spelling
    expect(defaultDecayScaling()).toBe('per-agent');
  });
});

// ─── AC-4g: createEngineCore/assembleGameLoop plumbing ───────────────────────

class NoopOrchestrator implements PPEROrchestratorPort {
  async runCycle(): Promise<PPERCycleOutcome> {
    return { appliedDriveChanges: false };
  }
  getPhase(): PPERPhase {
    return 'perceive';
  }
}

describe('AC-4g: decayScaling plumbs through createEngineCore → assembleGameLoop', () => {
  it('createEngineCore resolves EngineConfig.decayScaling onto the core', () => {
    const core = createEngineCore({
      fps: 60,
      spatialDebounceSeconds: 5,
      maxConcurrentLLM: 8,
      guardrailsEnabled: true,
      guardrails: { affordanceMasking: true, contextualForcing: true, planValidation: true },
      decayScaling: 'none',
    });
    expect(core.decayScaling).toBe('none');
  });

  it('createEngineCore without the field → per-agent default on the core', () => {
    const core = createEngineCore({
      fps: 60,
      spatialDebounceSeconds: 5,
      maxConcurrentLLM: 8,
      guardrailsEnabled: true,
      guardrails: { affordanceMasking: true, contextualForcing: true, planValidation: true },
    });
    expect(core.decayScaling).toBe('per-agent');
  });

  it("the assembled loop's DriveDecaySystem honors 'none' — 2 agents decay at the RAW rate through a real tick", () => {
    const core: EngineCore = createEngineCore({
      fps: 60,
      spatialDebounceSeconds: 5,
      maxConcurrentLLM: 8,
      guardrailsEnabled: true,
      guardrails: { affordanceMasking: true, contextualForcing: true, planValidation: true },
      decayScaling: 'none',
    });
    spawn(core.agentManager, 2, 100);
    assembleGameLoop(core, new NoopOrchestrator());
    expect(core.gameLoop.systemNames()).toContain('drive-decay');

    // 3 sim-seconds of loop time: 60 FPS × deltaSeconds 1/60. 'none' → each
    // agent loses 0.3 at rate 0.1 (raw), NOT 0.15 (the per-agent half).
    core.gameLoop.injectElapsed(3);
    expect(core.agentManager.getState('agent-1')!.drives.energy).toBeCloseTo(99.7, 6);
    expect(core.agentManager.getState('agent-2')!.drives.energy).toBeCloseTo(99.7, 6);
  });

  it("the assembled loop's DriveDecaySystem defaults to per-agent — 2 agents decay at rate/2", () => {
    const core: EngineCore = createEngineCore({
      fps: 60,
      spatialDebounceSeconds: 5,
      maxConcurrentLLM: 8,
      guardrailsEnabled: true,
      guardrails: { affordanceMasking: true, contextualForcing: true, planValidation: true },
    });
    spawn(core.agentManager, 2, 100);
    assembleGameLoop(core, new NoopOrchestrator());

    core.gameLoop.injectElapsed(3);
    // Per-agent scaling: 0.1 × 3 / 2 = 0.15 per agent.
    expect(core.agentManager.getState('agent-1')!.drives.energy).toBeCloseTo(99.85, 6);
  });
});
