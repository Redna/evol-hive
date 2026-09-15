/**
 * Spec 059 — Plan-Retention Re-Validation (issue #210) — shared-layer types.
 *
 * AC-3 (R2): `PlanValidationResult.reasonCode` carries the three documented
 * rejection kinds; literals without `reasonCode` still typecheck and render as
 * before (additive-optional discipline under `exactOptionalPropertyTypes`).
 *
 * AC-4/AC-6 (R3): `ExecuteResult.planInvalidated` is additive-optional — a
 * result without it is byte-identically valid.
 *
 * AC-1 (R1): `AffordanceGuard.isAffordanceEligibleForAgent` is optional — a
 * guard omitting it still satisfies the interface (legacy implementations
 * compile and behave byte-identically).
 */
import { describe, it, expect } from 'vitest';
import type {
  AffordanceGuard,
  ExecuteDataProvider,
  ExecuteResult,
  PlanValidationResult,
  PlanValidationReasonCode,
} from '../src/index.js';

describe('spec 059 AC-3: PlanValidationResult.reasonCode (R2)', () => {
  it('accepts each documented reason code', () => {
    const codes: PlanValidationReasonCode[] = ['stale-target', 'movement-blocked', 'deviation'];
    for (const reasonCode of codes) {
      const result: PlanValidationResult = {
        valid: false,
        reason: 'a human-readable reason',
        reasonCode,
      };
      expect(result.reasonCode).toBe(reasonCode);
    }
  });

  it('keeps reason-string-only literals valid (additive-optional discipline)', () => {
    const ok: PlanValidationResult = { valid: true };
    const bad: PlanValidationResult = { valid: false, reason: 'deviation' };

    expect(ok.reasonCode).toBeUndefined();
    expect(bad.valid).toBe(false);
    expect(bad.reason).toBe('deviation');
    expect(bad.reasonCode).toBeUndefined();
  });
});

describe('spec 059 AC-4/AC-6: ExecuteResult.planInvalidated (R3)', () => {
  it('accepts planInvalidated: true alongside deviationRejected', () => {
    const result: ExecuteResult = {
      success: false,
      error: 'stale',
      planComplete: false,
      deviationRejected: true,
      planInvalidated: true,
    };
    expect(result.planInvalidated).toBe(true);
  });

  it('keeps results without planInvalidated byte-identically valid', () => {
    const result: ExecuteResult = { success: true, planComplete: false };
    expect(result.planInvalidated).toBeUndefined();
  });
});

describe('spec 059 AC-1: AffordanceGuard.isAffordanceEligibleForAgent is optional (R1)', () => {
  it('a legacy guard without the method still satisfies the interface', () => {
    const legacy: AffordanceGuard = {
      isAffordanceAvailableInRoom: () => true,
    };
    expect(legacy.isAffordanceEligibleForAgent).toBeUndefined();
  });

  it('a guard with the agent-scoped method satisfies the interface', () => {
    const scoped: AffordanceGuard = {
      isAffordanceAvailableInRoom: () => true,
      isAffordanceEligibleForAgent: (_affordanceId, _roomId, agentId) => agentId === 'a1',
    };
    expect(scoped.isAffordanceEligibleForAgent?.('x', 'room', 'a1')).toBe(true);
    expect(scoped.isAffordanceEligibleForAgent?.('x', 'room', 'a2')).toBe(false);
  });
});

describe('spec 059 AC-4/AC-6: ExecuteDataProvider.invalidatePlan is optional (R3)', () => {
  it('a provider without invalidatePlan still satisfies the interface', () => {
    const provider: Pick<ExecuteDataProvider, 'invalidatePlan'> = {};
    expect(provider.invalidatePlan).toBeUndefined();
  });
});
