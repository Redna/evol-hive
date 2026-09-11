/**
 * Spec 052 — Req 2: restoration exemption in System-0 pruning (issue #183).
 *
 * The System-0 classifier's similarity funnel sits BEFORE the tool enum and
 * the drive→affordance hints. In the #183 run the greenhouse's restorers
 * (`rest_among_seedlings`, `eat_herbs`) were pruned away exactly when their
 * drives were urgent — the primary-drive label embedded far from their labels
 * (threshold 0.3, topK 5, only `go_to_*` exempt) and the agents could neither
 * hint at nor call the affordance that would save them.
 *
 * AC-1 coverage:
 * - with energy < 40, an agent in the greenhouse keeps `rest_among_seedlings`
 *   in the pruned set even when its label embeds below the similarity
 *   threshold;
 * - with hunger < 40, `eat_herbs` survives;
 * - with all drives ≥ 40, pruning behaves byte-identically to pre-change
 *   (legacy `PruneOptions` omission path — the classifier receives NO options
 *   and the output equals the pre-change algorithm);
 * - the urgency gate is the point (Constraints): an affordance whose declared
 *   `effects` restore only NON-urgent drives is still pruned.
 *
 * The rule is data-driven from declared `effects` only (spec 034 Req 3) — no
 * hardcoded drive→affordance table.
 */
import { describe, it, expect } from 'vitest';
import type { Affordance } from '@evol-hive/shared';
import type { EmbeddingProvider, PruneOptions } from '../src/classifier/index.js';
import { AffordanceClassifierImpl } from '../src/classifier/pruning/index.js';
import { PerceptionServiceImpl } from '../src/pper/index.js';
import type { PerceptionDataProvider } from '@evol-hive/shared';
import { HINTABLE_DRIVES, DRIVE_URGENCY_THRESHOLD } from '../src/pper/drive-affordance-matcher.js';

// ─── Fixtures: the greenhouse (issue #183) ───────────────────────────────────

const ENERGY_LABEL = 'low energy, need to restore energy';
const HUNGER_LABEL = 'low hunger, need to eat';

/** Greenhouse restorers — declared effects are the ONLY source of truth. */
function greenhouseAffordances(): Affordance[] {
  return [
    {
      id: 'repot_seedlings',
      label: 'Repot seedlings',
      engineEffect: 'repot_seedlings',
      preconditions: [],
      effects: { curiosity: 12, comfort: 5 },
    },
    {
      id: 'rest_among_seedlings',
      label: 'Rest among the seedlings',
      engineEffect: 'rest_among_seedlings',
      preconditions: [],
      effects: { comfort: 15, energy: 4 },
    },
    {
      id: 'pick_herbs',
      label: 'Pick fresh herbs',
      engineEffect: 'pick_herbs',
      preconditions: [],
      effects: { curiosity: 8 },
    },
    {
      id: 'eat_herbs',
      label: 'Eat a fresh herb',
      engineEffect: 'eat_herbs',
      preconditions: [],
      effects: { hunger: 20 },
    },
    {
      id: 'go_to_garden',
      label: 'Go to garden',
      engineEffect: 'go_to_garden',
      preconditions: [],
      effects: {},
    },
  ];
}

/**
 * Embedding provider where the greenhouse restorer labels embed ORTHOGONAL
 * to both drive labels (cosine 0 — far below the 0.3 threshold): the exact
 * #183 failure mode. The drive labels embed along [1, 0].
 */
class OrthogonalEmbeddingProvider implements EmbeddingProvider {
  dimensions = 2;
  async embed(text: string): Promise<number[]> {
    if (text === ENERGY_LABEL || text === HUNGER_LABEL) return [1, 0];
    return [0, 1];
  }
  async embedBatch(texts: string[]): Promise<number[][]> {
    return texts.map((t) => {
      if (t === ENERGY_LABEL || t === HUNGER_LABEL) return [1, 0];
      return [0, 1];
    });
  }
}

function makeClassifier(): AffordanceClassifierImpl {
  return new AffordanceClassifierImpl(new OrthogonalEmbeddingProvider(), {
    topK: 5,
    similarityThreshold: 0.3,
  });
}

// ─── AC-1: urgent declared restorers survive the funnel ──────────────────────

describe('spec 052 Req 2 — restoration exemption in pruning (AC-1)', () => {
  it('keeps rest_among_seedlings when energy is urgent, despite an orthogonal label', async () => {
    const classifier = makeClassifier();
    const pruned = await classifier.prune(ENERGY_LABEL, greenhouseAffordances(), {
      urgentDrives: ['energy'],
    });
    const ids = pruned.map((a) => a.id);
    expect(ids).toContain('rest_among_seedlings');
  });

  it('keeps eat_herbs when hunger is urgent, despite an orthogonal label', async () => {
    const classifier = makeClassifier();
    const pruned = await classifier.prune(HUNGER_LABEL, greenhouseAffordances(), {
      urgentDrives: ['hunger'],
    });
    expect(pruned.map((a) => a.id)).toContain('eat_herbs');
  });

  it('still prunes affordances that restore only NON-urgent drives (urgency gate)', async () => {
    const classifier = makeClassifier();
    // repot_seedlings declares comfort/curiosity effects only; energy is the
    // urgent drive → it gets no exemption and its orthogonal label prunes it.
    const pruned = await classifier.prune(ENERGY_LABEL, greenhouseAffordances(), {
      urgentDrives: ['energy'],
    });
    expect(pruned.map((a) => a.id)).not.toContain('repot_seedlings');
    expect(pruned.map((a) => a.id)).not.toContain('pick_herbs');
  });

  it('legacy path: omitted urgentDrives prunes the restorers exactly like pre-change', async () => {
    const classifier = makeClassifier();
    // No options object at all — the pre-change call signature. Every label
    // is orthogonal to the drive label, so only the movement affordance
    // survives (the pre-existing go_to_* exemption).
    const pruned = await classifier.prune(ENERGY_LABEL, greenhouseAffordances());
    expect(pruned.map((a) => a.id)).toEqual(['go_to_garden']);
  });

  it('an empty urgentDrives list behaves exactly like the legacy path', async () => {
    const classifier = makeClassifier();
    const legacy = await classifier.prune(ENERGY_LABEL, greenhouseAffordances());
    const empty = await classifier.prune(ENERGY_LABEL, greenhouseAffordances(), {
      urgentDrives: [],
    });
    expect(empty.map((a) => a.id)).toEqual(legacy.map((a) => a.id));
  });

  it('exempt restorers do not crowd out other candidates (topK budget shared with movement)', async () => {
    // topK 3: one similar candidate + one urgent restorer + one movement →
    // all three survive (the restorer's exemption mirrors go_to_*'s).
    const classifier = new AffordanceClassifierImpl(
      new (class implements EmbeddingProvider {
        dimensions = 2;
        async embed(text: string): Promise<number[]> {
          return text === ENERGY_LABEL || text === 'Brew coffee' ? [1, 0] : [0, 1];
        }
        async embedBatch(texts: string[]): Promise<number[][]> {
          return texts.map((t) => (t === ENERGY_LABEL || t === 'Brew coffee' ? [1, 0] : [0, 1]));
        }
      })(),
      { topK: 3, similarityThreshold: 0.3 },
    );
    const affordances: Affordance[] = [
      {
        id: 'brew_coffee',
        label: 'Brew coffee',
        engineEffect: 'brew_coffee',
        preconditions: [],
        effects: { energy: 10 },
      },
      ...greenhouseAffordances(),
    ];
    const pruned = await classifier.prune(ENERGY_LABEL, affordances, { urgentDrives: ['energy'] });
    const ids = pruned.map((a) => a.id);
    expect(ids).toContain('brew_coffee'); // similar candidate, within topK − exempt
    expect(ids).toContain('rest_among_seedlings'); // urgent restorer (exempt)
    expect(ids).toContain('go_to_garden'); // movement (exempt)
  });

  it('restorers of urgent drives are never dropped by the topK cap either', async () => {
    // topK 1 with two similar candidates + one urgent restorer: the restorer
    // survives even though the cap is exhausted.
    const classifier = new AffordanceClassifierImpl(new OrthogonalEmbeddingProvider(), {
      topK: 1,
      similarityThreshold: 0.3,
    });
    const affordances: Affordance[] = [
      {
        id: 'a',
        label: 'x',
        engineEffect: 'a',
        preconditions: [],
        effects: {},
      },
      {
        id: 'b',
        label: 'y',
        engineEffect: 'b',
        preconditions: [],
        effects: {},
      },
      ...greenhouseAffordances(),
    ];
    const pruned = await classifier.prune(ENERGY_LABEL, affordances, { urgentDrives: ['energy'] });
    expect(pruned.map((a) => a.id)).toContain('rest_among_seedlings');
  });
});

// ─── AC-1: the perceive path passes the urgent hintable drives ───────────────

interface CapturedCall {
  driveLabel: string;
  options: PruneOptions | undefined;
}

/** Classifier stub that records every prune() call and returns its input. */
class RecordingClassifier {
  readonly calls: CapturedCall[] = [];
  async prune(
    driveLabel: string,
    affordances: Affordance[],
    options?: PruneOptions,
  ): Promise<Affordance[]> {
    this.calls.push({ driveLabel, options });
    return affordances;
  }
}

function makePerceptionProvider(drives: Record<string, number>): PerceptionDataProvider {
  return {
    getAgentLocation: () => 'greenhouse',
    getObjectsInRoom: () => [],
    getAffordancesInRoom: () => greenhouseAffordances(),
    getAgentDrives: () => drives,
    getPrimaryDriveLabel: () => ENERGY_LABEL,
    getSystemFeedback: () => undefined,
    getAgentState: () => null,
  };
}

describe('spec 052 Req 2 — the perceive path forwards urgent hintable drives', () => {
  it('passes { urgentDrives } when a hintable drive is below the urgency threshold', async () => {
    const classifier = new RecordingClassifier();
    const service = new PerceptionServiceImpl({
      provider: makePerceptionProvider({
        energy: 35,
        hunger: 50,
        social: 50,
        comfort: 50,
        curiosity: 50,
      }),
      classifier: classifier as unknown as AffordanceClassifierImpl,
    });
    const perception = await service.perceive('iris-1');
    expect(classifier.calls).toHaveLength(1);
    const call = classifier.calls[0]!;
    expect(call.options).toEqual({ urgentDrives: ['energy'] });
    // The pruned set is the classifier output — the restorer rides through.
    expect(perception.prunedAffordances.map((a) => a.id)).toContain('rest_among_seedlings');
  });

  it('passes multiple urgent drives when several hintable drives are low', async () => {
    const classifier = new RecordingClassifier();
    const service = new PerceptionServiceImpl({
      provider: makePerceptionProvider({
        energy: 10,
        hunger: 20,
        social: 50,
        comfort: 50,
        curiosity: 50,
      }),
      classifier: classifier as unknown as AffordanceClassifierImpl,
    });
    await service.perceive('iris-1');
    expect(classifier.calls[0]!.options).toEqual({ urgentDrives: ['energy', 'hunger'] });
  });

  it('omits the options object entirely when all hintable drives are ≥ 40 (byte-identical legacy)', async () => {
    const classifier = new RecordingClassifier();
    const service = new PerceptionServiceImpl({
      provider: makePerceptionProvider({
        energy: 45,
        hunger: 40,
        social: 50,
        comfort: 50,
        curiosity: 50,
      }),
      classifier: classifier as unknown as AffordanceClassifierImpl,
    });
    await service.perceive('iris-1');
    expect(classifier.calls[0]!.options).toBeUndefined();
  });

  it('never includes social in urgentDrives (spec 018/024/047 own the social path)', async () => {
    const classifier = new RecordingClassifier();
    const service = new PerceptionServiceImpl({
      provider: makePerceptionProvider({
        energy: 50,
        hunger: 50,
        social: 5,
        comfort: 50,
        curiosity: 50,
      }),
      classifier: classifier as unknown as AffordanceClassifierImpl,
    });
    await service.perceive('iris-1');
    // social is urgent but NOT hintable → no options at all (nothing urgent
    // among the hintable drives).
    expect(classifier.calls[0]!.options).toBeUndefined();
  });

  it('the matcher constants are unchanged (urgency threshold 40, hintable drives exclude social)', () => {
    expect(DRIVE_URGENCY_THRESHOLD).toBe(40);
    expect(HINTABLE_DRIVES).toEqual(['energy', 'hunger', 'comfort', 'curiosity']);
  });
});
