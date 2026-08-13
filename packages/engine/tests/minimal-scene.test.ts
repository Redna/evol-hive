/**
 * Tests for the minimal scene entry point (examples/minimal-scene.ts).
 * Covers AC-18, AC-19, AC-20, AC-21, AC-22.
 */
import { describe, it, expect } from 'vitest';
import {
  MINIMAL_SCENE,
  MockLLMClient,
  MockEmbeddingProvider,
  buildMinimalEngine,
} from '../../../examples/minimal-scene.ts';

describe('Minimal scene definition (AC-18)', () => {
  it('defines one room "kitchen"', () => {
    expect(MINIMAL_SCENE.rooms).toHaveLength(1);
    expect(MINIMAL_SCENE.rooms[0]?.id).toBe('kitchen');
  });

  it('defines one SmartObject CoffeeMachine with a brew_coffee affordance', () => {
    expect(MINIMAL_SCENE.objects).toHaveLength(1);
    const obj = MINIMAL_SCENE.objects[0]!;
    expect(obj.id).toBe('coffee-1');
    const aff = obj.affordances.find((a) => a.id === 'brew_coffee');
    expect(aff).toBeDefined();
    // Also has observe affordance.
    expect(obj.affordances.find((a) => a.id === 'observe')).toBeDefined();
  });

  it('defines one AgentProfile with energy: 20', () => {
    expect(MINIMAL_SCENE.agents).toHaveLength(1);
    expect(MINIMAL_SCENE.agents[0]?.id).toBe('agent-1');
    expect(MINIMAL_SCENE.agents[0]?.initialDrives.energy).toBe(20);
  });
});

describe('Mock LLM client (AC-21)', () => {
  it('completePlan returns a FormulatePlanResult with a step targeting brew_coffee', async () => {
    const llm = new MockLLMClient();
    const result = await llm.completePlan({
      systemPrompt: '',
      perceptionContext: '',
      availableAffordances: [],
      cognitiveTools: [],
      responseSchema: {},
    });
    expect(result.description).toBeTruthy();
    expect(result.steps.length).toBeGreaterThan(0);
    expect(result.steps.some((s) => s.targetAffordance === 'brew_coffee')).toBe(true);
  });

  it('completeReflect returns a ReflectLLMResponse with a memoryEntry of type "action" and importance 5', async () => {
    const llm = new MockLLMClient();
    const resp = await llm.completeReflect({
      systemPrompt: '',
      perceptionContext: '',
      availableAffordances: [],
      cognitiveTools: [],
      responseSchema: {},
    });
    expect(resp.memoryEntry).toBeDefined();
    expect(resp.memoryEntry?.type).toBe('action');
    expect(resp.memoryEntry?.importance).toBe(5);
  });

  it('implements completeStructured and completeReflection for interface completeness', async () => {
    const llm = new MockLLMClient();
    const structured = await llm.completeStructured({
      systemPrompt: '',
      perceptionContext: '',
      availableAffordances: [],
      cognitiveTools: [],
      responseSchema: {},
    });
    expect(structured).toBeDefined();
    expect(typeof structured.action).toBe('string');
    const reflection = await llm.completeReflection('', []);
    expect(reflection).toBeDefined();
  });
});

describe('Mock embedding provider (AC-22, spec-007 AC-17)', () => {
  it('embed returns a number[] of the correct dimensionality without network calls', async () => {
    const embedder = new MockEmbeddingProvider();
    const vec = await embedder.embed('hello world');
    expect(Array.isArray(vec)).toBe(true);
    expect(vec.length).toBe(embedder.dimensions);
    // Deterministic: same input → same output.
    const vec2 = await embedder.embed('hello world');
    expect(vec).toEqual(vec2);
  });

  it('embedBatch returns number[][] with one vector per input, each of correct dimensionality (spec-007 AC-17)', async () => {
    const embedder = new MockEmbeddingProvider();
    const batch = await embedder.embedBatch(['hello', 'world', 'test']);
    expect(batch).toHaveLength(3);
    for (const vec of batch) {
      expect(vec).toHaveLength(embedder.dimensions);
    }
    // Deterministic: same input → same output.
    const batch2 = await embedder.embedBatch(['hello', 'world', 'test']);
    expect(batch).toEqual(batch2);
  });

  it('embedBatch([]) returns [] without error (spec-007 AC-17)', async () => {
    const embedder = new MockEmbeddingProvider();
    const result = await embedder.embedBatch([]);
    expect(result).toEqual([]);
  });
});

describe('Minimal engine assembly (AC-19, AC-20)', () => {
  it('buildMinimalEngine assembles the engine from the scene + mocks without errors', () => {
    const engine = buildMinimalEngine();
    expect(engine.gameLoop).toBeDefined();
    expect(engine.agentManager.getState('agent-1')).not.toBeNull();
    expect(engine.agentManager.getState('agent-1')?.location).toBe('kitchen');
  });

  it('after starting and stepping, the agent completes a PPER cycle and a log message is produced', async () => {
    const { gameLoop, agentManager } = buildMinimalEngine();
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));

    try {
      gameLoop.start();
      // Allow the fired-and-forgotten PPER cycle promise to resolve.
      await new Promise((r) => setTimeout(r, 50));
      gameLoop.stop();
    } finally {
      console.log = origLog;
    }

    const cycleLog = logs.find((l) => l.includes('completed PPER cycle'));
    expect(cycleLog).toBeDefined();
    expect(cycleLog).toContain('agent-1');
    // isThinking is false after the cycle.
    expect(agentManager.getState('agent-1')?.isThinking).toBe(false);
  });
});
