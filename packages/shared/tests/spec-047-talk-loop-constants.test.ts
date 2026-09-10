/**
 * Tests for spec 047 — Talk Loop Fix (issue #176) — shared constants (R7).
 *
 * The three new constants live next to the spec 044 urge constants with doc
 * comments cross-referencing spec 047 and issue #176:
 * - SOCIAL_TALK_CAP (R4) — consecutive-unanswered `talk_to` cap per target.
 * - SOCIAL_MONOLOGUE_REWARD (R5) — own social granted on the send itself.
 * - SOCIAL_EXCHANGE_BONUS (R5/R6) — deferred top-up when the target
 *   contributes to the same thread.
 *
 * The split must sum to the historical full restore (+10) so a real exchange
 * restores social exactly as before (AC-2). Existing spec 044 constants are
 * reused — no threshold duplication (R7).
 */
import { describe, it, expect } from 'vitest';
import {
  SOCIAL_TALK_CAP,
  SOCIAL_MONOLOGUE_REWARD,
  SOCIAL_EXCHANGE_BONUS,
  SOCIAL_URGE_SURFACE_THRESHOLD,
  SOCIAL_URGE_RECIPROCITY_DECAYED,
} from '../src/types/social-urge.js';

describe('spec 047 shared constants (R7, AC-7)', () => {
  it('SOCIAL_TALK_CAP is 3 — the consecutive-unanswered talk_to cap (R4)', () => {
    expect(SOCIAL_TALK_CAP).toBe(3);
  });

  it('SOCIAL_MONOLOGUE_REWARD is 2 — the token grant on send (R5)', () => {
    expect(SOCIAL_MONOLOGUE_REWARD).toBe(2);
  });

  it('SOCIAL_EXCHANGE_BONUS is 8 — the deferred top-up on exchange completion (R5/R6)', () => {
    expect(SOCIAL_EXCHANGE_BONUS).toBe(8);
  });

  it('the split sums to the historical full restore: monologue + exchange = 10 (AC-2)', () => {
    expect(SOCIAL_MONOLOGUE_REWARD + SOCIAL_EXCHANGE_BONUS).toBe(10);
  });

  it('reuses the spec 044 thresholds (no duplication) — they remain exported and unchanged', () => {
    expect(SOCIAL_URGE_SURFACE_THRESHOLD).toBe(0.45);
    expect(SOCIAL_URGE_RECIPROCITY_DECAYED).toBe(0.7);
  });
});