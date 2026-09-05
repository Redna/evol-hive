/**
 * Spec 035 — System 1 shared feature-schema contract tests (Req 1, Req 2).
 * The scalar schema is the contract between TS extraction and any trainer
 * (ADR-0002 "Negative costs" mitigation): fixed field order, fixed
 * normalization, and a version constant stamped in every output.
 */
import { describe, it, expect } from 'vitest';
import {
  FEATURE_SCHEMA_VERSION,
  SCALAR_FEATURE_FIELDS,
  NO_HARD_TRIGGERS,
  validateScalarFeatures,
  defaultSystem1GateConfig,
  type ScalarFeatures,
} from '../src/index.js';

describe('Spec 035 — feature schema contract (Req 2)', () => {
  it('exposes an integer FEATURE_SCHEMA_VERSION >= 1', () => {
    expect(Number.isInteger(FEATURE_SCHEMA_VERSION)).toBe(true);
    expect(FEATURE_SCHEMA_VERSION).toBeGreaterThanOrEqual(1);
  });

  it('SCALAR_FEATURE_FIELDS has a stable, documented field order', () => {
    // The order IS the contract — the trainer consumes this exact sequence.
    // 5 drives + 5 drive deltas + novelty + 6 flags = 18 scalar fields.
    expect(SCALAR_FEATURE_FIELDS).toEqual([
      'driveEnergy',
      'driveHunger',
      'driveSocial',
      'driveComfort',
      'driveCuriosity',
      'deltaEnergy',
      'deltaHunger',
      'deltaSocial',
      'deltaComfort',
      'deltaCuriosity',
      'novelty',
      'messagePending',
      'conversationOpen',
      'conversationTurns',
      'nearbyObjectStateChange',
      'worldMutation',
      'driveThresholdCrossing',
      'ticksSinceLastCycle',
    ]);
    expect(SCALAR_FEATURE_FIELDS).toHaveLength(18);
  });

  it('validateScalarFeatures accepts a fully-normalized vector and reports no violations', () => {
    const valid = {} as ScalarFeatures;
    for (const field of SCALAR_FEATURE_FIELDS) {
      valid[field] = field === 'messagePending' || field === 'conversationOpen' || field === 'nearbyObjectStateChange' || field === 'worldMutation' || field === 'driveThresholdCrossing' ? 1 : 0.5;
    }
    expect(validateScalarFeatures(valid)).toEqual([]);
  });

  it('validateScalarFeatures flags out-of-range drives and deltas', () => {
    const bad = {} as ScalarFeatures;
    for (const field of SCALAR_FEATURE_FIELDS) {
      bad[field] = 0;
    }
    bad.driveEnergy = 1.5; // drives must be 0..1
    bad.deltaHunger = -1.5; // deltas must be -1..1
    bad.novelty = 2; // novelty must be 0..1
    bad.messagePending = 7; // binary flags must be 0 or 1
    const violations = validateScalarFeatures(bad);
    expect(violations).toHaveLength(4);
    expect(violations.some((v) => v.includes('driveEnergy'))).toBe(true);
    expect(violations.some((v) => v.includes('deltaHunger'))).toBe(true);
    expect(violations.some((v) => v.includes('novelty'))).toBe(true);
    expect(violations.some((v) => v.includes('messagePending'))).toBe(true);
  });

  it('NO_HARD_TRIGGERS has all flags false', () => {
    expect(NO_HARD_TRIGGERS).toEqual({
      messagePending: false,
      conversationInvite: false,
      nearbyObjectMutation: false,
      driveThresholdCrossing: false,
    });
  });

  it('defaultSystem1GateConfig is documented and deterministic', () => {
    const cfg = defaultSystem1GateConfig();
    expect(cfg.threshold).toBeGreaterThan(0);
    expect(cfg.threshold).toBeLessThan(1);
    expect(cfg.embeddingRefreshIntervalTicks).toBeGreaterThan(0);
    expect(cfg.noveltyMemoryK).toBeGreaterThan(0);
    expect(cfg.ticksNormalization).toBeGreaterThan(0);
    expect(cfg.conversationTurnsNormalization).toBeGreaterThan(0);
  });
});