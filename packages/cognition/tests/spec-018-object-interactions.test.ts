/**
 * Spec 018 — Cognition layer tests for Object Interactions.
 * Covers AC-34 through AC-39.
 */
import { describe, it, expect, vi } from 'vitest';
import type {
  Affordance,
  CompoundAction,
  ObjectDependency,
  PerceptionDataProvider,
  PerceptionResult,
  PassivePerception,
} from '@evol-hive/shared';
import type { EmbeddingProvider } from '../src/index.js';
import { AffordanceClassifierImpl } from '../src/classifier/pruning/index.js';
import { PerceptionServiceImpl } from '../src/pper/index.js';
import { PlanBuilderImpl } from '../src/pper/plan-builder.js';

const AGENT_ID = 'a1';
const ROOM_ID = 'kitchen';

const drives = { energy: 10, hunger: 50, social: 80, comfort: 60, curiosity: 40 };

const allAffordances: Affordance[] = [
  {
    id: 'brew_coffee',
    label: 'Brew coffee',
    engineEffect: 'brew_coffee',
    preconditions: [],
    effects: { energy: 20 },
  },
  {
    id: 'refill_water',
    label: 'Refill water',
    engineEffect: 'refill_water',
    preconditions: [],
    effects: {},
  },
];

const availableAffordances: Affordance[] = [allAffordances[1]!]; // only refill_water

const compoundActions: CompoundAction[] = [
  {
    id: 'brew_coffee',
    label: 'Brew Coffee',
    steps: [
      { affordanceId: 'add_water', description: 'Add water' },
      { affordanceId: 'brew_coffee', description: 'Brew coffee' },
    ],
  },
];

const objectDependencies: ObjectDependency[] = [
  {
    affordanceId: 'brew_coffee',
    requiresObjectId: 'sink-1',
    requiresAffordance: 'refill_water',
    description: 'Coffee Machine needs water from the Sink before brewing',
  },
];

/** Embedding provider where the drive label and "Brew coffee" are similar. */
class FakeEmbeddingProvider implements EmbeddingProvider {
  dimensions = 2;
  async embed(text: string): Promise<number[]> {
    if (text.includes('energy') || text === 'Brew coffee') return [1, 0];
    return [0, 1];
  }
  async embedBatch(texts: string[]): Promise<number[][]> {
    return texts.map((t) => (t.includes('energy') || t === 'Brew coffee' ? [1, 0] : [0, 1]));
  }
}

/** A provider that implements all the new spec 018 methods. */
function makeFullProvider(overrides: Partial<PerceptionDataProvider> = {}): PerceptionDataProvider {
  return {
    getAgentLocation: () => ROOM_ID,
    getObjectsInRoom: () => [{ id: 'coffee-1', name: 'Coffee Machine', type: 'appliance' }],
    getAffordancesInRoom: vi.fn(() => allAffordances),
    getAvailableAffordancesInRoom: vi.fn(() => availableAffordances),
    getCompoundActionsInRoom: vi.fn(() => compoundActions),
    getObjectDependenciesInRoom: vi.fn(() => objectDependencies),
    getAgentDrives: () => ({ ...drives }),
    getPrimaryDriveLabel: () => 'low energy, need to restore energy',
    getSystemFeedback: () => undefined,
    ...overrides,
  };
}

/** A provider that does NOT implement the new spec 018 methods (backward compat). */
function makeLegacyProvider(
  overrides: Partial<PerceptionDataProvider> = {},
): PerceptionDataProvider {
  return {
    getAgentLocation: () => ROOM_ID,
    getObjectsInRoom: () => [{ id: 'coffee-1', name: 'Coffee Machine', type: 'appliance' }],
    getAffordancesInRoom: vi.fn(() => allAffordances),
    getAgentDrives: () => ({ ...drives }),
    getPrimaryDriveLabel: () => 'low energy, need to restore energy',
    getSystemFeedback: () => undefined,
    ...overrides,
  };
}

function makeClassifier() {
  return new AffordanceClassifierImpl(new FakeEmbeddingProvider(), {
    topK: 5,
    similarityThreshold: 0.3,
  });
}

// ─── AC-34: perceive uses getAvailableAffordancesInRoom when available ───────

describe('PerceptionServiceImpl.perceive — available affordances (AC-34, AC-35)', () => {
  it('calls getAvailableAffordancesInRoom when the provider implements it (AC-34)', async () => {
    const provider = makeFullProvider();
    const service = new PerceptionServiceImpl({ provider, classifier: makeClassifier() });
    const result = await service.perceive(AGENT_ID);

    // The classifier should receive the filtered available affordances (refill_water only).
    // Since "Brew coffee" matches energy but "Refill water" doesn't, with only
    // refill_water available, the classifier output should be empty (not energy-related).
    expect(provider.getAvailableAffordancesInRoom).toHaveBeenCalledWith(ROOM_ID);
    expect(provider.getAffordancesInRoom).not.toHaveBeenCalled();
    // The classifier received only the available affordances.
    expect(result.prunedAffordances.map((a) => a.id)).not.toContain('brew_coffee');
  });

  it('falls back to getAffordancesInRoom when the provider does not implement getAvailableAffordancesInRoom (AC-35)', async () => {
    const provider = makeLegacyProvider();
    const service = new PerceptionServiceImpl({ provider, classifier: makeClassifier() });
    const result = await service.perceive(AGENT_ID);

    expect(provider.getAffordancesInRoom).toHaveBeenCalledWith(ROOM_ID);
    // All affordances were passed to the classifier; brew_coffee matches energy.
    expect(result.prunedAffordances.map((a) => a.id)).toEqual(['brew_coffee']);
  });
});

// ─── AC-36, AC-37: compoundActions and objectDependencies in PerceptionResult

describe('PerceptionServiceImpl.perceive — compound actions and dependencies (AC-36, AC-37)', () => {
  it('populates compoundActions in PerceptionResult when objects have them (AC-36)', async () => {
    const provider = makeFullProvider();
    const service = new PerceptionServiceImpl({ provider, classifier: makeClassifier() });
    const result: PerceptionResult = await service.perceive(AGENT_ID);

    expect(result.compoundActions).toBeDefined();
    expect(result.compoundActions).toHaveLength(1);
    expect(result.compoundActions?.[0]?.id).toBe('brew_coffee');
  });

  it('omits or empties compoundActions when no objects have them (AC-36)', async () => {
    const provider = makeFullProvider({
      getCompoundActionsInRoom: () => [],
    });
    const service = new PerceptionServiceImpl({ provider, classifier: makeClassifier() });
    const result: PerceptionResult = await service.perceive(AGENT_ID);

    // When empty, the field should be omitted or empty.
    if (result.compoundActions !== undefined) {
      expect(result.compoundActions).toHaveLength(0);
    }
  });

  it('populates objectDependencies in PerceptionResult when objects have them (AC-37)', async () => {
    const provider = makeFullProvider();
    const service = new PerceptionServiceImpl({ provider, classifier: makeClassifier() });
    const result: PerceptionResult = await service.perceive(AGENT_ID);

    expect(result.objectDependencies).toBeDefined();
    expect(result.objectDependencies).toHaveLength(1);
    expect(result.objectDependencies?.[0]?.affordanceId).toBe('brew_coffee');
  });

  it('omits or empties objectDependencies when no objects have them (AC-37)', async () => {
    const provider = makeFullProvider({
      getObjectDependenciesInRoom: () => [],
    });
    const service = new PerceptionServiceImpl({ provider, classifier: makeClassifier() });
    const result: PerceptionResult = await service.perceive(AGENT_ID);

    if (result.objectDependencies !== undefined) {
      expect(result.objectDependencies).toHaveLength(0);
    }
  });

  it('gracefully handles a legacy provider without compoundActions/dependencies methods (AC-36, AC-37)', async () => {
    const provider = makeLegacyProvider();
    const service = new PerceptionServiceImpl({ provider, classifier: makeClassifier() });
    const result: PerceptionResult = await service.perceive(AGENT_ID);

    // Should not throw; fields should be omitted or empty.
    expect(() => result.compoundActions).not.toThrow();
    expect(() => result.objectDependencies).not.toThrow();
  });
});

// ─── AC-38, AC-39: PlanBuilderImpl context lines ─────────────────────────────

describe('PlanBuilderImpl — compound actions and dependencies in LLM context (AC-38, AC-39)', () => {
  const builder = new PlanBuilderImpl();

  function makePerceptionResult(overrides: Partial<PerceptionResult> = {}): PerceptionResult {
    const passive: PassivePerception = {
      roomId: ROOM_ID,
      objectsPresent: [{ objectId: 'coffee-1', name: 'Coffee Machine', type: 'appliance' }],
      drives,
    };
    return {
      passive,
      prunedAffordances: allAffordances,
      primaryDriveLabel: 'low energy, need to restore energy',
      ...overrides,
    };
  }

  it('appends a "Multi-step actions available:" line when compoundActions is non-empty (AC-38)', () => {
    const payload = builder.build(makePerceptionResult({ compoundActions }));
    expect(payload.perceptionContext).toContain('Multi-step actions available:');
    expect(payload.perceptionContext).toContain('Brew Coffee');
  });

  it('does not append the multi-step line when compoundActions is empty or absent (AC-38)', () => {
    const payload = builder.build(makePerceptionResult());
    expect(payload.perceptionContext).not.toContain('Multi-step actions available:');

    const payloadEmpty = builder.build(makePerceptionResult({ compoundActions: [] }));
    expect(payloadEmpty.perceptionContext).not.toContain('Multi-step actions available:');
  });

  it('appends an "Object dependencies:" line when objectDependencies is non-empty (AC-39)', () => {
    const payload = builder.build(makePerceptionResult({ objectDependencies }));
    expect(payload.perceptionContext).toContain('Object dependencies:');
    expect(payload.perceptionContext).toContain('Coffee Machine needs water from the Sink');
  });

  it('does not append the dependencies line when objectDependencies is empty or absent (AC-39)', () => {
    const payload = builder.build(makePerceptionResult());
    expect(payload.perceptionContext).not.toContain('Object dependencies:');

    const payloadEmpty = builder.build(makePerceptionResult({ objectDependencies: [] }));
    expect(payloadEmpty.perceptionContext).not.toContain('Object dependencies:');
  });
});
