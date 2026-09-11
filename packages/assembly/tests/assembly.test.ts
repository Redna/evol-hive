/**
 * Spec 050 — Assembly Consolidation (issue #166): the promoted assembler
 * ────────────────────────────────────────────────────────────────────────────
 * `@evol-hive/assembly` is the composition root: the ONLY package allowed to
 * depend on both `@evol-hive/engine` and `@evol-hive/cognition` (ADR-0001 —
 * the two never import each other). `assembleWorld()` wires EVERYTHING the
 * two former assembly paths wired, jointly, in one call:
 *
 *   - engine wiring via `createEngineCore` (bridges, SocialManager ↔
 *     ConversationManager ↔ self-model, persistence, tick source, mutation
 *     funnel) — R2/R4;
 *   - the cognition stack (LLM client incl. USE_REAL_LLM selection, guardrails,
 *     System-0 classifier incl. USE_REAL_EMBEDDINGS, PPER orchestrator, token
 *     usage reporter), memory maintenance (decay + reflection), System 1
 *     (gate/heads/salience/outcome recorder) — R2;
 *   - `buildMemorySubsystem` moves with the assembler (R5) and is constructed
 *     BEFORE the engine core internally (the reflect bridge captures the
 *     store at construction);
 *   - scene data (`loadScene`, handler registration) stays CALLER-side via
 *     the `sceneSetup` hook — scene data, not wiring (spec 050 constraint).
 *
 * Acceptance criteria covered here:
 *   - AC-2 (R4): default-path conversation completeness — `talk_to` through
 *     the production executor opens a real thread in `core.conversationManager`
 *     (instance identity — no second manager), the spec 043 pending-address
 *     query is non-empty for the addressee, and spec 044 reciprocity counts
 *     replies exactly once per direction.
 *   - AC-1 partial (R2/R5): `buildMemorySubsystem` is exported from
 *     `@evol-hive/assembly`; the assembler builds the memory subsystem before
 *     `createEngineCore` when none is supplied (persistence exists ⇒ the
 *     vector store reached the engine core); the caller-supplied subsystem is
 *     the SAME instance that flows into the stack.
 *   - R2: `sceneSetup` runs between `createEngineCore` and loop assembly
 *     (scene-level scheduler config from `loadScene` is consumed by the
 *     scheduler); no optional wires are left to the caller.
 *
 * Deterministic throughout — no external LLM (the mock-mode tests run zero
 * network calls; the real-LLM path constructs `OpenAICompatibleLLMClient`
 * but this suite never lets a cycle reach the HTTP layer).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type {
  Affordance,
  AgentProfile,
  EngineConfig,
  FormulatePlanResult,
  LLMActionResponse,
  PPERCycleOutcome,
  PPERPhase,
  ReflectLLMResponse,
  ReflectionResult,
  SceneDefinition,
} from '@evol-hive/shared';
import type { AffordanceClassifier, LLMClient, LLMContextPayload } from '@evol-hive/cognition';
import {
  PPEROrchestratorImpl,
  OpenAICompatibleLLMClient,
  PerceptionServiceImpl,
  PerceptionBuilderImpl,
  AffordanceClassifierImpl,
  ReactGateHead,
  LinearImportanceHead,
} from '@evol-hive/cognition';
import type { EngineCore } from '@evol-hive/engine';
import { loadScene } from '@evol-hive/engine';
import { assembleWorld, buildMemorySubsystem, MockOrchestrator } from '@evol-hive/assembly';
import type { AssembledWorld, MemorySubsystem } from '@evol-hive/assembly';

// ── Env hygiene ──────────────────────────────────────────────────────────────

const ENV_KEYS = ['USE_REAL_LLM', 'USE_REAL_EMBEDDINGS', 'ENGINE_MAX_CONCURRENT_LLM'] as const;

beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  vi.restoreAllMocks();
});

// ── Helpers ──────────────────────────────────────────────────────────────────

const ROOM = 'garden';

function makeConfig(maxConcurrentLLM = 8): EngineConfig {
  return {
    fps: 30,
    spatialDebounceSeconds: 2,
    maxConcurrentLLM,
    guardrailsEnabled: true,
    guardrails: { affordanceMasking: true, contextualForcing: true, planValidation: true },
  };
}

function makeProfile(id: string): AgentProfile {
  return { id, name: id, description: `agent ${id}`, traits: [], initialDrives: {} };
}

/** Spawn a co-located pair (scene data — done inside `sceneSetup`). */
function spawnCoLocatedPair(core: EngineCore, room = ROOM): void {
  core.agentManager.spawn(makeProfile('agent-a'));
  core.agentManager.spawn(makeProfile('agent-b'));
  core.agentManager.updateState('agent-a', { location: room, lastPerceptionTick: 0 });
  core.agentManager.updateState('agent-b', { location: room, lastPerceptionTick: 0 });
}

/** A pass-through classifier (no embeddings, no network). */
function stubClassifier(): AffordanceClassifier {
  return { prune: async (_driveLabel: string, affordances: Affordance[]) => affordances };
}

/**
 * The real Perceive phase over a production-assembled provider — the exact
 * components the PPER orchestrator builds internally (spec 045 QA pattern).
 */
async function renderPerception(core: EngineCore, agentId: string): Promise<string> {
  const service = new PerceptionServiceImpl({
    provider: core.bridges.perception,
    classifier: stubClassifier(),
  });
  const builder = new PerceptionBuilderImpl();
  const perception = await service.perceive(agentId);
  return builder.build(perception).perceptionContext;
}

/** Generic no-network mock LLM (the assembler's own default, re-declared here). */
class GenericMockLLM implements LLMClient {
  async completeStructured(_payload: LLMContextPayload): Promise<LLMActionResponse> {
    return { reasoning: 'Mock action.', action: 'observe' };
  }
  async completeReflection(): Promise<ReflectionResult> {
    return { agentId: 'mock', newMemories: [], consolidatedNodeIds: [] };
  }
  async completePlan(): Promise<FormulatePlanResult> {
    return {
      description: 'Observe the environment',
      steps: [{ description: 'Observe', targetAffordance: 'observe' }],
    };
  }
  async completeReflect(): Promise<ReflectLLMResponse> {
    return { memoryContent: 'Observed the environment.' };
  }
}

// ── R2: one call, fully wired ────────────────────────────────────────────────

describe('spec 050 R2 — assembleWorld wires everything jointly, one call', () => {
  it('mock-driven mode (mockLLMClient) yields the full cognition stack: orchestrator, guardrail, decay + reflection, token reporter', () => {
    const world = assembleWorld({
      config: makeConfig(),
      mockLLMClient: new GenericMockLLM(),
    });
    expect(world.stack).toBeDefined();
    const stack = world.stack!;
    expect(stack.orchestrator).toBeDefined();
    expect(stack.llmClient).toBeInstanceOf(GenericMockLLM);
    expect(stack.guardrail).toBeDefined();
    expect(stack.classifier).toBeDefined();
    expect(stack.embeddingProvider).toBeDefined();
    expect(stack.vectorStore).toBeDefined();
    expect(stack.memoryDecayService).toBeDefined();
    expect(stack.reflectionLoop).toBeDefined();
    expect(stack.decayConfig).toBeDefined();
    expect(stack.tokenUsageReporter).toBeDefined();
    // Social surface: the assembler reuses the core's SocialManager — the
    // single instance holding both roles (spec 045 R2/R3 invariant).
    expect(stack.socialManager).toBe(world.core.socialManager);
  });

  it('real-LLM mode selects OpenAICompatibleLLMClient and a real orchestrator', () => {
    process.env['USE_REAL_LLM'] = 'true';
    process.env['LLM_BASE_URL'] = 'http://localhost:11434/v1';
    const world = assembleWorld({ config: makeConfig() });
    expect(world.stack).toBeDefined();
    expect(world.stack!.llmClient).toBeInstanceOf(OpenAICompatibleLLMClient);
    expect(world.orchestrator).toBeInstanceOf(PPEROrchestratorImpl);
    expect(world.stack!.cognitiveToolExecutor).toBeDefined();
  });

  it('no-op mode (no env, no mock client) runs no cycles — parity with the former NoopOrchestrator mock path', async () => {
    const world: AssembledWorld = assembleWorld({ config: makeConfig() });
    expect(world.stack).toBeUndefined();
    expect(world.orchestrator).toBeInstanceOf(MockOrchestrator);
    expect(world.orchestrator).not.toBeInstanceOf(PPEROrchestratorImpl);
    // No memory subsystem, no maintenance — exactly the former mock-mode shape.
    expect(world.memory).toBeUndefined();
    expect(world.core.persistence).toBeUndefined();
    const outcome: PPERCycleOutcome = await world.orchestrator.runCycle('agent-a');
    expect(outcome.appliedDriveChanges).toBe(false);
    expect(world.orchestrator.getPhase('agent-a')).toBe('perceive');
  });

  it('sceneSetup runs between createEngineCore and loop assembly: scene data lands, per-scene scheduler config is consumed', () => {
    const order: string[] = [];
    const scene: SceneDefinition = {
      id: 'tiny',
      name: 'Tiny',
      maxConcurrentCycles: 2,
      rooms: [
        { id: 'garden', name: 'Garden', description: '', connections: [], objectIds: ['bench-1'] },
      ],
      objects: [
        {
          id: 'bench-1',
          name: 'Bench',
          type: 'furniture',
          state: {},
          affordances: [
            {
              id: 'observe',
              label: 'Observe',
              engineEffect: 'observe',
              preconditions: [],
              effects: {},
            },
          ],
          roomId: 'garden',
        },
      ],
      agents: [makeProfile('agent-a')],
    };
    const world = assembleWorld({
      config: makeConfig(8),
      mockLLMClient: new GenericMockLLM(),
      sceneSetup: (core) => {
        order.push('sceneSetup');
        // Scene data stays caller-side (spec 050 constraint): loadScene +
        // handler registration happen here, between the core and the loop.
        loadScene(core, scene);
        core.affordanceRegistry.registerHandler('observe', async () => ({ success: true }));
      },
    });
    expect(order).toEqual(['sceneSetup']);
    const core = world.core;
    expect(core.sceneManager.getAllRooms()).toHaveLength(1);
    expect(core.agentManager.getState('agent-a')).not.toBeNull();
    expect(core.affordanceRegistry.getHandler('observe')).not.toBeNull();
    // The loop was assembled AFTER the scene landed (spec 022 per-scene
    // scheduler override from SceneDefinition.maxConcurrentCycles wins).
    expect(core.scheduler).toBeDefined();
    expect(core.scheduler!.maxConcurrentCycles).toBe(2);
  });
});

// ── R5: buildMemorySubsystem moves with the assembler ────────────────────────

describe('spec 050 R5 — memory subsystem is assembled, not consumer-wired', () => {
  it('buildMemorySubsystem is exported from @evol-hive/assembly (moved out of examples/)', () => {
    const memory: MemorySubsystem = buildMemorySubsystem();
    expect(memory.embeddingProvider).toBeDefined();
    expect(memory.vectorStore).toBeDefined();
    expect(memory.memoryStore).toBeDefined();
  });

  it('the assembler builds the subsystem BEFORE createEngineCore when none is supplied (persistence exists ⇒ vector store reached the core)', () => {
    const world = assembleWorld({ config: makeConfig(), mockLLMClient: new GenericMockLLM() });
    expect(world.memory).toBeDefined();
    expect(world.memory!.vectorStore).toBe(world.stack!.vectorStore);
    // The engine core received the vector store at construction (spec 017
    // persistence is only created when a VectorStore is provided).
    expect(world.core.persistence).toBeDefined();
  });

  it('a caller-supplied subsystem is the exact instance flowing core-ward (no second store)', () => {
    const memory = buildMemorySubsystem();
    const world = assembleWorld({
      config: makeConfig(),
      mockLLMClient: new GenericMockLLM(),
      memory,
    });
    expect(world.memory).toBe(memory);
    expect(world.stack!.vectorStore).toBe(memory.vectorStore);
    expect(world.stack!.embeddingProvider).toBe(memory.embeddingProvider);
    expect(world.core.persistence).toBeDefined();
  });
});

// ── AC-2 (R4): default-path conversation completeness ────────────────────────

describe('spec 050 AC-2 — conversation bridge + urge surfaces wired by the default path', () => {
  let world: AssembledWorld;

  beforeEach(() => {
    process.env['USE_REAL_LLM'] = 'true'; // the executor is built on the real-LLM path
    world = assembleWorld({
      config: makeConfig(),
      sceneSetup: (core) => spawnCoLocatedPair(core),
      wireMemoryMaintenance: false,
    });
    expect(world.stack?.cognitiveToolExecutor).toBeDefined();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('talk_to via the PRODUCTION executor opens a thread in the core’s ConversationManagerImpl — instance identity, no second manager', async () => {
    const { core, stack } = world;
    const result = await stack!.cognitiveToolExecutor!.executeTalkTo(
      'agent-a',
      'agent-b',
      'Where do you get good beans?',
      'neutral',
    );
    expect(result.success).toBe(true);
    // R4: the conversation path ran through the DEFAULT wiring.
    expect(result.conversationUpdated).toBe(true);
    // Identity: the thread exists in the CORE's manager — a second manager
    // would leave this empty (the exact #165 drift shape).
    const convs = core.conversationManager.listConversationsInRoom(ROOM);
    expect(convs.length).toBeGreaterThan(0);
    expect(convs[0]!.turns[0]!.content).toBe('Where do you get good beans?');
    // The single SocialManager instance is the core's own.
    expect(stack!.socialManager).toBe(core.socialManager);
    // …and sees the same thread (one graph of state — no forked manager).
    const viaSocial = stack!.socialManager.getOpenConversationBetween('agent-a', 'agent-b');
    expect(viaSocial).not.toBeNull();
    expect(viaSocial!.id).toBe(convs[0]!.id);
  });

  it('getConversationsAwaitingAgentReply is non-empty for the addressee after a talk_to (spec 043 pending-address data)', async () => {
    const { core, stack } = world;
    await stack!.cognitiveToolExecutor!.executeTalkTo(
      'agent-a',
      'agent-b',
      'Where do you get good beans?',
      'neutral',
    );
    const awaiting = core.bridges.perception.getConversationsAwaitingAgentReply('agent-b');
    expect(awaiting.length).toBeGreaterThan(0);
    expect(awaiting[0]!.turns[awaiting[0]!.turns.length - 1]!.agentId).toBe('agent-a');
    // The speaker owes nothing to themselves.
    expect(core.bridges.perception.getConversationsAwaitingAgentReply('agent-a')).toHaveLength(0);
  });

  it('the addressee’s rendered perception quotes the pending-address line (spec 043 render clause, dynamic section only)', async () => {
    const { core, stack } = world;
    await stack!.cognitiveToolExecutor!.executeTalkTo(
      'agent-a',
      'agent-b',
      'Where do you get good beans?',
      'neutral',
    );
    const payloadB = await renderPerception(core, 'agent-b');
    expect(payloadB).toContain(
      'agent-a addressed you, awaiting response: "Where do you get good beans?"',
    );
    // Dynamic section only (spec 021 KV-cache rules).
    const lines = payloadB.split('\n');
    const separator = lines.indexOf('---');
    expect(separator).toBeGreaterThan(0);
    expect(lines.slice(separator + 1).join('\n')).toContain('awaiting response');
    expect(lines.slice(0, separator).join('\n')).not.toContain('awaiting response');
  });

  it('spec 044 urge reciprocity counts a real reply exactly once per direction through the default path', async () => {
    const { core, stack } = world;
    await stack!.cognitiveToolExecutor!.executeTalkTo(
      'agent-a',
      'agent-b',
      'hello there',
      'neutral',
    );
    await stack!.cognitiveToolExecutor!.executeTalkTo(
      'agent-b',
      'agent-a',
      'hello back',
      'positive',
    );
    const relA = stack!.socialManager.getRelationships('agent-a')['agent-b'];
    expect(relA!.sentCount).toBe(1);
    expect(relA!.receivedCount).toBe(1);
    const relB = stack!.socialManager.getRelationships('agent-b')['agent-a'];
    expect(relB!.receivedCount).toBe(1);
    expect(relB!.sentCount).toBe(1);
  });
});

// ── R2: env-driven classifier selection ─────────────────────────────────────

describe('spec 050 R2 — USE_REAL_EMBEDDINGS classifier selection happens inside the assembler', () => {
  it('USE_REAL_EMBEDDINGS=true selects the real AffordanceClassifierImpl (System-0 pruner over the assembler\'s provider)', () => {
    process.env['USE_REAL_EMBEDDINGS'] = 'true';
    const world = assembleWorld({ config: makeConfig(), mockLLMClient: new GenericMockLLM() });
    expect(world.stack).toBeDefined();
    // Construction is lazy (spec 007: file I/O deferred to embed()/ready()) —
    // asserting the selection never touches the network or the model file.
    expect(world.stack!.classifier).toBeInstanceOf(AffordanceClassifierImpl);
  });

  it('without the env var the classifier is the assembler\'s mock (env read ONLY in the assembler — spec 027 AC-9)', () => {
    const world = assembleWorld({ config: makeConfig(), mockLLMClient: new GenericMockLLM() });
    expect(world.stack!.classifier).toBeDefined();
    expect(world.stack!.classifier).not.toBeInstanceOf(AffordanceClassifierImpl);
  });
});

// ── R2: System 1 trainable heads through the assembler (spec 035) ────────────

describe('spec 050 R2 — System 1 wiring via the assembleWorld system1 option', () => {
  it('mock-LLM mode + system1: gate, importance head, feature service, outcome recorder, salience + sample log all wired', () => {
    const world = assembleWorld({
      config: makeConfig(),
      mockLLMClient: new GenericMockLLM(),
      system1: {},
    });
    expect(world.system1).toBeDefined();
    const s1 = world.system1!;
    expect(s1.gate).toBeDefined();
    expect(s1.outcomeRecorder).toBeDefined();
    expect(s1.featureRefresher).toBeDefined();
    expect(s1.gateHead).toBeInstanceOf(ReactGateHead);
    expect(s1.importanceHead).toBeInstanceOf(LinearImportanceHead);
    expect(s1.salience).toBeDefined();
    expect(s1.sampleLog).toBeDefined();
    expect(typeof s1.hotSwapGateArtifact).toBe('function');
    // The engine-side outcome tracker was attached to the core — the loop's
    // outcome probe reads engine state through it (spec 035 R4).
    expect(world.core.system1Tracker).toBeDefined();
  });

  it('no-op mock mode + system1: the memory subsystem is still built (it reaches the core\'s persistence), the no-op orchestrator is kept, no cognition stack', () => {
    const world = assembleWorld({ config: makeConfig(), system1: {} });
    expect(world.stack).toBeUndefined();
    expect(world.orchestrator).toBeInstanceOf(MockOrchestrator);
    // AssembledWorld.memory stays undefined in no-op mode (interface contract),
    // but the subsystem WAS built for the System 1 heads — provable via the
    // persistence the engine core created from the vector store (spec 017).
    expect(world.core.persistence).toBeDefined();
    expect(world.system1).toBeDefined();
    expect(world.system1!.gateHead).toBeInstanceOf(ReactGateHead);
    expect(world.core.system1Tracker).toBeDefined();
  });

  it('default (no system1 option): no System 1 ports wired — the pre-035 scheduler shape is untouched', () => {
    const world = assembleWorld({ config: makeConfig(), mockLLMClient: new GenericMockLLM() });
    expect(world.system1).toBeUndefined();
    expect(world.core.system1Tracker).toBeUndefined();
  });
});
