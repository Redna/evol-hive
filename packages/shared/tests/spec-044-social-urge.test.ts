/**
 * Tests for spec 044 — Social Urge Model: pure deterministic computation
 * (issue #160) — shared layer.
 *
 * Covers:
 * - AC-6 (R1): persona-seed derivation — trait "reserved" yields a lower seed
 *   than "energetic"; an explicit `socialTalkativeness` overrides trait
 *   inference; unknown traits yield the neutral default.
 * - AC-2 (R2, R3): the pure urge function — after N=3 unreplied greetings
 *   (sentCount=3, receivedCount=0) the reciprocity factor decays the urge
 *   below its value at (sentCount=1, receivedCount=0); a reply
 *   (receivedCount≥1) restores/raises the factor.
 * - R3: urge computation is pure and deterministic — no LLM, no clock beyond
 *   passed-in ticks, no engine/cognition imports, same input → same output,
 *   no input mutation.
 *
 * The urge model (spec 044):
 *   urge(target) = personaSeed × socialDriveFactor × noveltyFactor × reciprocityFactor
 */
import { describe, it, expect } from 'vitest';
import type { AgentProfile } from '../src/types/agent.js';
import {
  computeSocialUrge,
  deriveSocialTalkativenessSeed,
  DEFAULT_SOCIAL_TALKATIVENESS,
  SOCIAL_URGE_SURFACE_THRESHOLD,
} from '../src/types/social-urge.js';

// ── Fixtures ─────────────────────────────────────────────────────────────────

function makeProfile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    id: 'agent-a',
    name: 'Alice',
    description: 'A test agent',
    traits: [],
    initialDrives: {},
    ...overrides,
  };
}

/** Baseline urge input: neutral novelty and reciprocity, mid social drive. */
function makeUrgeInput(overrides: Parameters<typeof computeSocialUrge>[0] = {}) {
  return {
    personaSeed: 0.5,
    socialDrive: 50,
    currentTick: 1000,
    relationship: { trust: 50, familiarity: 0 },
    ...overrides,
  };
}

// ── AC-6 — persona seed derivation (R1) ──────────────────────────────────────

describe('deriveSocialTalkativenessSeed (AC-6, R1)', () => {
  it('trait "reserved" yields a lower seed than "energetic"', () => {
    const reserved = deriveSocialTalkativenessSeed(makeProfile({ traits: ['reserved'] }));
    const energetic = deriveSocialTalkativenessSeed(makeProfile({ traits: ['energetic'] }));
    expect(reserved).toBeLessThan(energetic);
  });

  it('an explicit socialTalkativeness overrides trait inference', () => {
    const overridden = deriveSocialTalkativenessSeed(
      makeProfile({ traits: ['reserved'], socialTalkativeness: 0.95 }),
    );
    expect(overridden).toBe(0.95);
  });

  it('an explicit override wins even against a high-inference trait', () => {
    const overridden = deriveSocialTalkativenessSeed(
      makeProfile({ traits: ['energetic', 'outgoing'], socialTalkativeness: 0.1 }),
    );
    expect(overridden).toBe(0.1);
  });

  it('unknown traits yield the neutral default', () => {
    const neutral = deriveSocialTalkativenessSeed(makeProfile({ traits: ['punctual', 'tidy'] }));
    expect(neutral).toBe(DEFAULT_SOCIAL_TALKATIVENESS);
  });

  it('no traits at all yields the neutral default', () => {
    expect(deriveSocialTalkativenessSeed(makeProfile())).toBe(DEFAULT_SOCIAL_TALKATIVENESS);
  });

  it('backstory keywords influence the seed deterministically', () => {
    const quietBackstory = deriveSocialTalkativenessSeed(
      makeProfile({ backstory: 'A quiet soul who keeps to herself.' }),
    );
    const chattyBackstory = deriveSocialTalkativenessSeed(
      makeProfile({ backstory: 'Never stops chatting with everyone in the room.' }),
    );
    expect(quietBackstory).toBeLessThan(DEFAULT_SOCIAL_TALKATIVENESS);
    expect(chattyBackstory).toBeGreaterThan(DEFAULT_SOCIAL_TALKATIVENESS);
  });

  it('the seed is clamped to [0, 1]', () => {
    expect(deriveSocialTalkativenessSeed(makeProfile({ socialTalkativeness: 5 }))).toBe(1);
    expect(deriveSocialTalkativenessSeed(makeProfile({ socialTalkativeness: -3 }))).toBe(0);
  });

  it('a non-finite explicit value falls back to trait inference (defensive)', () => {
    const seed = deriveSocialTalkativenessSeed(
      makeProfile({ traits: ['energetic'], socialTalkativeness: Number.NaN }),
    );
    expect(seed).toBeGreaterThan(DEFAULT_SOCIAL_TALKATIVENESS);
  });

  it('is deterministic — same profile, same seed', () => {
    const profile = makeProfile({ traits: ['reserved', 'curious'], backstory: 'Quiet gardener.' });
    expect(deriveSocialTalkativenessSeed(profile)).toBe(deriveSocialTalkativenessSeed(profile));
  });
});

// ── AC-2 — reciprocity decay & restore (R2, R3) ──────────────────────────────

describe('computeSocialUrge — reciprocity factor (AC-2, R2/R3)', () => {
  it('after 3 unreplied greetings the urge is below its value after 1', () => {
    const afterOne = computeSocialUrge(
      makeUrgeInput({ relationship: { sentCount: 1, receivedCount: 0, trust: 50, familiarity: 0 } }),
    );
    const afterThree = computeSocialUrge(
      makeUrgeInput({ relationship: { sentCount: 3, receivedCount: 0, trust: 50, familiarity: 0 } }),
    );
    expect(afterThree.factors.reciprocityFactor).toBeLessThan(afterOne.factors.reciprocityFactor);
    expect(afterThree.urge).toBeLessThan(afterOne.urge);
  });

  it('a reply (receivedCount ≥ 1) restores/raises the factor above the unreplied state', () => {
    const unreplied = computeSocialUrge(
      makeUrgeInput({ relationship: { sentCount: 1, receivedCount: 0, trust: 50, familiarity: 0 } }),
    );
    const replied = computeSocialUrge(
      makeUrgeInput({ relationship: { sentCount: 1, receivedCount: 1, trust: 50, familiarity: 0 } }),
    );
    expect(replied.factors.reciprocityFactor).toBeGreaterThan(unreplied.factors.reciprocityFactor);
  });

  it('a relationship without counters has a neutral reciprocity factor of 1', () => {
    const noCounters = computeSocialUrge(
      makeUrgeInput({ relationship: { trust: 50, familiarity: 0 } }),
    );
    expect(noCounters.factors.reciprocityFactor).toBe(1);
  });

  it('no relationship at all has a neutral reciprocity factor of 1', () => {
    const noRelationship = computeSocialUrge(makeUrgeInput({ relationship: undefined }));
    expect(noRelationship.factors.reciprocityFactor).toBe(1);
  });

  it('mutual exchanges (sent == received) do not decay the factor', () => {
    const balanced = computeSocialUrge(
      makeUrgeInput({ relationship: { sentCount: 4, receivedCount: 4, trust: 50, familiarity: 0 } }),
    );
    expect(balanced.factors.reciprocityFactor).toBeGreaterThanOrEqual(1);
  });

  it('trust modulates the factor — higher trust never lowers it for the same counters', () => {
    const lowTrust = computeSocialUrge(
      makeUrgeInput({ relationship: { sentCount: 3, receivedCount: 0, trust: 20, familiarity: 0 } }),
    );
    const highTrust = computeSocialUrge(
      makeUrgeInput({ relationship: { sentCount: 3, receivedCount: 0, trust: 80, familiarity: 0 } }),
    );
    expect(highTrust.factors.reciprocityFactor).toBeGreaterThanOrEqual(
      lowTrust.factors.reciprocityFactor,
    );
  });

  it('the reciprocity factor stays bounded even for extreme counters', () => {
    const extreme = computeSocialUrge(
      makeUrgeInput({
        relationship: { sentCount: 1000, receivedCount: 0, trust: 0, familiarity: 0 },
      }),
    );
    expect(extreme.factors.reciprocityFactor).toBeGreaterThan(0);
    const generous = computeSocialUrge(
      makeUrgeInput({
        relationship: { sentCount: 0, receivedCount: 1000, trust: 100, familiarity: 100 },
      }),
    );
    expect(generous.factors.reciprocityFactor).toBeLessThanOrEqual(1.5);
  });
});

// ── Factor model — social drive, novelty, clamping (R3) ──────────────────────

describe('computeSocialUrge — factor model (R3)', () => {
  it('a low social drive yields a higher factor than a full one (urgency pattern)', () => {
    const urgent = computeSocialUrge(makeUrgeInput({ socialDrive: 5 }));
    const satisfied = computeSocialUrge(makeUrgeInput({ socialDrive: 95 }));
    expect(urgent.factors.socialDriveFactor).toBeGreaterThan(satisfied.factors.socialDriveFactor);
  });

  it('the social drive factor mirrors the urgency-threshold pattern (below 40 → ≥ 0.8)', () => {
    const atThreshold = computeSocialUrge(makeUrgeInput({ socialDrive: 40 }));
    const below = computeSocialUrge(makeUrgeInput({ socialDrive: 10 }));
    expect(atThreshold.factors.socialDriveFactor).toBeGreaterThanOrEqual(0.8);
    expect(below.factors.socialDriveFactor).toBeGreaterThan(atThreshold.factors.socialDriveFactor);
  });

  it('an undefined social drive is neutral (factor 1)', () => {
    const result = computeSocialUrge(makeUrgeInput({ socialDrive: undefined }));
    expect(result.factors.socialDriveFactor).toBe(1);
  });

  it('a fresh agent (recent spawnTick) has a novelty boost; an old one is neutral', () => {
    const fresh = computeSocialUrge(makeUrgeInput({ spawnTick: 990, currentTick: 1000 }));
    const settled = computeSocialUrge(makeUrgeInput({ spawnTick: 0, currentTick: 100000 }));
    expect(fresh.factors.noveltyFactor).toBeGreaterThan(1);
    expect(settled.factors.noveltyFactor).toBe(1);
  });

  it('an undefined spawnTick (legacy save) is scene-novelty neutral', () => {
    const legacy = computeSocialUrge(makeUrgeInput({ spawnTick: undefined, currentTick: 1000 }));
    expect(legacy.factors.noveltyFactor).toBe(1);
  });

  it('few interactions with a target raise pair novelty (dual-source novelty)', () => {
    const stranger = computeSocialUrge(
      makeUrgeInput({ relationship: { sentCount: 0, receivedCount: 0, trust: 50, familiarity: 0 } }),
    );
    const familiar = computeSocialUrge(
      makeUrgeInput({ relationship: { sentCount: 9, receivedCount: 9, trust: 50, familiarity: 0 } }),
    );
    expect(stranger.factors.noveltyFactor).toBeGreaterThan(familiar.factors.noveltyFactor);
  });

  it('novelty is the MAX of scene and pair novelty (either source alone can raise)', () => {
    const sceneOnly = computeSocialUrge(
      makeUrgeInput({
        spawnTick: 1000,
        currentTick: 1000,
        relationship: { sentCount: 9, receivedCount: 9, trust: 50, familiarity: 0 },
      }),
    );
    expect(sceneOnly.factors.noveltyFactor).toBeGreaterThan(1);
  });

  it('the final urge is clamped to [0, 1]', () => {
    const maxed = computeSocialUrge(
      makeUrgeInput({
        personaSeed: 1,
        socialDrive: 0,
        spawnTick: 1000,
        currentTick: 1000,
        relationship: { sentCount: 0, receivedCount: 10, trust: 100, familiarity: 100 },
      }),
    );
    expect(maxed.urge).toBeLessThanOrEqual(1);
    const zeroed = computeSocialUrge(makeUrgeInput({ personaSeed: 0 }));
    expect(zeroed.urge).toBe(0);
  });

  it('urge equals the product of the four factors (model formula)', () => {
    const result = computeSocialUrge(
      makeUrgeInput({
        personaSeed: 0.7,
        socialDrive: 30,
        spawnTick: 900,
        currentTick: 1000,
        relationship: { sentCount: 2, receivedCount: 1, trust: 60, familiarity: 20 },
      }),
    );
    const product =
      result.factors.personaSeed *
      result.factors.socialDriveFactor *
      result.factors.noveltyFactor *
      result.factors.reciprocityFactor;
    expect(result.urge).toBeCloseTo(Math.min(1, Math.max(0, product)), 12);
  });
});

// ── Purity & surfacing threshold (R3, Decision 1/5) ──────────────────────────

describe('computeSocialUrge — purity & surfacing (R3)', () => {
  it('is deterministic — same input, same output', () => {
    const input = makeUrgeInput({
      personaSeed: 0.6,
      socialDrive: 35,
      spawnTick: 800,
      relationship: { sentCount: 2, receivedCount: 0, trust: 50, familiarity: 10 },
    });
    const a = computeSocialUrge(input);
    const b = computeSocialUrge(input);
    expect(a).toEqual(b);
  });

  it('does not mutate its input', () => {
    const input = makeUrgeInput({
      relationship: { sentCount: 3, receivedCount: 0, trust: 50, familiarity: 0 },
    });
    const frozen = JSON.parse(JSON.stringify(input));
    computeSocialUrge(input);
    expect(input).toEqual(frozen);
  });

  it('the surface threshold sits in (0, 1) so a default persona with an urgent drive surfaces', () => {
    expect(SOCIAL_URGE_SURFACE_THRESHOLD).toBeGreaterThan(0);
    expect(SOCIAL_URGE_SURFACE_THRESHOLD).toBeLessThan(1);
    // Energetic persona + urgent social drive + fresh spawn → above threshold.
    const energetic = computeSocialUrge({
      personaSeed: deriveSocialTalkativenessSeed(makeProfile({ traits: ['energetic'] })),
      socialDrive: 25,
      spawnTick: 950,
      currentTick: 1000,
      relationship: { trust: 50, familiarity: 0 },
    });
    expect(energetic.urge).toBeGreaterThanOrEqual(SOCIAL_URGE_SURFACE_THRESHOLD);
    // Reserved persona under the same conditions → below threshold.
    const reserved = computeSocialUrge({
      personaSeed: deriveSocialTalkativenessSeed(makeProfile({ traits: ['reserved'] })),
      socialDrive: 25,
      spawnTick: 950,
      currentTick: 1000,
      relationship: { trust: 50, familiarity: 0 },
    });
    expect(reserved.urge).toBeLessThan(SOCIAL_URGE_SURFACE_THRESHOLD);
  });
});