/**
 * Spec 041 — Applied-DriveChanges label signal (issue #152, R1).
 *
 * The PPER orchestrator's `runCycle` now returns a `PPERCycleOutcome` —
 * `{ appliedDriveChanges: boolean }` computed from what the phases DID
 * (Execute `driveChanges`, Reflect sanitized `driveOverrides`) — and the
 * outcome recorder's `onCycleSettled` hook accepts it (before `error?`).
 * These tests pin the shared contract: the outcome shape, the port
 * signature, and export visibility (structural assignment, per the
 * established shared-types test pattern).
 */
import { describe, it, expect } from 'vitest';
import type {
  PPERCycleOutcome,
  PPEROrchestratorPort,
  System1OutcomeRecorderPort,
  CycleStartContext,
} from '../src/index.js';

describe('PPERCycleOutcome (R1.1)', () => {
  it('is defined with an appliedDriveChanges boolean field', () => {
    const applied: PPERCycleOutcome = { appliedDriveChanges: true };
    expect(applied.appliedDriveChanges).toBe(true);
    const idle: PPERCycleOutcome = { appliedDriveChanges: false };
    expect(idle.appliedDriveChanges).toBe(false);
  });
});

describe('PPEROrchestratorPort.runCycle (R1.2)', () => {
  it('returns Promise<PPERCycleOutcome> — an implementation must resolve with the outcome', async () => {
    const port: PPEROrchestratorPort = {
      async runCycle(_agentId: string): Promise<PPERCycleOutcome> {
        return { appliedDriveChanges: true };
      },
      getPhase(_agentId: string): 'perceive' {
        return 'perceive';
      },
    };
    const outcome = await port.runCycle('a1');
    expect(outcome.appliedDriveChanges).toBe(true);
  });

  it('resolves with appliedDriveChanges: false for cycles that did nothing', async () => {
    const port: PPEROrchestratorPort = {
      async runCycle(_agentId: string): Promise<PPERCycleOutcome> {
        return { appliedDriveChanges: false };
      },
      getPhase(_agentId: string): 'perceive' {
        return 'perceive';
      },
    };
    const outcome = await port.runCycle('a1');
    expect(outcome).toEqual({ appliedDriveChanges: false });
  });
});

describe('System1OutcomeRecorderPort.onCycleSettled (R1.3)', () => {
  it('accepts an optional outcome parameter before the optional error parameter', async () => {
    const calls: {
      agentId: string;
      outcome: PPERCycleOutcome | undefined;
      error: string | undefined;
    }[] = [];
    const recorder: System1OutcomeRecorderPort = {
      onCycleStart(_agentId: string, _ctx: CycleStartContext): void {},
      onCycleSettled(
        agentId: string,
        outcome?: PPERCycleOutcome,
        error?: string,
      ): void {
        calls.push({ agentId, outcome, error });
      },
    };

    // Outcome-only call (the happy path the scheduler uses).
    recorder.onCycleSettled('a1', { appliedDriveChanges: true });
    // Legacy call with no outcome (probe wiring gaps) — must still compile.
    recorder.onCycleSettled('a2');
    // Error path: no outcome, error message third.
    recorder.onCycleSettled('a3', undefined, 'boom');

    expect(calls).toHaveLength(3);
    expect(calls[0]).toEqual({
      agentId: 'a1',
      outcome: { appliedDriveChanges: true },
      error: undefined,
    });
    expect(calls[1]).toEqual({ agentId: 'a2', outcome: undefined, error: undefined });
    expect(calls[2]).toEqual({ agentId: 'a3', outcome: undefined, error: 'boom' });
  });
});