/**
 * Spec 059 — Plan-Retention Re-Validation (issue #210) — guardrail reason codes.
 *
 * AC-1 (R1): `validateAction` consumes the agent-scoped, moment-scoped
 * `isAffordanceEligibleForAgent` projection when the wired guard provides it;
 * a target absent from that projection is rejected with
 * `reasonCode === 'stale-target'`, a present target passes, and a guard that
 * omits the new method keeps the legacy `isAffordanceAvailableInRoom`
 * behaviour and reason string byte-identical.
 *
 * AC-3 (R2): all three rejection kinds carry the documented `reasonCode`.
 */
import { describe, it, expect } from 'vitest';
import type { AgentPlan, AffordanceGuard, TopologyGuard } from '@evol-hive/shared';
import { GuardrailEngineImpl } from '../src/guardrails/index.js';
import type { GuardrailConfig } from '@evol-hive/shared';

const AGENT_ID = 'iris-1';
const GARDEN = 'garden';

const GUARDRAIL_CONFIG: GuardrailConfig = {
  affordanceMasking: true,
  contextualForcing: true,
  planValidation: true,
};

function makePlan(targetAffordance = 'water_plants'): AgentPlan {
  return {
    id: 'plan_iris-1_150.6_40',
    description: 'Water the greenhouse',
    steps: [
      { description: 'Water', completed: false, targetAffordance },
      { description: 'Repot', completed: false, targetAffordance: 'repot' },
      { description: 'Water more', completed: false, targetAffordance: 'water_plants' },
    ],
    currentStepIndex: 2,
    createdAt: 150.6,
  };
}

describe('spec 059 AC-1: agent-scoped eligibility on the guard bridge (R1)', () => {
  it('rejects a non-movement target absent from the live eligible projection as stale-target', () => {
    const engine = new GuardrailEngineImpl(GUARDRAIL_CONFIG);
    const guard: AffordanceGuard = {
      isAffordanceAvailableInRoom: () => true, // room-level registry still has it
      isAffordanceEligibleForAgent: (affordanceId) => affordanceId !== 'water_plants',
    };

    const result = engine.validateAction('water_plants', makePlan(), {
      agentId: AGENT_ID,
      fromRoom: GARDEN,
      affordanceGuard: guard,
    });

    expect(result.valid).toBe(false);
    expect(result.reasonCode).toBe('stale-target');
    expect(result.reason).toContain('water_plants');
    expect(result.reason).toContain('stale');
  });

  it('passes when the target is present in the agent-scoped projection', () => {
    const engine = new GuardrailEngineImpl(GUARDRAIL_CONFIG);
    const guard: AffordanceGuard = {
      isAffordanceAvailableInRoom: () => false, // room-level check deliberately wrong
      isAffordanceEligibleForAgent: () => true,
    };

    const result = engine.validateAction('water_plants', makePlan(), {
      agentId: AGENT_ID,
      fromRoom: GARDEN,
      affordanceGuard: guard,
    });

    expect(result.valid).toBe(true);
    expect(result.reasonCode).toBeUndefined();
  });

  it('legacy guard without the new method: unchanged behavior and reason string', () => {
    const engine = new GuardrailEngineImpl(GUARDRAIL_CONFIG);
    const legacy: AffordanceGuard = {
      isAffordanceAvailableInRoom: () => false,
    };

    const result = engine.validateAction('water_plants', makePlan(), {
      agentId: AGENT_ID,
      fromRoom: GARDEN,
      affordanceGuard: legacy,
    });

    expect(result.valid).toBe(false);
    // Byte-identical to spec 031's documented reason string.
    expect(result.reason).toBe(
      `The 'water_plants' target is no longer in 'garden'. The plan is stale — reflect and choose a different action.`,
    );
  });

  it('legacy guard passes when isAffordanceAvailableInRoom reports availability', () => {
    const engine = new GuardrailEngineImpl(GUARDRAIL_CONFIG);
    const legacy: AffordanceGuard = {
      isAffordanceAvailableInRoom: () => true,
    };

    const result = engine.validateAction('water_plants', makePlan(), {
      agentId: AGENT_ID,
      fromRoom: GARDEN,
      affordanceGuard: legacy,
    });

    expect(result.valid).toBe(true);
  });
});

describe('spec 059 AC-3: all three rejection kinds carry the documented reasonCode (R2)', () => {
  it('stale-target: affordance guard rejection', () => {
    const engine = new GuardrailEngineImpl(GUARDRAIL_CONFIG);
    const result = engine.validateAction('water_plants', makePlan(), {
      agentId: AGENT_ID,
      fromRoom: GARDEN,
      affordanceGuard: { isAffordanceAvailableInRoom: () => false },
    });
    expect(result).toMatchObject({ valid: false, reasonCode: 'stale-target' });
  });

  it('movement-blocked: topology guard rejection', () => {
    const topologyGuard: TopologyGuard = {
      isMovementBlocked: () => true,
    };
    const engine = new GuardrailEngineImpl({ config: GUARDRAIL_CONFIG, topologyGuard });
    const result = engine.validateAction('go_to_workshop', makePlan('go_to_workshop'), {
      agentId: AGENT_ID,
      fromRoom: GARDEN,
    });
    expect(result).toMatchObject({ valid: false, reasonCode: 'movement-blocked' });
  });

  it('deviation: plan-alignment branch rejection', () => {
    const engine = new GuardrailEngineImpl(GUARDRAIL_CONFIG);
    const result = engine.validateAction('pick_herbs', makePlan('water_plants'), {
      agentId: AGENT_ID,
      fromRoom: GARDEN,
    });
    expect(result).toMatchObject({ valid: false, reasonCode: 'deviation' });
  });

  it('a valid action carries no reasonCode', () => {
    const engine = new GuardrailEngineImpl(GUARDRAIL_CONFIG);
    const result = engine.validateAction('water_plants', makePlan('water_plants'), {
      agentId: AGENT_ID,
      fromRoom: GARDEN,
    });
    expect(result).toEqual({ valid: true });
  });
});
