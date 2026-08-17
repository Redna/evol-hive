/**
 * Spec 016 — Cognitive Guardrails (Shared Layer)
 * ==============================================
 * Acceptance Criteria: AC-1, AC-2, AC-3, AC-4, AC-5, AC-6, AC-25
 *
 * Tests for the shared-layer types and constants introduced by spec 016:
 *   - GuardrailConfig on EngineConfig
 *   - defaultGuardrailConfig() / defaultEngineConfig()
 *   - PlanValidationResult type
 *   - GUARDRAIL_FORCING_DIRECTIVE / GUARDRAIL_DEVIATION_FEEDBACK_TEMPLATE
 *   - PerceptionDataProvider.getAgentState optional method
 *   - ExecuteResult.deviationRejected optional field
 */
import { describe, it, expect } from 'vitest';
import {
  defaultGuardrailConfig,
  defaultEngineConfig,
  GUARDRAIL_FORCING_DIRECTIVE,
  GUARDRAIL_DEVIATION_FEEDBACK_TEMPLATE,
  type EngineConfig,
  type GuardrailConfig,
  type PlanValidationResult,
  type ExecuteResult,
  type PerceptionDataProvider,
  type AgentInternalState,
} from '../src/index.js';

// ─── AC-1: defaultGuardrailConfig ────────────────────────────────────────────

describe('AC-1: defaultGuardrailConfig()', () => {
  it('returns { affordanceMasking: true, contextualForcing: true, planValidation: true }', () => {
    const config = defaultGuardrailConfig();
    expect(config).toEqual({
      affordanceMasking: true,
      contextualForcing: true,
      planValidation: true,
    });
  });
});

// ─── AC-2: defaultEngineConfig ───────────────────────────────────────────────

describe('AC-2: defaultEngineConfig()', () => {
  it('returns an EngineConfig with guardrailsEnabled: true and guardrails: defaultGuardrailConfig()', () => {
    const config = defaultEngineConfig();
    expect(config.guardrailsEnabled).toBe(true);
    expect(config.guardrails).toEqual(defaultGuardrailConfig());
  });

  it('includes existing defaults: fps=60, spatialDebounceSeconds=5, maxConcurrentLLM=8', () => {
    const config = defaultEngineConfig();
    expect(config.fps).toBe(60);
    expect(config.spatialDebounceSeconds).toBe(5);
    expect(config.maxConcurrentLLM).toBe(8);
  });
});

// ─── AC-3: EngineConfig includes guardrails field ───────────────────────────

describe('AC-3: EngineConfig interface includes guardrails: GuardrailConfig', () => {
  it('a full EngineConfig with guardrails is assignable', () => {
    const config: EngineConfig = {
      fps: 60,
      spatialDebounceSeconds: 5,
      maxConcurrentLLM: 8,
      guardrailsEnabled: true,
      guardrails: { affordanceMasking: true, contextualForcing: true, planValidation: true },
    };
    expect(config.guardrails).toBeDefined();
    expect(config.guardrails.affordanceMasking).toBe(true);
  });

  it('GuardrailConfig type has the three boolean fields', () => {
    const gc: GuardrailConfig = {
      affordanceMasking: false,
      contextualForcing: false,
      planValidation: false,
    };
    expect(typeof gc.affordanceMasking).toBe('boolean');
    expect(typeof gc.contextualForcing).toBe('boolean');
    expect(typeof gc.planValidation).toBe('boolean');
  });
});

// ─── AC-4: PlanValidationResult type ─────────────────────────────────────────

describe('AC-4: PlanValidationResult type', () => {
  it('is exported and matches { valid: boolean; reason?: string }', () => {
    const ok: PlanValidationResult = { valid: true };
    const bad: PlanValidationResult = { valid: false, reason: 'deviation' };
    expect(ok.valid).toBe(true);
    expect(ok.reason).toBeUndefined();
    expect(bad.valid).toBe(false);
    expect(bad.reason).toBe('deviation');
  });
});

// ─── AC-5: GUARDRAIL_FORCING_DIRECTIVE ───────────────────────────────────────

describe('AC-5: GUARDRAIL_FORCING_DIRECTIVE constant', () => {
  it('equals the spec string', () => {
    expect(GUARDRAIL_FORCING_DIRECTIVE).toBe(
      'You have no active plan. You must use formulate_plan to create a plan before taking any physical action.',
    );
  });
});

// ─── AC-6: GUARDRAIL_DEVIATION_FEEDBACK_TEMPLATE ─────────────────────────────

describe('AC-6: GUARDRAIL_DEVIATION_FEEDBACK_TEMPLATE constant', () => {
  it('equals the spec string with {action} placeholder', () => {
    expect(GUARDRAIL_DEVIATION_FEEDBACK_TEMPLATE).toBe(
      "Action '{action}' deviates from your plan. Use reflect to reconsider.",
    );
  });
});

// ─── AC-25: PerceptionDataProvider.getAgentState optional method ─────────────

describe('AC-25: PerceptionDataProvider interface includes optional getAgentState', () => {
  it('a provider without getAgentState is still valid (optional)', () => {
    const provider: PerceptionDataProvider = {
      getAgentLocation: () => 'kitchen',
      getObjectsInRoom: () => [],
      getAffordancesInRoom: () => [],
      getAgentDrives: () => ({ energy: 50 }),
      getPrimaryDriveLabel: () => 'low energy',
      getSystemFeedback: () => undefined,
    };
    expect(typeof provider.getAgentLocation).toBe('function');
    expect(provider.getAgentState).toBeUndefined();
  });

  it('a provider with getAgentState returning AgentInternalState | null is valid', () => {
    const provider: PerceptionDataProvider = {
      getAgentLocation: () => 'kitchen',
      getObjectsInRoom: () => [],
      getAffordancesInRoom: () => [],
      getAgentDrives: () => ({ energy: 50 }),
      getPrimaryDriveLabel: () => 'low energy',
      getSystemFeedback: () => undefined,
      getAgentState: (agentId: string): AgentInternalState | null => {
        if (agentId === 'a1') {
          return {
            agentId: 'a1',
            drives: { energy: 50, hunger: 50, social: 50, comfort: 50, curiosity: 50 },
            currentGoal: 'test',
            currentPlan: null,
            isThinking: false,
            location: 'kitchen',
            lastPerceptionTick: 0,
          };
        }
        return null;
      },
    };
    const state = provider.getAgentState('a1');
    expect(state).not.toBeNull();
    expect(state?.agentId).toBe('a1');
    expect(provider.getAgentState('missing')).toBeNull();
  });
});

// ─── ExecuteResult.deviationRejected optional field ──────────────────────────

describe('ExecuteResult.deviationRejected optional field (Req 13)', () => {
  it('ExecuteResult with deviationRejected: true is assignable', () => {
    const result: ExecuteResult = {
      success: false,
      error: 'deviation',
      planComplete: false,
      deviationRejected: true,
    };
    expect(result.deviationRejected).toBe(true);
  });

  it('ExecuteResult without deviationRejected is still valid', () => {
    const result: ExecuteResult = { success: true, planComplete: true };
    expect(result.deviationRejected).toBeUndefined();
  });
});
