/**
 * Type-level tests for Execute phase types (ExecuteResult, ExecutionOutcome,
 * ExecuteDataProvider). Validates that the interfaces exist and have the
 * correct shape.
 *
 * Covers AC-1, AC-2, AC-3.
 */
import { describe, it, expect } from 'vitest';
import type {
  ExecuteResult,
  ExecutionOutcome,
  ExecuteDataProvider,
  AffordanceResult,
  AgentInternalState,
  PlanStep,
  Affordance,
} from '../src/index.js';

// ─── ExecuteResult (AC-1) ─────────────────────────────────────────────────────

describe('ExecuteResult type (AC-1)', () => {
  it('allows a success result with an AffordanceResult and planComplete', () => {
    const result: AffordanceResult = {
      success: true,
      driveChanges: { energy: 20 },
    };
    const execResult: ExecuteResult = {
      success: true,
      result,
      planComplete: false,
    };
    expect(execResult.success).toBe(true);
    expect(execResult.result).toEqual(result);
    expect(execResult.planComplete).toBe(false);
    expect(execResult.error).toBeUndefined();
    expect(execResult.stepSkipped).toBeUndefined();
  });

  it('allows a failure result with an error', () => {
    const execResult: ExecuteResult = {
      success: false,
      error: 'Preconditions not met: has_water',
      planComplete: false,
    };
    expect(execResult.success).toBe(false);
    expect(execResult.error).toBe('Preconditions not met: has_water');
    expect(execResult.result).toBeUndefined();
    expect(execResult.planComplete).toBe(false);
  });

  it('allows a skipped step result with stepSkipped: true', () => {
    const execResult: ExecuteResult = {
      success: true,
      planComplete: true,
      stepSkipped: true,
    };
    expect(execResult.success).toBe(true);
    expect(execResult.stepSkipped).toBe(true);
    expect(execResult.planComplete).toBe(true);
    expect(execResult.result).toBeUndefined();
  });

  it('allows a plan-complete result without result or error', () => {
    const execResult: ExecuteResult = {
      success: true,
      planComplete: true,
    };
    expect(execResult.success).toBe(true);
    expect(execResult.planComplete).toBe(true);
    expect(execResult.result).toBeUndefined();
    expect(execResult.error).toBeUndefined();
  });
});

// ─── ExecutionOutcome (AC-2) ──────────────────────────────────────────────────

describe('ExecutionOutcome type (AC-2)', () => {
  it('allows a resolved outcome with preconditions met and a result', () => {
    const affordanceResult: AffordanceResult = {
      success: true,
      newState: { water_level: 0 },
      driveChanges: { energy: 20 },
    };
    const outcome: ExecutionOutcome = {
      resolved: true,
      objectId: 'coffee-1',
      preconditionsMet: true,
      result: affordanceResult,
    };
    expect(outcome.resolved).toBe(true);
    expect(outcome.objectId).toBe('coffee-1');
    expect(outcome.preconditionsMet).toBe(true);
    expect(outcome.failedPreconditions).toBeUndefined();
    expect(outcome.result).toEqual(affordanceResult);
  });

  it('allows an unresolved outcome (affordance not found in room)', () => {
    const outcome: ExecutionOutcome = {
      resolved: false,
      preconditionsMet: false,
    };
    expect(outcome.resolved).toBe(false);
    expect(outcome.objectId).toBeUndefined();
    expect(outcome.preconditionsMet).toBe(false);
    expect(outcome.failedPreconditions).toBeUndefined();
    expect(outcome.result).toBeUndefined();
  });

  it('allows a resolved outcome with failed preconditions', () => {
    const outcome: ExecutionOutcome = {
      resolved: true,
      objectId: 'coffee-1',
      preconditionsMet: false,
      failedPreconditions: ['has_water', 'has_beans'],
    };
    expect(outcome.resolved).toBe(true);
    expect(outcome.preconditionsMet).toBe(false);
    expect(outcome.failedPreconditions).toEqual(['has_water', 'has_beans']);
    expect(outcome.result).toBeUndefined();
  });
});

// ─── ExecuteDataProvider (AC-3) ───────────────────────────────────────────────

describe('ExecuteDataProvider interface (AC-3)', () => {
  it('can be implemented with all 10 required methods', () => {
    const provider: ExecuteDataProvider = {
      getAgentState(agentId: string): AgentInternalState | null {
        return null;
      },
      getCurrentStep(agentId: string): PlanStep | null {
        return null;
      },
      isPlanComplete(agentId: string): boolean {
        return true;
      },
      resolveAffordance(
        roomId: string,
        affordanceId: string,
      ): { objectId: string; affordance: Affordance } | null {
        return null;
      },
      checkPreconditions(
        affordanceId: string,
        objectId: string,
      ): { satisfied: boolean; failed: string[] } {
        return { satisfied: true, failed: [] };
      },
      async executeAffordance(
        objectId: string,
        affordanceId: string,
        agentId: string,
      ): Promise<AffordanceResult> {
        return { success: true };
      },
      advanceStep(agentId: string): void {
        // no-op
      },
      applyDriveChanges(agentId: string, changes: Partial<Record<string, number>>): void {
        // no-op
      },
      setSystemFeedback(agentId: string, feedback: string): void {
        // no-op
      },
      setThinking(agentId: string, isThinking: boolean): void {
        // no-op
      },
    };

    expect(provider.getAgentState('a1')).toBeNull();
    expect(provider.getCurrentStep('a1')).toBeNull();
    expect(provider.isPlanComplete('a1')).toBe(true);
    expect(provider.resolveAffordance('kitchen', 'brew_coffee')).toBeNull();
    expect(provider.checkPreconditions('brew_coffee', 'coffee-1')).toEqual({
      satisfied: true,
      failed: [],
    });
    expect(() => provider.advanceStep('a1')).not.toThrow();
    expect(() => provider.applyDriveChanges('a1', { energy: 20 })).not.toThrow();
    expect(() => provider.setSystemFeedback('a1', 'failed')).not.toThrow();
    expect(() => provider.setThinking('a1', false)).not.toThrow();
  });
});
