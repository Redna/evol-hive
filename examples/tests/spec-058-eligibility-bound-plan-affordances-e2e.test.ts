/**
 * Spec 058 — Eligibility-Bound Plan Affordances — REAL-SCENE E2E (QA gap-fill)
 * ════════════════════════════════════════════════════════════════════════════
 * The PR's suites pin the seams in isolation: the engine suite uses a tiny
 * synthetic garden (`trowel` + one conversation mirror), the assembly suite a
 * synthetic bench trio, and the cognition suite a hand-built perception. None
 * of them exercises the REAL `DYNAMIC_WORLD_SCENE` — the scene where the #206
 * skip storm was observed, and the scene whose `observe` collision across
 * every smart object is the exact motivation for spec 058 R2.
 *
 * This suite closes that gap: the REAL scene loaded into the REAL assembled
 * stack (`assembleWorld` → real `PerceptionDataProviderImpl` with the real
 * `ConversationManagerImpl` wired), the REAL production `PerceptionServiceImpl`
 * (which prefers `getVisibleAffordancesInRoom`), and the REAL `PlanBuilderImpl`
 * that enum-binds `prunedAffordances` — deterministic, no LLM (the client is
 * constructed but never invoked).
 *
 * Coverage:
 *   AC-4-RS (R1/R2/R3) — a CLOSED conversation is REMOVED from the registry and
 *     the room when it closes (issue #224; spec 033's "no unbounded growth"
 *     constraint), so none of join/contribute/leave can reach
 *     `prunedAffordances` or the `formulate_plan` enum, while the real
 *     non-conversation affordances survive. For an OPEN conversation the
 *     per-object eligibility filter — never a flat-id lookup — removes exactly
 *     the ineligible conversation copy (the R2 collision AC-3 protects).
 *   AC-1-RS (R1) — an open conversation: a participant's real value space
 *     yields contribute/leave (never join); a co-located bystander's yields
 *     join/observe (never contribute/leave).
 *   AC-7-RS (R1–R4, deterministic proxy) — the invariant the 40-minute live run
 *     judges: an agent with no eligible conversation never sees
 *     join/contribute/leave in any `[plan-enum]` line, across every agent and
 *     room of the #206 scene, while non-conversation affordances remain.
 *
 * AC-7's live half (the ≤25% skip-share arithmetic over 40 minutes against a
 * real LLM backend) stays on issue #206 as live evidence — it cannot be run in
 * CI; this suite pins the deterministic mechanism it observes.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Affordance, EngineConfig, PerceptionResult, ToolDefinition } from '@evol-hive/shared';
import type { AffordanceClassifier } from '@evol-hive/cognition';
import {
  PerceptionServiceImpl,
  PlanBuilderImpl,
  PPEROrchestratorImpl,
  logPlanEnumDiagnostic,
} from '@evol-hive/cognition';
import {
  loadScene,
  autoRegisterHandlers,
  clearHandlerPlugins,
  registerHandlerPlugin,
  createBuiltinPlugins,
} from '@evol-hive/engine';
import type { EngineCore } from '@evol-hive/engine';
import { assembleWorld } from '@evol-hive/assembly';
import type { AssembledWorld } from '@evol-hive/assembly';
import { DYNAMIC_WORLD_SCENE, createDynamicWorldHandlers } from '../dynamic-world.ts';

// ── Constants ────────────────────────────────────────────────────────────────

const GARDEN = 'garden';
const GREENHOUSE = 'greenhouse';

/** Conversation-affordance ids that are NOT declared by any scene object. */
const CONVERSATION_ONLY_IDS = ['join', 'contribute', 'leave'] as const;

/** Scene agents and their start rooms (spec 052 — the #206 population). */
const AGENT_ROOMS: ReadonlyArray<readonly [string, string]> = [
  ['gardener-1', GARDEN],
  ['iris-1', GREENHOUSE],
  ['apprentice-1', GREENHOUSE],
];

const ENV_KEYS = [
  'USE_REAL_LLM',
  'USE_REAL_EMBEDDINGS',
  'ENGINE_MAX_CONCURRENT_LLM',
  'SCENE_DURATION_MS',
  'SYSTEM1_GATE_ARTIFACT',
] as const;

beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  vi.restoreAllMocks();
});

// ── Fixtures — the production wiring, mirroring dynamic-world-sim.ts ─────────

function makeConfig(): EngineConfig {
  return {
    fps: 60,
    spatialDebounceSeconds: 5,
    maxConcurrentLLM: 8,
    guardrailsEnabled: true,
    guardrails: { affordanceMasking: true, contextualForcing: true, planValidation: true },
  };
}

/** Load the real #206 scene + its handlers (the sim's `sceneSetup`). */
function sceneSetup(core: EngineCore): void {
  loadScene(core, DYNAMIC_WORLD_SCENE);
  clearHandlerPlugins();
  for (const plugin of createBuiltinPlugins()) {
    registerHandlerPlugin(plugin);
  }
  autoRegisterHandlers(core, DYNAMIC_WORLD_SCENE);
  for (const [effect, handler] of Object.entries(createDynamicWorldHandlers())) {
    core.affordanceRegistry.registerHandler(effect, handler);
  }
}

function buildScene(): AssembledWorld {
  process.env['USE_REAL_LLM'] = 'true'; // the production executor/LLM wiring
  return assembleWorld({ config: makeConfig(), sceneSetup, wireMemoryMaintenance: false });
}

const stubClassifier: AffordanceClassifier = {
  prune: async (_driveLabel: string, affordances: Affordance[]) => affordances,
};

/** The real Perceive phase over the production (conversation-wired) provider. */
async function perceive(core: EngineCore, agentId: string): Promise<PerceptionResult> {
  const service = new PerceptionServiceImpl({
    provider: core.bridges.perception,
    classifier: stubClassifier,
  });
  return service.perceive(agentId);
}

function prunedIds(perception: PerceptionResult): string[] {
  return perception.prunedAffordances.map((a) => a.id);
}

/** The `formulate_plan` `targetAffordance` enum (the offered value space). */
function formulateEnum(tools: ToolDefinition[]): string[] {
  const planTool = tools.find((t) => t.function.name === 'formulate_plan');
  const parameters = (planTool?.function.parameters ?? {}) as unknown as {
    properties?: {
      steps?: { items?: { properties?: { targetAffordance?: { enum?: string[] } } } };
    };
  };
  return parameters.properties?.steps?.items?.properties?.targetAffordance?.enum ?? [];
}

function toolNames(tools: ToolDefinition[]): string[] {
  return tools.map((t) => t.function.name);
}

/** Open the real conversation between the two greenhouse agents. */
async function openGreenhouseConversation(world: AssembledWorld): Promise<string> {
  const opened = await world.stack!.cognitiveToolExecutor!.executeTalkTo(
    'iris-1',
    'apprentice-1',
    'hello there',
    'neutral',
  );
  expect(opened.success).toBe(true);
  const conversation = world.core.conversationManager.listConversationsInRoom(GREENHOUSE)[0];
  expect(conversation, 'the production talk_to opened a greenhouse conversation').toBeDefined();
  return conversation!.id;
}

/** Count `observe` affordances the registry makes available in a room. */
function availableObserveCount(core: EngineCore, roomId: string): number {
  return core.smartObjectRegistry
    .getAvailableAffordancesInRoom(roomId)
    .filter((a) => a.id === 'observe').length;
}

// ── AC-1-RS / AC-4-RS: the closed conversation (the skip-storm shape) ────────

describe('spec 058 E2E — a closed real conversation never reaches the plan value space', () => {
  it('a closed conversation is removed from the room — absence, not the filter (#224)', async () => {
    const world = buildScene();
    const conversationId = await openGreenhouseConversation(world);
    world.core.conversationManager.close(conversationId, 'qa-close');

    // Spec 033's constraint is "no unbounded growth anywhere". A mirror that
    // outlived its conversation accumulated one room object plus four
    // affordances per conversation ever opened — 62 dead mirrors in one
    // 26-minute run — so closing now undoes both halves of registration.
    expect(world.core.smartObjectRegistry.get(conversationId)).toBeNull();
    expect(world.core.sceneManager.getRoom(GREENHOUSE)!.objectIds).not.toContain(conversationId);

    const perception = await perceive(world.core, 'iris-1');
    const ids = prunedIds(perception);
    for (const id of CONVERSATION_ONLY_IDS) {
      expect(ids).not.toContain(id);
    }
    // Non-conversation greenhouse affordances survive (R1).
    expect(ids).toContain('rest_among_seedlings');
    expect(ids).toContain('pick_herbs');

    // With the mirror gone, every remaining `observe` is a non-conversation
    // one, so all of them survive.
    expect(ids.filter((id) => id === 'observe')).toHaveLength(
      availableObserveCount(world.core, GREENHOUSE),
    );

    // The plan tool enum and the affordance tool list consume the same set.
    const payload = new PlanBuilderImpl().build(perception);
    const enumIds = formulateEnum(payload.tools);
    for (const id of CONVERSATION_ONLY_IDS) {
      expect(enumIds).not.toContain(id);
    }
    expect(enumIds).toContain('rest_among_seedlings');
    const names = toolNames(payload.tools);
    for (const id of CONVERSATION_ONLY_IDS) {
      expect(names).not.toContain(id);
    }
  });

  it('a closed conversation leaves passive.objectsPresent — perception, not just the registry (#224 impact #2)', async () => {
    const world = buildScene();
    const conversationId = await openGreenhouseConversation(world);

    // The leak's second impact was perception pollution: the dead mirror stayed
    // in `passive.objectsPresent` and rode every prompt. An OPEN conversation
    // is perceivable; a CLOSED one must not be.
    const openPerception = await perceive(world.core, 'iris-1');
    expect(openPerception.passive.objectsPresent.map((o) => o.objectId)).toContain(conversationId);

    world.core.conversationManager.close(conversationId, 'qa-close');

    const closedPerception = await perceive(world.core, 'iris-1');
    expect(closedPerception.passive.objectsPresent.map((o) => o.objectId)).not.toContain(
      conversationId,
    );
    // Real scene objects are untouched.
    expect(closedPerception.passive.objectsPresent.length).toBeGreaterThan(0);
  });

  it('an OPEN conversation still exercises the R2 collision: only the ineligible copy is filtered', async () => {
    const world = buildScene();
    await openGreenhouseConversation(world);

    // A participant's conversation affordances are contribute/leave, so the
    // conversation mirror's own `observe` copy is offered-but-ineligible. That
    // is the same collision AC-3 protects, and it is still reachable now that
    // issue #224 removed the closed mirror that used to provide it.
    const perception = await perceive(world.core, 'iris-1');
    const ids = prunedIds(perception);

    expect(availableObserveCount(world.core, GREENHOUSE)).toBeGreaterThan(1);
    expect(ids.filter((id) => id === 'observe')).toHaveLength(
      availableObserveCount(world.core, GREENHOUSE) - 1,
    );
    // A flat-id lookup would drop the common `observe` affordance wholesale.
    expect(ids).toContain('rest_among_seedlings');
    expect(ids).toContain('pick_herbs');
    expect(ids).not.toContain('contribute'); // spec 064/D1
    expect(ids).not.toContain('join');
  });

  it('an agent in a conversation-free room sees no conversation affordance at all', async () => {
    const world = buildScene();
    const perception = await perceive(world.core, 'gardener-1');
    const ids = prunedIds(perception);
    for (const id of CONVERSATION_ONLY_IDS) {
      expect(ids).not.toContain(id);
    }
    expect(ids).toContain('plant_seeds');
  });
});

// ── AC-1-RS: the open conversation role projection on the real scene ─────────

describe('spec 058 E2E — real open conversation: participants vs bystanders', () => {
  it('participants yield contribute/leave (never join); a co-located bystander yields join/observe', async () => {
    const world = buildScene();
    await openGreenhouseConversation(world);

    for (const participant of ['iris-1', 'apprentice-1']) {
      const perception = await perceive(world.core, participant);
      const ids = prunedIds(perception);
      expect(ids).not.toContain('contribute'); // spec 064/D1
      expect(ids).toContain('leave');
      expect(ids).not.toContain('join');
      const enumIds = formulateEnum(new PlanBuilderImpl().build(perception).tools);
      expect(enumIds).not.toContain('contribute');
      expect(enumIds).not.toContain('join');
    }

    // Move the gardener into the greenhouse: a co-located non-participant.
    world.core.agentManager.updateState('gardener-1', { location: GREENHOUSE });
    const bystander = await perceive(world.core, 'gardener-1');
    const ids = prunedIds(bystander);
    expect(ids).toContain('join');
    expect(ids).toContain('observe');
    expect(ids).not.toContain('contribute');
    expect(ids).not.toContain('leave');
    const enumIds = formulateEnum(new PlanBuilderImpl().build(bystander).tools);
    expect(enumIds).toContain('join');
    expect(enumIds).not.toContain('contribute');
  });
});

// ── AC-7-RS: the deterministic invariant the live run judges ─────────────────

describe('spec 058 E2E — every [plan-enum] line is free of ineligible conversation affordances', () => {
  it('across every #206 agent/room, the offered enum carries none of join/contribute/leave', async () => {
    const world = buildScene();
    const logs: string[] = [];
    vi.mocked(console.log).mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });

    for (const [agentId, roomId] of AGENT_ROOMS) {
      const perception = await perceive(world.core, agentId);
      expect(perception.passive.roomId).toBe(roomId);
      // The real orchestrator seam's diagnostic, exercised against the real
      // perception (this is the line AC-7 greps in the 40-minute run).
      logPlanEnumDiagnostic(agentId, perception, undefined);
    }

    const planEnumLines = logs.filter((l) => l.includes('[plan-enum]'));
    expect(planEnumLines).toHaveLength(AGENT_ROOMS.length);
    for (const line of planEnumLines) {
      for (const id of CONVERSATION_ONLY_IDS) {
        expect(line).not.toContain(id);
      }
    }
    // Non-conversation affordances still ride the offered enum.
    expect(planEnumLines.join('\n')).toContain('observe');
  });

  it('a full deterministic orchestrator cycle over a CLOSED real conversation emits one clean [plan-enum] line', async () => {
    const world = buildScene();
    const conversationId = await openGreenhouseConversation(world);
    world.core.conversationManager.close(conversationId, 'qa-close');

    const logs: string[] = [];
    vi.mocked(console.log).mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });

    const orchestrator = new PPEROrchestratorImpl({
      perceptionProvider: world.core.bridges.perception,
      planProvider: world.core.bridges.plan,
      executeProvider: world.core.bridges.execute,
      reflectProvider: world.core.bridges.reflect,
      classifier: stubClassifier,
      llmClient: {
        async completeStructured() {
          return { reasoning: 'r', action: 'idle' };
        },
        async completeReflection() {
          return { agentId: 'iris-1', newMemories: [], consolidatedNodeIds: [] };
        },
        async completePlan() {
          return {
            description: 'rest among the seedlings',
            steps: [{ description: 'rest', targetAffordance: 'rest_among_seedlings' }],
          };
        },
        async completeReflect() {
          return { memoryEntry: { content: 'x', importance: 5, type: 'action' } };
        },
      },
    });

    await orchestrator.runCycle('iris-1');

    const planEnumLines = logs.filter((l) => l.includes('[plan-enum]'));
    expect(planEnumLines).toHaveLength(1);
    expect(planEnumLines[0]).toContain('agent=iris-1');
    expect(planEnumLines[0]).toContain(`room=${GREENHOUSE}`);
    // The closed conversation's mirror is gone (issue #224) and the offered
    // enum the orchestrator logged carries none of its affordances.
    for (const id of CONVERSATION_ONLY_IDS) {
      expect(planEnumLines[0]).not.toContain(id);
    }
    expect(planEnumLines[0]).toContain('enum=[');
  });
});
