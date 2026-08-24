/**
 * Spec 016 — Cognitive Guardrails (Engine Layer)
 * ===============================================
 * Acceptance Criteria: AC-23, AC-24, AC-26
 *
 * Tests for:
 *   - Engine config loading from env vars (AC-24)
 *   - guardrailsEnabled === false → no guardrail engine (AC-23)
 *   - All individual flags false but guardrailsEnabled true → inactive (AC-26)
 *   - PerceptionDataProviderImpl.getAgentState (AC-25 engine side)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { AgentInternalState } from '@evol-hive/shared';
import { AgentManagerImpl } from '../src/agents/state/index.js';
import { DriveSystemImpl } from '../src/agents/drives/index.js';
import { SmartObjectRegistryImpl } from '../src/world/objects/index.js';
import { SystemFeedbackStore } from '../src/agents/feedback/index.js';
import { PerceptionDataProviderImpl } from '../src/agents/perception/index.js';

// ─── AC-24: Engine config loader ─────────────────────────────────────────────

describe('AC-24: Engine config loader reads guardrail env vars', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('loads guardrail flags from env vars with default true', async () => {
    // Import the loader fresh to ensure env is read at call time.
    delete process.env['ENGINE_GUARDRAILS_AFFORDANCE_MASKING'];
    delete process.env['ENGINE_GUARDRAILS_CONTEXTUAL_FORCING'];
    delete process.env['ENGINE_GUARDRAILS_PLAN_VALIDATION'];
    delete process.env['ENGINE_GUARDRAILS_ENABLED'];

    const { loadEngineConfig } = await import('../../../config/engine.config.js');
    const config = loadEngineConfig();
    expect(config.guardrailsEnabled).toBe(true);
    expect(config.guardrails.affordanceMasking).toBe(true);
    expect(config.guardrails.contextualForcing).toBe(true);
    expect(config.guardrails.planValidation).toBe(true);
  });

  it('reads individual flags from env vars', async () => {
    process.env['ENGINE_GUARDRAILS_AFFORDANCE_MASKING'] = 'false';
    process.env['ENGINE_GUARDRAILS_CONTEXTUAL_FORCING'] = 'false';
    process.env['ENGINE_GUARDRAILS_PLAN_VALIDATION'] = 'false';
    process.env['ENGINE_GUARDRAILS_ENABLED'] = 'true';

    const { loadEngineConfig } = await import('../../../config/engine.config.js');
    const config = loadEngineConfig();
    expect(config.guardrailsEnabled).toBe(true);
    expect(config.guardrails.affordanceMasking).toBe(false);
    expect(config.guardrails.contextualForcing).toBe(false);
    expect(config.guardrails.planValidation).toBe(false);
  });

  it('reads master toggle from ENGINE_GUARDRAILS_ENABLED', async () => {
    process.env['ENGINE_GUARDRAILS_ENABLED'] = 'false';
    delete process.env['ENGINE_GUARDRAILS_AFFORDANCE_MASKING'];

    const { loadEngineConfig } = await import('../../../config/engine.config.js');
    const config = loadEngineConfig();
    expect(config.guardrailsEnabled).toBe(false);
  });

  it('includes existing defaults: fps, spatialDebounceSeconds, maxConcurrentLLM', async () => {
    delete process.env['ENGINE_GUARDRAILS_AFFORDANCE_MASKING'];
    const { loadEngineConfig } = await import('../../../config/engine.config.js');
    const config = loadEngineConfig();
    expect(config.fps).toBe(60);
    expect(config.spatialDebounceSeconds).toBe(5);
    expect(config.maxConcurrentLLM).toBe(8);
  });
});

// ─── AC-23: guardrailsEnabled === false → inactive ───────────────────────────

describe('AC-23: guardrailsEnabled === false disables all guardrails', () => {
  it('loadEngineConfig with guardrailsEnabled=false produces config with guardrailsEnabled false', async () => {
    process.env['ENGINE_GUARDRAILS_ENABLED'] = 'false';
    const { loadEngineConfig } = await import('../../../config/engine.config.js');
    const config = loadEngineConfig();
    expect(config.guardrailsEnabled).toBe(false);
  });
});

// ─── AC-25 (engine side): PerceptionDataProviderImpl.getAgentState ───────────

describe('AC-25: PerceptionDataProviderImpl.getAgentState', () => {
  let agentManager: AgentManagerImpl;
  let provider: PerceptionDataProviderImpl;

  beforeEach(() => {
    agentManager = new AgentManagerImpl();
    agentManager.spawn({
      id: 'a1',
      name: 'a1',
      description: 'test',
      traits: [],
      initialDrives: { energy: 20, hunger: 50, social: 50, comfort: 50, curiosity: 50 },
    });
    agentManager.updateState('a1', { location: 'kitchen' });
    const driveSystem = new DriveSystemImpl(agentManager);
    const registry = new SmartObjectRegistryImpl();
    const feedback = new SystemFeedbackStore();
    provider = new PerceptionDataProviderImpl(agentManager, registry, driveSystem, feedback);
  });

  it('returns AgentInternalState for an existing agent', () => {
    const state = provider.getAgentState('a1');
    expect(state).not.toBeNull();
    expect(state?.agentId).toBe('a1');
    expect(state?.location).toBe('kitchen');
    expect(state?.currentPlan).toBeNull();
  });

  it('returns null for a non-existent agent', () => {
    const state = provider.getAgentState('nonexistent');
    expect(state).toBeNull();
  });
});

// ─── AC-26: all flags false but guardrailsEnabled true ───────────────────────

describe('AC-26: all individual flags false but guardrailsEnabled true', () => {
  it('loadEngineConfig produces all-false guardrail flags when env set to false', async () => {
    process.env['ENGINE_GUARDRAILS_ENABLED'] = 'true';
    process.env['ENGINE_GUARDRAILS_AFFORDANCE_MASKING'] = 'false';
    process.env['ENGINE_GUARDRAILS_CONTEXTUAL_FORCING'] = 'false';
    process.env['ENGINE_GUARDRAILS_PLAN_VALIDATION'] = 'false';
    const { loadEngineConfig } = await import('../../../config/engine.config.js');
    const config = loadEngineConfig();
    expect(config.guardrailsEnabled).toBe(true);
    expect(config.guardrails).toEqual({
      affordanceMasking: false,
      contextualForcing: false,
      planValidation: false,
    });
  });
});

// ─── Spec 019: driveDecayRate env var (AC-8) ────────────────────────────────

describe('AC-8: loadEngineConfig reads ENGINE_DRIVE_DECAY_RATE', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('defaults to 0.1 when ENGINE_DRIVE_DECAY_RATE is unset', async () => {
    delete process.env['ENGINE_DRIVE_DECAY_RATE'];
    const { loadEngineConfig } = await import('../../../config/engine.config.js');
    const config = loadEngineConfig();
    expect(config.driveDecayRate).toBe(0.1);
  });

  it('reads ENGINE_DRIVE_DECAY_RATE=0.5 from env', async () => {
    process.env['ENGINE_DRIVE_DECAY_RATE'] = '0.5';
    const { loadEngineConfig } = await import('../../../config/engine.config.js');
    const config = loadEngineConfig();
    expect(config.driveDecayRate).toBe(0.5);
  });
});
