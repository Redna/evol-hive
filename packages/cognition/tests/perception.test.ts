import { describe, it, expect, beforeEach } from 'vitest';
import type {
  Affordance,
  PassivePerception,
  PerceptionResult,
  PassivePerceptionInput,
  PerceptionCompileInput,
  LLMActionResponse,
} from '@evol-hive/shared';
import { llmActionResponseSchema } from '@evol-hive/shared';
import type { EmbeddingProvider, AffordanceClassifier } from '../src/classifier/index.js';
import { AffordanceClassifierImpl } from '../src/classifier/pruning/index.js';
import { buildPassivePerception, runPerception, PerceptionBuilderImpl } from '../src/pper/index.js';

// AC-11: buildPassivePerception returns PassivePerception with correct fields.
// AC-12: objectsPresent does NOT contain state or affordances fields.
// AC-16: PerceptionResult includes prunedAffordances from prune().
// AC-18: PerceptionBuilder.build returns LLMContextPayload with correct fields.
// AC-19: No method in the Perceive phase calls LLMClient.
// AC-20: associativeMemories is undefined when not wired, type allows MemorySnippet[].
// AC-21: systemFeedback is included when present.

function makeAffordance(id: string, label: string): Affordance {
  return {
    id,
    label,
    engineEffect: `effect_${id}`,
    preconditions: [],
    effects: {},
  };
}

/** Mock embedding provider for deterministic classifier tests. */
class MockEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions = 3;
  private vectors: Map<string, number[]>;

  constructor(vectors: Map<string, number[]>) {
    this.vectors = vectors;
  }

  async embed(text: string): Promise<number[]> {
    return this.vectors.get(text) ?? [0, 0, 0];
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return texts.map((t) => this.vectors.get(t) ?? [0, 0, 0]);
  }
}

function makeClassifier(): AffordanceClassifier {
  const vectors = new Map<string, number[]>([
    ['low energy, need to restore energy', [1, 0, 0]],
    ['Brew coffee to restore energy', [0.9, 0.1, 0]],
    ['Play video games', [0, 1, 0]],
  ]);
  const provider = new MockEmbeddingProvider(vectors);
  return new AffordanceClassifierImpl(provider, {
    topK: 5,
    similarityThreshold: 0.3,
  });
}

describe('buildPassivePerception (AC-11, AC-12, AC-20, AC-21)', () => {
  it('returns PassivePerception with roomId matching agent location — AC-11', () => {
    const input: PassivePerceptionInput = {
      roomId: 'kitchen',
      objectsInRoom: [
        { id: 'coffee-machine', name: 'Coffee Machine', type: 'appliance' },
        { id: 'table', name: 'Table', type: 'furniture' },
      ],
      drives: { energy: 10, hunger: 50, social: 80, comfort: 60, curiosity: 40 },
    };

    const result = buildPassivePerception(input);

    expect(result.roomId).toBe('kitchen');
  });

  it('maps objectsInRoom to objectsPresent with { objectId, name, type } — AC-11', () => {
    const input: PassivePerceptionInput = {
      roomId: 'kitchen',
      objectsInRoom: [
        { id: 'coffee-machine', name: 'Coffee Machine', type: 'appliance' },
        { id: 'table', name: 'Table', type: 'furniture' },
      ],
      drives: { energy: 10 },
    };

    const result = buildPassivePerception(input);

    expect(result.objectsPresent).toHaveLength(2);
    expect(result.objectsPresent[0]?.objectId).toBe('coffee-machine');
    expect(result.objectsPresent[0]?.name).toBe('Coffee Machine');
    expect(result.objectsPresent[0]?.type).toBe('appliance');
  });

  it('drives match the agent current drive values — AC-11', () => {
    const input: PassivePerceptionInput = {
      roomId: 'kitchen',
      objectsInRoom: [],
      drives: { energy: 10, hunger: 50, social: 80, comfort: 60, curiosity: 40 },
    };

    const result = buildPassivePerception(input);

    expect(result.drives).toEqual({
      energy: 10,
      hunger: 50,
      social: 80,
      comfort: 60,
      curiosity: 40,
    });
  });

  it('objectsPresent entries do NOT contain state or affordances fields — AC-12', () => {
    const input: PassivePerceptionInput = {
      roomId: 'kitchen',
      objectsInRoom: [{ id: 'coffee-machine', name: 'Coffee Machine', type: 'appliance' }],
      drives: { energy: 10 },
    };

    const result = buildPassivePerception(input);

    const obj = result.objectsPresent[0]!;
    expect('state' in obj).toBe(false);
    expect('affordances' in obj).toBe(false);
  });

  it('associativeMemories is undefined when not provided — AC-20', () => {
    const input: PassivePerceptionInput = {
      roomId: 'kitchen',
      objectsInRoom: [],
      drives: { energy: 10 },
    };

    const result = buildPassivePerception(input);

    expect(result.associativeMemories).toBeUndefined();
  });

  it('systemFeedback is included when present — AC-21', () => {
    const input: PassivePerceptionInput = {
      roomId: 'kitchen',
      objectsInRoom: [],
      drives: { energy: 10 },
      systemFeedback: 'Action failed: no water in machine',
    };

    const result = buildPassivePerception(input);

    expect(result.systemFeedback).toBe('Action failed: no water in machine');
  });

  it('systemFeedback is undefined when not provided', () => {
    const input: PassivePerceptionInput = {
      roomId: 'kitchen',
      objectsInRoom: [],
      drives: { energy: 10 },
    };

    const result = buildPassivePerception(input);

    expect(result.systemFeedback).toBeUndefined();
  });
});

describe('runPerception (AC-16, AC-19)', () => {
  let classifier: AffordanceClassifier;

  beforeEach(() => {
    classifier = makeClassifier();
  });

  it('returns a PerceptionResult with passive, prunedAffordances, and primaryDriveLabel — AC-16', async () => {
    const input: PerceptionCompileInput = {
      roomId: 'kitchen',
      objectsInRoom: [{ id: 'coffee-machine', name: 'Coffee Machine', type: 'appliance' }],
      drives: { energy: 10, hunger: 50, social: 80, comfort: 60, curiosity: 40 },
      primaryDriveLabel: 'low energy, need to restore energy',
      roomAffordances: [
        makeAffordance('brew_coffee', 'Brew coffee to restore energy'),
        makeAffordance('play_games', 'Play video games'),
      ],
    };

    const result: PerceptionResult = await runPerception(input, classifier);

    expect(result.primaryDriveLabel).toBe('low energy, need to restore energy');
    expect(result.passive.roomId).toBe('kitchen');
    expect(result.passive.objectsPresent[0]?.objectId).toBe('coffee-machine');

    // AC-16: prunedAffordances contains exactly the output of prune()
    // brew_coffee passes threshold, play_games does not
    expect(result.prunedAffordances).toHaveLength(1);
    expect(result.prunedAffordances[0]?.id).toBe('brew_coffee');
  });

  it('does NOT call LLMClient during perceive — AC-19', async () => {
    // The perceive phase functions do not accept or use an LLMClient.
    // If they work without any LLM client being provided, they don't call one.
    const input: PerceptionCompileInput = {
      roomId: 'kitchen',
      objectsInRoom: [],
      drives: { energy: 10 },
      primaryDriveLabel: 'low energy, need to restore energy',
      roomAffordances: [],
    };

    // This should complete without any LLM client — no error, no LLM call
    const result = await runPerception(input, classifier);

    expect(result).toBeDefined();
    expect(result.prunedAffordances).toEqual([]);
  });
});

describe('PerceptionBuilderImpl (AC-18)', () => {
  it('build returns LLMContextPayload with availableAffordances set to pruned list', () => {
    const prunedAffordances = [makeAffordance('brew_coffee', 'Brew coffee to restore energy')];
    const perceptionResult: PerceptionResult = {
      passive: {
        roomId: 'kitchen',
        objectsPresent: [{ objectId: 'coffee-machine', name: 'Coffee Machine', type: 'appliance' }],
        drives: { energy: 10, hunger: 50, social: 80, comfort: 60, curiosity: 40 },
      },
      prunedAffordances,
      primaryDriveLabel: 'low energy, need to restore energy',
    };

    const builder = new PerceptionBuilderImpl();
    const payload = builder.build(perceptionResult);

    expect(payload.availableAffordances).toBe(prunedAffordances);
  });

  it('build returns LLMContextPayload with perceptionContext containing room name and object names', () => {
    const perceptionResult: PerceptionResult = {
      passive: {
        roomId: 'kitchen',
        objectsPresent: [
          { objectId: 'coffee-machine', name: 'Coffee Machine', type: 'appliance' },
          { objectId: 'table', name: 'Table', type: 'furniture' },
        ],
        drives: { energy: 10, hunger: 50, social: 80, comfort: 60, curiosity: 40 },
      },
      prunedAffordances: [],
      primaryDriveLabel: 'low energy, need to restore energy',
    };

    const builder = new PerceptionBuilderImpl();
    const payload = builder.build(perceptionResult);

    // perceptionContext should contain the room identifier and object names
    expect(payload.perceptionContext).toContain('kitchen');
    expect(payload.perceptionContext).toContain('Coffee Machine');
    expect(payload.perceptionContext).toContain('Table');
  });

  it('build returns LLMContextPayload with responseSchema set to llmActionResponseSchema', () => {
    const perceptionResult: PerceptionResult = {
      passive: {
        roomId: 'kitchen',
        objectsPresent: [],
        drives: { energy: 10 },
      },
      prunedAffordances: [],
      primaryDriveLabel: 'low energy, need to restore energy',
    };

    const builder = new PerceptionBuilderImpl();
    const payload = builder.build(perceptionResult);

    expect(payload.responseSchema).toBe(llmActionResponseSchema);
  });

  it('build returns LLMContextPayload with a non-empty systemPrompt', () => {
    const perceptionResult: PerceptionResult = {
      passive: {
        roomId: 'kitchen',
        objectsPresent: [],
        drives: { energy: 10 },
      },
      prunedAffordances: [],
      primaryDriveLabel: 'low energy, need to restore energy',
    };

    const builder = new PerceptionBuilderImpl();
    const payload = builder.build(perceptionResult);

    expect(payload.systemPrompt).toBeTruthy();
    expect(typeof payload.systemPrompt).toBe('string');
  });

  it('build returns LLMContextPayload with cognitiveTools array', () => {
    const perceptionResult: PerceptionResult = {
      passive: {
        roomId: 'kitchen',
        objectsPresent: [],
        drives: { energy: 10 },
      },
      prunedAffordances: [],
      primaryDriveLabel: 'low energy, need to restore energy',
    };

    const builder = new PerceptionBuilderImpl();
    const payload = builder.build(perceptionResult);

    expect(payload.cognitiveTools).toBeDefined();
    expect(Array.isArray(payload.cognitiveTools)).toBe(true);
    expect(payload.cognitiveTools.length).toBeGreaterThan(0);
  });

  it('perceptionContext includes a drive summary', () => {
    const perceptionResult: PerceptionResult = {
      passive: {
        roomId: 'kitchen',
        objectsPresent: [],
        drives: { energy: 10, hunger: 50, social: 80, comfort: 60, curiosity: 40 },
      },
      prunedAffordances: [],
      primaryDriveLabel: 'low energy, need to restore energy',
    };

    const builder = new PerceptionBuilderImpl();
    const payload = builder.build(perceptionResult);

    // Drive summary should be compact — just key=value pairs
    expect(payload.perceptionContext).toContain('energy');
    expect(payload.perceptionContext).toContain('10');
  });

  it('does NOT call LLMClient during build — AC-19', () => {
    // PerceptionBuilder.build is synchronous and does not use any LLM client.
    const perceptionResult: PerceptionResult = {
      passive: {
        roomId: 'kitchen',
        objectsPresent: [],
        drives: { energy: 10 },
      },
      prunedAffordances: [],
      primaryDriveLabel: 'low energy, need to restore energy',
    };

    const builder = new PerceptionBuilderImpl();
    // Should work without any LLM client — synchronous, no LLM call
    const payload = builder.build(perceptionResult);

    expect(payload).toBeDefined();
  });
});
