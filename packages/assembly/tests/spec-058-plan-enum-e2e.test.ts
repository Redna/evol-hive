/**
 * Spec 058 — Eligibility-Bound Plan Affordances (assembly E2E, issue #206)
 * ═══════════════════════════════════════════════════════════════════════
 * AC-4 (R3): over the production assembled engine + cognition stack, an agent
 * with no open conversation in its room sees an eligible set (pruned
 * affordances, the `formulate_plan` targetAffordance enum, and the affordance
 * tool list) free of `join`/`contribute`/`leave`, while non-conversation
 * affordances remain; an eligible participant yields `contribute`/`leave`.
 *
 * Deterministic throughout — the LLM client is constructed but never invoked.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Affordance, AgentProfile, EngineConfig, ToolDefinition } from '@evol-hive/shared';
import type { AffordanceClassifier } from '@evol-hive/cognition';
import { PerceptionServiceImpl, PlanBuilderImpl } from '@evol-hive/cognition';
import type { EngineCore } from '@evol-hive/engine';
import { assembleWorld } from '@evol-hive/assembly';
import type { AssembledWorld } from '@evol-hive/assembly';

const ROOM = 'garden';

const ENV_KEYS = ['USE_REAL_LLM', 'USE_REAL_EMBEDDINGS', 'ENGINE_MAX_CONCURRENT_LLM'] as const;

beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});
afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

// ── Fixtures ─────────────────────────────────────────────────────────────────

function makeConfig(): EngineConfig {
  return {
    fps: 30,
    spatialDebounceSeconds: 2,
    maxConcurrentLLM: 8,
    guardrailsEnabled: true,
  };
}

function makeProfile(id: string): AgentProfile {
  return { id, name: id, description: `agent ${id}`, traits: [], initialDrives: {} };
}

function makeAffordance(id: string, effects: Record<string, number> = {}): Affordance {
  return { id, label: id, engineEffect: id, preconditions: [], effects };
}

/** Register a non-conversation object + spawn the trio (scene data). */
function setupScene(core: EngineCore): void {
  core.smartObjectRegistry.register({
    id: 'bench-1',
    name: 'Bench',
    type: 'furniture',
    state: {},
    affordances: [makeAffordance('sit', { energy: 10 })],
    roomId: ROOM,
  });
  for (const id of ['agent-a', 'agent-b', 'agent-c']) {
    core.agentManager.spawn(makeProfile(id));
    core.agentManager.updateState(id, { location: ROOM, lastPerceptionTick: 0 });
  }
}

function stubClassifier(): AffordanceClassifier {
  return { prune: async (_driveLabel: string, affordances: Affordance[]) => affordances };
}

/** The real Perceive phase over the production provider. */
async function perceive(core: EngineCore, agentId: string) {
  const service = new PerceptionServiceImpl({
    provider: core.bridges.perception,
    classifier: stubClassifier(),
  });
  return service.perceive(agentId);
}

function buildWorld(): AssembledWorld {
  process.env['USE_REAL_LLM'] = 'true'; // the production executor path (cf. spec 053 E2E)
  return assembleWorld({
    config: makeConfig(),
    sceneSetup: setupScene,
    wireMemoryMaintenance: false,
  });
}

function formulateEnum(tools: ToolDefinition[]): string[] {
  const planTool = tools.find((t) => t.function.name === 'formulate_plan');
  const parameters = (planTool?.function.parameters ?? {}) as unknown as {
    properties?: {
      steps?: {
        items?: { properties?: { targetAffordance?: { enum?: string[] } } };
      };
    };
  };
  return parameters.properties?.steps?.items?.properties?.targetAffordance?.enum ?? [];
}

function toolNames(tools: ToolDefinition[]): string[] {
  return tools.map((t) => t.function.name);
}

const CONVERSATION_IDS = ['join', 'contribute', 'leave'];

// ── AC-4 (R3) ────────────────────────────────────────────────────────────────

describe('spec 058 AC-4 — assembled plan value space excludes ineligible conversation affordances', () => {
  it('an agent with no open conversation sees no join/contribute/leave in pruned, enum, or affordance tools', async () => {
    const { core } = buildWorld();
    const perception = await perceive(core, 'agent-c');
    const prunedIds = perception.prunedAffordances.map((a) => a.id);
    for (const id of CONVERSATION_IDS) expect(prunedIds).not.toContain(id);
    expect(prunedIds).toContain('sit');

    const payload = new PlanBuilderImpl().build(perception);
    const enumIds = formulateEnum(payload.tools);
    for (const id of CONVERSATION_IDS) expect(enumIds).not.toContain(id);
    expect(enumIds).toContain('sit');

    const names = toolNames(payload.tools);
    for (const id of CONVERSATION_IDS) expect(names).not.toContain(id);
    expect(names).toContain('sit');
  });

  it('an eligible participant yields contribute/leave in pruned, enum, and affordance tools', async () => {
    const { core, stack } = buildWorld();
    const opened = await stack!.cognitiveToolExecutor!.executeTalkTo(
      'agent-a',
      'agent-b',
      'hello there',
      'neutral',
    );
    expect(opened.success).toBe(true);

    const perception = await perceive(core, 'agent-a');
    const prunedIds = perception.prunedAffordances.map((a) => a.id);
    expect(prunedIds).toContain('contribute');
    expect(prunedIds).toContain('leave');
    expect(prunedIds).not.toContain('join');
    expect(prunedIds).toContain('sit');

    const payload = new PlanBuilderImpl().build(perception);
    const enumIds = formulateEnum(payload.tools);
    expect(enumIds).toContain('contribute');
    expect(enumIds).toContain('leave');
    expect(enumIds).not.toContain('join');
    expect(enumIds).toContain('sit');

    const names = toolNames(payload.tools);
    expect(names).toContain('contribute');
    expect(names).toContain('leave');
    expect(names).not.toContain('join');
    expect(names).toContain('sit');
  });

  it('a co-located non-participant sees join/observe, never contribute/leave', async () => {
    const { core, stack } = buildWorld();
    await stack!.cognitiveToolExecutor!.executeTalkTo('agent-a', 'agent-b', 'hi', 'neutral');
    const perception = await perceive(core, 'agent-c');
    const prunedIds = perception.prunedAffordances.map((a) => a.id);
    expect(prunedIds).toContain('join');
    expect(prunedIds).toContain('observe');
    expect(prunedIds).not.toContain('contribute');
    expect(prunedIds).not.toContain('leave');
  });
});
