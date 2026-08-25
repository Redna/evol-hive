/**
 * Spec 019 — Configurable Drive Decay Rate (Engine Layer)
 * ========================================================
 * Acceptance Criteria: AC-3, AC-4, AC-5, AC-6, AC-10, AC-11, AC-12
 *
 * Tests for:
 *   - DriveSystemImpl accepts optional decayRate constructor param (AC-3)
 *   - applyDecay() multiplies deltaSeconds by decayRate (AC-4)
 *   - Default decayRate is 0.1 when omitted (AC-5)
 *   - createEngineCore wires driveDecayRate from EngineConfig (AC-6)
 *   - DriveSystem interface signature unchanged (AC-12)
 *   - 20-second pure-decay simulation at 0.1/sec leaves energy ≈ 18 (AC-11)
 */
import { describe, it, expect } from 'vitest';
import type { AgentInternalState } from '@evol-hive/shared';
import { DriveSystemImpl } from '../src/agents/drives/index.js';
import { createEngineCore } from '../src/assembly.js';
import type { DriveSystem } from '../src/index.js';

function makeAgent(energy: number): AgentInternalState {
  return {
    agentId: 'a1',
    drives: { energy, hunger: 50, social: 50, comfort: 50, curiosity: 50 },
    currentGoal: 'stay alive',
    currentPlan: null,
    isThinking: false,
    location: 'kitchen',
    lastPerceptionTick: 0,
  };
}

function makeConfig(
  overrides: Partial<{
    fps: number;
    spatialDebounceSeconds: number;
    maxConcurrentLLM: number;
    guardrailsEnabled: boolean;
  }> = {},
) {
  return {
    fps: 60,
    spatialDebounceSeconds: 5,
    maxConcurrentLLM: 8,
    guardrailsEnabled: true,
    guardrails: { affordanceMasking: true, contextualForcing: true, planValidation: true },
    ...overrides,
  };
}

// ─── AC-3 / AC-4: DriveSystemImpl uses decayRate in applyDecay() ─────────────

describe('AC-4: DriveSystemImpl.applyDecay multiplies by decayRate', () => {
  it('decayRate = 0.1, deltaSeconds = 10, energy 50 → 49', () => {
    const ds = new DriveSystemImpl(undefined, 0.1);
    const state = makeAgent(50);
    ds.applyDecay(state, 10);
    expect(state.drives.energy).toBe(49);
  });

  it('decayRate = 0.5, deltaSeconds = 10, energy 50 → 45', () => {
    const ds = new DriveSystemImpl(undefined, 0.5);
    const state = makeAgent(50);
    ds.applyDecay(state, 10);
    expect(state.drives.energy).toBe(45);
  });

  it('clamps to [0, 100] — large decay does not go negative', () => {
    const ds = new DriveSystemImpl(undefined, 1.0);
    const state = makeAgent(5);
    ds.applyDecay(state, 100);
    expect(state.drives.energy).toBe(0);
  });
});

// ─── AC-5: default decayRate is 0.1 when omitted ─────────────────────────────

describe('AC-5: DriveSystemImpl defaults decayRate to 0.1', () => {
  it('no decayRate arg → applyDecay uses 0.1', () => {
    const ds = new DriveSystemImpl();
    const state = makeAgent(50);
    ds.applyDecay(state, 10);
    expect(state.drives.energy).toBe(49);
  });

  it('only agentManager arg → applyDecay uses 0.1', () => {
    const ds = new DriveSystemImpl(undefined);
    const state = makeAgent(50);
    ds.applyDecay(state, 10);
    expect(state.drives.energy).toBe(49);
  });
});

// ─── AC-6: createEngineCore wires driveDecayRate from config ─────────────────

describe('AC-6: createEngineCore wires driveDecayRate from config', () => {
  it('driveDecayRate = 0.2 → applyDecay yields 48', () => {
    const core = createEngineCore({ ...makeConfig(), driveDecayRate: 0.2 });
    const state = makeAgent(50);
    core.driveSystem.applyDecay(state, 10);
    expect(state.drives.energy).toBe(48);
  });

  it('driveDecayRate omitted → default 0.1, applyDecay yields 49', () => {
    const core = createEngineCore(makeConfig());
    const state = makeAgent(50);
    core.driveSystem.applyDecay(state, 10);
    expect(state.drives.energy).toBe(49);
  });
});

// ─── AC-12: DriveSystem interface signature unchanged ────────────────────────

describe('AC-12: DriveSystem interface signature unchanged', () => {
  it('applyDecay(state, deltaSeconds) — two params, no decayRate param', () => {
    const ds: DriveSystem = new DriveSystemImpl(undefined, 0.3);
    const state = makeAgent(50);
    // Interface method takes exactly (state, deltaSeconds).
    ds.applyDecay(state, 10);
    expect(state.drives.energy).toBe(47);
  });
});

// ─── AC-11: 20-second pure decay at 0.1/sec leaves energy ≈ 18 ───────────────

describe('AC-11: 20s pure decay at decayRate=0.1 leaves energy ≈ 18', () => {
  it('simulates 20 seconds at 60 FPS with no actions', () => {
    const ds = new DriveSystemImpl(undefined, 0.1);
    const state = makeAgent(20);
    const fps = 60;
    const deltaSeconds = 1 / fps;
    const totalSeconds = 20;
    const ticks = totalSeconds * fps;
    for (let i = 0; i < ticks; i++) {
      ds.applyDecay(state, deltaSeconds);
    }
    // 20 - 20 * 0.1 = 18 (floating point may drift slightly).
    expect(state.drives.energy).toBeCloseTo(18, 5);
    // The key assertion: NOT 0 — agent has time to act.
    expect(state.drives.energy).toBeGreaterThan(17);
  });
});
