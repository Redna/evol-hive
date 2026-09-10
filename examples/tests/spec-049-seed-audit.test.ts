/**
 * Tests for spec 049 — R2: persona-seed inference audit + explicit seed for
 * Maren Holt (issue #167).
 *
 * Covers AC-3:
 * - the design-notes doc exists with the per-persona audit table;
 * - `deriveSocialTalkativenessSeed` pinned over the three shipped profiles:
 *   Tomas 0.8 ('energetic'), Iris 0.25 ('reserved'), Maren equal to her
 *   explicit field (< 0.25);
 * - with the explicit field removed, Maren would infer the neutral 0.5 —
 *   proving the shipped seed is EXPLICIT, not inferred ('patient',
 *   'methodical' and her backstory hit no keyword lists).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { deriveSocialTalkativenessSeed, DEFAULT_SOCIAL_TALKATIVENESS } from '@evol-hive/shared';
import type { AgentProfile } from '@evol-hive/shared';
import { DYNAMIC_WORLD_SCENE } from '../dynamic-world.ts';
import { apprenticeProfile } from '../dynamic-world-sim.ts';

const NOTES_PATH = resolve(__dirname, '../../docs/specs/notes/049-dialogue-completion-design-notes.md');

function shippedProfileByName(name: string): AgentProfile {
  const agent = DYNAMIC_WORLD_SCENE.agents.find((a) => a.name === name);
  expect(agent, `shipped scene must contain an agent named ${name}`).toBeDefined();
  return agent!;
}

describe('spec 049 R2 — seed-inference audit (AC-3)', () => {
  it('the design-notes doc exists with the per-persona audit table', () => {
    const notes = readFileSync(NOTES_PATH, 'utf8');
    // One audit row per shipped agent, each naming the agent and the seed.
    expect(notes).toContain('Maren Holt');
    expect(notes).toContain('Tomas Lind');
    expect(notes).toContain('Iris Voss');
    expect(notes).toContain('deriveSocialTalkativenessSeed');
    // The audit must state Maren's inference failure explicitly (R2).
    expect(notes).toContain('no keyword');
  });

  it('Tomas Lind infers 0.8 from the energetic trait', () => {
    expect(deriveSocialTalkativenessSeed(apprenticeProfile())).toBe(0.8);
  });

  it('Iris Voss infers 0.25 from the reserved trait', () => {
    const iris = shippedProfileByName('Iris Voss');
    expect(iris.socialTalkativeness).toBeUndefined();
    expect(deriveSocialTalkativenessSeed(iris)).toBe(0.25);
  });

  it('Maren Holt carries an explicit seed below Iris — and inference alone would give the neutral 0.5', () => {
    const maren = shippedProfileByName('Maren Holt');
    expect(maren.socialTalkativeness).toBeDefined();
    expect(maren.socialTalkativeness!).toBeLessThan(0.25);
    // The shipped seed is the explicit field, verbatim.
    expect(deriveSocialTalkativenessSeed(maren)).toBe(maren.socialTalkativeness!);

    // With the explicit field removed, traits ('patient', 'methodical') and
    // the backstory hit NO keyword lists → the neutral 0.5. This proves the
    // shipped seed is explicit, not inferred.
    const withoutExplicit: AgentProfile = { ...maren, socialTalkativeness: undefined };
    expect(deriveSocialTalkativenessSeed(withoutExplicit)).toBe(DEFAULT_SOCIAL_TALKATIVENESS);
    expect(deriveSocialTalkativenessSeed(withoutExplicit)).toBe(0.5);
  });
});