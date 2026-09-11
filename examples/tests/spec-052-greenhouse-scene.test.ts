/**
 * Spec 052 — Req 4: scene reconciliation — Tomas at HEAD (issue #183).
 *
 * The #183 run used a 3-agent scene variant (apprentice-1/Tomas) that did not
 * exist at HEAD, so the observation was not reproducible from main. Tomas
 * ships in `DYNAMIC_WORLD_SCENE` as the third agent, greenhouse-resident like
 * Iris, matching the #183 run population (gardener-1 garden, iris-1
 * greenhouse, apprentice-1 greenhouse) — making the cc=3 decay scaling
 * (spec 048 Req 1: divisor = live agent count) and the #183 observation
 * reproducible without re-deriving the scene.
 *
 * AC-4 coverage:
 * - `DYNAMIC_WORLD_SCENE` declares exactly `gardener-1`, `iris-1`,
 *   `apprentice-1`;
 * - Tomas starts in the greenhouse;
 * - the spec-049 seed-audit ordering (Tomas 0.8 > Iris 0.25 > Maren 0.15)
 *   still holds over the SHIPPED scene profiles.
 */
import { describe, it, expect } from 'vitest';
import { deriveSocialTalkativenessSeed } from '@evol-hive/shared';
import { DYNAMIC_WORLD_SCENE } from '../dynamic-world.ts';

describe('spec 052 Req 4 — Tomas ships in DYNAMIC_WORLD_SCENE (AC-4)', () => {
  it('the scene declares exactly gardener-1, iris-1, and apprentice-1', () => {
    expect(DYNAMIC_WORLD_SCENE.agents.map((a) => a.id)).toEqual([
      'gardener-1',
      'iris-1',
      'apprentice-1',
    ]);
  });

  it('Tomas starts in the greenhouse — the #183 population', () => {
    const tomas = DYNAMIC_WORLD_SCENE.agents.find((a) => a.id === 'apprentice-1');
    expect(tomas).toBeDefined();
    expect(tomas!.startRoomId).toBe('greenhouse');
    expect(tomas!.name).toBe('Tomas Lind');
  });

  it('the room assignments match the #183 run: Maren garden, Iris and Tomas greenhouse', () => {
    const byId = new Map(DYNAMIC_WORLD_SCENE.agents.map((a) => [a.id, a.startRoomId]));
    expect(byId.get('gardener-1')).toBe('garden');
    expect(byId.get('iris-1')).toBe('greenhouse');
    expect(byId.get('apprentice-1')).toBe('greenhouse');
  });

  it('the spec-049 seed-audit ordering still holds over the shipped profiles (Tomas 0.8 > Iris 0.25 > Maren 0.15)', () => {
    const seeds = new Map(
      DYNAMIC_WORLD_SCENE.agents.map((a) => [a.id, deriveSocialTalkativenessSeed(a)]),
    );
    // Tomas's inferred seed comes from the 'energetic' trait.
    expect(seeds.get('apprentice-1')).toBe(0.8);
    expect(seeds.get('iris-1')).toBe(0.25);
    // Maren's seed is the explicit field.
    const maren = DYNAMIC_WORLD_SCENE.agents.find((a) => a.id === 'gardener-1')!;
    expect(seeds.get('gardener-1')).toBe(maren.socialTalkativeness);
    expect(maren.socialTalkativeness).toBeLessThan(0.25);

    // The ordering itself.
    expect(seeds.get('apprentice-1')!).toBeGreaterThan(seeds.get('iris-1')!);
    expect(seeds.get('iris-1')!).toBeGreaterThan(seeds.get('gardener-1')!);
  });

  it('Tomas ships with the spec-049 audit persona texts and mid-level drives', () => {
    const tomas = DYNAMIC_WORLD_SCENE.agents.find((a) => a.id === 'apprentice-1')!;
    expect(tomas.traits).toContain('energetic');
    expect(tomas.socialTalkativeness).toBeUndefined(); // inferred, not explicit
    expect(tomas.initialDrives).toEqual({
      energy: 45,
      hunger: 40,
      social: 35,
      comfort: 50,
      curiosity: 60,
    });
  });
});