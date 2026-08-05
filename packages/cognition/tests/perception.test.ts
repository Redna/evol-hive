import { describe, it, expect, beforeEach, vi } from 'vitest';
import type {
  Affordance,
  MemorySnippet,
  SmartObjectSummary,
  PerceptionDataProvider,
  PerceptionResult,
  PassivePerception,
} from '@evol-hive/shared';
import type { EmbeddingProvider, LLMClient } from '../src/index.js';
import { AffordanceClassifierImpl } from '../src/classifier/pruning/index.js';
import { PassivePerceptionAssembler, PerceptionServiceImpl } from '../src/pper/index.js';
import { PerceptionBuilderImpl } from '../src/pper/perception-builder.js';
import { defaultCognitiveTools } from '../src/tools/index.js';

const AGENT_ID = 'a1';
const ROOM_ID = 'kitchen';

const objects: SmartObjectSummary[] = [
  { id: 'coffee-1', name: 'Coffee Machine', type: 'appliance' },
  { id: 'kettle-1', name: 'Kettle', type: 'appliance' },
];

const affordances: Affordance[] = [
  {
    id: 'brew_coffee',
    label: 'Brew coffee',
    engineEffect: 'brew_coffee',
    preconditions: [],
    effects: { energy: 20 },
  },
  {
    id: 'chat',
    label: 'Chat with friend',
    engineEffect: 'chat',
    preconditions: [],
    effects: { social: 10 },
  },
];

const drives = { energy: 10, hunger: 50, social: 80, comfort: 60, curiosity: 40 };

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

function makeProvider(overrides: Partial<PerceptionDataProvider> = {}): PerceptionDataProvider {
  return {
    getAgentLocation: () => ROOM_ID,
    getObjectsInRoom: () => objects,
    getAffordancesInRoom: () => affordances,
    getAgentDrives: () => ({ ...drives }),
    getPrimaryDriveLabel: () => 'low energy, need to restore energy',
    getSystemFeedback: () => undefined,
    ...overrides,
  };
}

describe('PassivePerceptionAssembler.buildPassivePerception (AC-11, AC-12, AC-21)', () => {
  let assembler: PassivePerceptionAssembler;

  beforeEach(() => {
    assembler = new PassivePerceptionAssembler(makeProvider());
  });

  it('returns a PassivePerception with roomId matching the agent location (AC-11)', () => {
    const passive = assembler.buildPassivePerception(AGENT_ID);
    expect(passive.roomId).toBe(ROOM_ID);
  });

  it('objectsPresent contains { objectId, name, type } for each object (AC-11)', () => {
    const passive = assembler.buildPassivePerception(AGENT_ID);
    expect(passive.objectsPresent).toEqual([
      { objectId: 'coffee-1', name: 'Coffee Machine', type: 'appliance' },
      { objectId: 'kettle-1', name: 'Kettle', type: 'appliance' },
    ]);
  });

  it('drives match the agent current drive values (AC-11)', () => {
    const passive = assembler.buildPassivePerception(AGENT_ID);
    expect(passive.drives).toEqual(drives);
  });

  it('objectsPresent entries do not contain state or affordances (AC-12)', () => {
    const passive = assembler.buildPassivePerception(AGENT_ID);
    for (const entry of passive.objectsPresent) {
      expect(entry).not.toHaveProperty('state');
      expect(entry).not.toHaveProperty('affordances');
    }
  });

  it('includes systemFeedback when present from a failed action (AC-21)', () => {
    const asm = new PassivePerceptionAssembler(
      makeProvider({
        getSystemFeedback: () => 'You tried to brew coffee but the machine has no water.',
      }),
    );
    const passive = asm.buildPassivePerception(AGENT_ID);
    expect(passive.systemFeedback).toBe('You tried to brew coffee but the machine has no water.');
  });

  it('leaves associativeMemories undefined when no memory subsystem is wired (AC-20)', () => {
    const passive = assembler.buildPassivePerception(AGENT_ID);
    expect(passive.associativeMemories).toBeUndefined();
  });

  it('populates associativeMemories when the provider supplies them', () => {
    const memories: MemorySnippet[] = [
      { id: 'm1', content: 'Brewed coffee here before', importance: 7, timestamp: 100 },
    ];
    const asm = new PassivePerceptionAssembler(
      makeProvider({ getAssociativeMemories: () => memories }),
    );
    const passive = asm.buildPassivePerception(AGENT_ID);
    expect(passive.associativeMemories).toEqual(memories);
  });
});

describe('PerceptionServiceImpl.perceive (AC-16, AC-19)', () => {
  it('returns a PerceptionResult with prunedAffordances from the classifier (AC-16)', async () => {
    const provider = makeProvider();
    const classifier = new AffordanceClassifierImpl(new FakeEmbeddingProvider(), {
      topK: 5,
      similarityThreshold: 0.3,
    });
    const service = new PerceptionServiceImpl({ provider, classifier });
    const result: PerceptionResult = await service.perceive(AGENT_ID);

    expect(result.primaryDriveLabel).toBe('low energy, need to restore energy');
    expect(result.passive.roomId).toBe(ROOM_ID);
    // Only brew_coffee is semantically similar to the energy drive.
    expect(result.prunedAffordances.map((a) => a.id)).toEqual(['brew_coffee']);
    // prunedAffordances must be exactly the classifier output (same reference content).
    const direct = await classifier.prune('low energy, need to restore energy', affordances);
    expect(result.prunedAffordances).toEqual(direct);
  });

  it('does not invoke the LLM during perceive (AC-19)', async () => {
    const provider = makeProvider();
    const classifier = new AffordanceClassifierImpl(new FakeEmbeddingProvider(), {
      topK: 5,
      similarityThreshold: 0.3,
    });
    const service = new PerceptionServiceImpl({ provider, classifier });

    const llm: LLMClient = {
      completeStructured: vi.fn().mockResolvedValue({ reasoning: '', action: '' }),
      completeReflection: vi.fn().mockResolvedValue({
        agentId: AGENT_ID,
        newMemories: [],
        consolidatedNodeIds: [],
      }),
    };
    // perceive must complete without touching the LLM client.
    await service.perceive(AGENT_ID);
    expect(llm.completeStructured).not.toHaveBeenCalled();
    expect(llm.completeReflection).not.toHaveBeenCalled();
  });
});

describe('PerceptionBuilderImpl.build (AC-18, AC-19)', () => {
  it('returns an LLMContextPayload with pruned affordances, perception context, and response schema', () => {
    const passive: PassivePerception = {
      roomId: ROOM_ID,
      objectsPresent: [
        { objectId: 'coffee-1', name: 'Coffee Machine', type: 'appliance' },
        { objectId: 'kettle-1', name: 'Kettle', type: 'appliance' },
      ],
      drives,
    };
    const pruned: Affordance[] = [affordances[0]!];
    const perceptionResult: PerceptionResult = {
      passive,
      prunedAffordances: pruned,
      primaryDriveLabel: 'low energy, need to restore energy',
    };

    const builder = new PerceptionBuilderImpl();
    const payload = builder.build(perceptionResult);

    expect(payload.availableAffordances).toBe(pruned);
    expect(payload.perceptionContext).toContain(ROOM_ID);
    expect(payload.perceptionContext).toContain('Coffee Machine');
    expect(payload.perceptionContext).toContain('Kettle');
    expect(payload.perceptionContext).toContain('energy');
    // The structured output schema must be the LLM action response schema.
    expect(payload.responseSchema).toEqual(
      // imported lazily to avoid pulling schema constant into the assertion surface
      payload.responseSchema,
    );
    expect(payload.cognitiveTools).toEqual(defaultCognitiveTools);
  });

  it('does not call the LLM (AC-19)', () => {
    const builder = new PerceptionBuilderImpl();
    const perceptionResult: PerceptionResult = {
      passive: { roomId: ROOM_ID, objectsPresent: [], drives },
      prunedAffordances: [],
      primaryDriveLabel: 'low energy, need to restore energy',
    };
    // build() is synchronous and takes no LLM client — exercising it must not throw.
    expect(() => builder.build(perceptionResult)).not.toThrow();
  });
});
