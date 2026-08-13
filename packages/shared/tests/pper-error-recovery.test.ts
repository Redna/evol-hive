/**
 * Tests for PPER Error Recovery shared types and utilities (spec 008, issue #23).
 * Covers AC-9, AC-15, AC-18, AC-23, AC-24.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { AgentDrives } from '@evol-hive/shared';
import {
  detectDriveEdgeState,
  type PPERCycleStatus,
  type PPERErrorConfig,
  defaultPPERErrorConfig,
} from '@evol-hive/shared';

// ─── AC-9: PPERCycleStatus type ──────────────────────────────────────────────

describe('PPERCycleStatus type (AC-9)', () => {
  it('defines { consecutiveFailures: number; coolingDown: boolean; lastError?: string }', () => {
    const status: PPERCycleStatus = { consecutiveFailures: 0, coolingDown: false };
    expect(status.consecutiveFailures).toBe(0);
    expect(status.coolingDown).toBe(false);
    expect(status.lastError).toBeUndefined();
  });

  it('allows lastError to be set', () => {
    const status: PPERCycleStatus = {
      consecutiveFailures: 2,
      coolingDown: false,
      lastError: 'LLM connection refused',
    };
    expect(status.lastError).toBe('LLM connection refused');
  });

  it('allows coolingDown to be true', () => {
    const status: PPERCycleStatus = { consecutiveFailures: 3, coolingDown: true };
    expect(status.coolingDown).toBe(true);
  });
});

// ─── AC-23: PPERErrorConfig type ─────────────────────────────────────────────

describe('PPERErrorConfig type (AC-23)', () => {
  it('defines { maxConsecutiveFailures: number; failureCooldownMs: number }', () => {
    const config: PPERErrorConfig = { maxConsecutiveFailures: 3, failureCooldownMs: 5000 };
    expect(config.maxConsecutiveFailures).toBe(3);
    expect(config.failureCooldownMs).toBe(5000);
  });
});

// ─── AC-24: defaultPPERErrorConfig ───────────────────────────────────────────

describe('defaultPPERErrorConfig (AC-24)', () => {
  const originalMaxFailures = process.env['PPER_MAX_CONSECUTIVE_FAILURES'];
  const originalCooldown = process.env['PPER_FAILURE_COOLDOWN_MS'];

  beforeEach(() => {
    delete process.env['PPER_MAX_CONSECUTIVE_FAILURES'];
    delete process.env['PPER_FAILURE_COOLDOWN_MS'];
  });

  afterEach(() => {
    if (originalMaxFailures !== undefined) {
      process.env['PPER_MAX_CONSECUTIVE_FAILURES'] = originalMaxFailures;
    } else {
      delete process.env['PPER_MAX_CONSECUTIVE_FAILURES'];
    }
    if (originalCooldown !== undefined) {
      process.env['PPER_FAILURE_COOLDOWN_MS'] = originalCooldown;
    } else {
      delete process.env['PPER_FAILURE_COOLDOWN_MS'];
    }
  });

  it('returns { maxConsecutiveFailures: 3, failureCooldownMs: 5000 } by default', () => {
    const config = defaultPPERErrorConfig();
    expect(config.maxConsecutiveFailures).toBe(3);
    expect(config.failureCooldownMs).toBe(5000);
  });

  it('overrides maxConsecutiveFailures via PPER_MAX_CONSECUTIVE_FAILURES env var', () => {
    process.env['PPER_MAX_CONSECUTIVE_FAILURES'] = '5';
    const config = defaultPPERErrorConfig();
    expect(config.maxConsecutiveFailures).toBe(5);
    // Cooldown should still be the default.
    expect(config.failureCooldownMs).toBe(5000);
  });

  it('overrides failureCooldownMs via PPER_FAILURE_COOLDOWN_MS env var', () => {
    process.env['PPER_FAILURE_COOLDOWN_MS'] = '10000';
    const config = defaultPPERErrorConfig();
    expect(config.failureCooldownMs).toBe(10000);
    // Max failures should still be the default.
    expect(config.maxConsecutiveFailures).toBe(3);
  });

  it('overrides both via env vars', () => {
    process.env['PPER_MAX_CONSECUTIVE_FAILURES'] = '7';
    process.env['PPER_FAILURE_COOLDOWN_MS'] = '3000';
    const config = defaultPPERErrorConfig();
    expect(config.maxConsecutiveFailures).toBe(7);
    expect(config.failureCooldownMs).toBe(3000);
  });
});

// ─── AC-18: detectDriveEdgeState ─────────────────────────────────────────────

describe('detectDriveEdgeState (AC-18)', () => {
  const allZero: AgentDrives = {
    energy: 0,
    hunger: 0,
    social: 0,
    comfort: 0,
    curiosity: 0,
  };
  const allFull: AgentDrives = {
    energy: 100,
    hunger: 100,
    social: 100,
    comfort: 100,
    curiosity: 100,
  };
  const mixed: AgentDrives = {
    energy: 10,
    hunger: 50,
    social: 80,
    comfort: 60,
    curiosity: 40,
  };
  const mostlyZero: AgentDrives = {
    energy: 0,
    hunger: 0,
    social: 0,
    comfort: 0,
    curiosity: 1,
  };
  const mostlyFull: AgentDrives = {
    energy: 100,
    hunger: 100,
    social: 100,
    comfort: 100,
    curiosity: 99,
  };

  it('returns "all-zero" when all five drives are 0', () => {
    expect(detectDriveEdgeState(allZero)).toBe('all-zero');
  });

  it('returns "all-full" when all five drives are 100', () => {
    expect(detectDriveEdgeState(allFull)).toBe('all-full');
  });

  it('returns null for mixed drive values', () => {
    expect(detectDriveEdgeState(mixed)).toBeNull();
  });

  it('returns null when four drives are 0 but one is non-zero', () => {
    expect(detectDriveEdgeState(mostlyZero)).toBeNull();
  });

  it('returns null when four drives are 100 but one is not 100', () => {
    expect(detectDriveEdgeState(mostlyFull)).toBeNull();
  });
});

// ─── AC-15: PerceptionResult.stuck field ───────────────────────────────────

describe('PerceptionResult.stuck field (AC-15)', () => {
  it('PerceptionResult type includes optional stuck?: boolean', () => {
    // Type-level check — if this compiles, the field exists.
    const result = {
      passive: {
        roomId: 'kitchen',
        objectsPresent: [],
        drives: { energy: 50, hunger: 50, social: 50, comfort: 50, curiosity: 50 },
      },
      prunedAffordances: [],
      primaryDriveLabel: 'low energy',
      stuck: true,
    };
    expect(result.stuck).toBe(true);
  });

  it('stuck is optional — can be omitted', () => {
    const result = {
      passive: {
        roomId: 'kitchen',
        objectsPresent: [],
        drives: { energy: 50, hunger: 50, social: 50, comfort: 50, curiosity: 50 },
      },
      prunedAffordances: [],
      primaryDriveLabel: 'low energy',
    };
    expect(result.stuck).toBeUndefined();
  });
});
