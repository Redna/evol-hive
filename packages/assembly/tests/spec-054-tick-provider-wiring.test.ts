/**
 * Tests for spec 054 — Live Tick Provider, assembly wiring (issue #195).
 *
 * The bug: `assembleCognitionStack` constructed `CognitiveToolExecutorImpl`
 * WITHOUT a tick source, so the executor fell back to `Date.now()` captured at
 * construction — epoch milliseconds (~1.789e12) where engine tickNumber
 * belongs. Conversation turns and `Relationship.lastInteraction` carried epoch
 * ms; `PendingAddressInfo.age` went ~−1.789e12 and the spec 049 R3 `FRESH:`
 * promotion fired on every pending address forever (visible as
 * `age=-1789292161245` in the 053 run's `[social-urge]` lines).
 *
 * Covers:
 * - AC-4 (R4): production assembly (`USE_REAL_LLM=true`) constructs the
 *   executor with a `tickProvider` wired to the core game loop — the provider
 *   returns the LIVE `tickNumber` (0 before the loop starts, advancing as the
 *   loop state advances), and it is the tick NUMBER, not `simulationTime`.
 * - AC-5 (R5, E2E): with the wired provider, a pending address whose last turn
 *   is 100 ticks old renders `FRESH:`-promoted and one 4000 ticks old renders
 *   without promotion; `PendingAddressInfo` age is non-negative in both.
 *
 * Deterministic throughout — the loop never starts; tick state is set via the
 * loop's `restoreState` seam and read via `currentTick().tickNumber`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Affordance, AgentProfile, EngineConfig } from '@evol-hive/shared';
import { PerceptionServiceImpl, PerceptionBuilderImpl } from '@evol-hive/cognition';
import type { EngineCore } from '@evol-hive/engine';
import { assembleWorld } from '@evol-hive/assembly';
import type { AssembledWorld } from '@evol-hive/assembly';

// ── Env hygiene (assembly test convention) ───────────────────────────────────

const ENV_KEYS = ['USE_REAL_LLM', 'USE_REAL_EMBEDDINGS', 'ENGINE_MAX_CONCURRENT_LLM'] as const;

beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  vi.restoreAllMocks();
});

// ── Helpers (spec-053 e2e pattern) ───────────────────────────────────────────

const ROOM = 'garden';

function makeConfig(): EngineConfig {
  return {
    fps: 30,
    spatialDebounceSeconds: 2,
    maxConcurrentLLM: 8,
    guardrailsEnabled: true,
    guardrails: { affordanceMasking: true, contextualForcing: true, planValidation: true },
  };
}

function makeProfile(id: string): AgentProfile {
  return { id, name: id, description: `agent ${id}`, traits: [], initialDrives: {} };
}

function spawnPair(core: EngineCore): void {
  for (const id of ['agent-a', 'agent-b']) {
    core.agentManager.spawn(makeProfile(id));
    core.agentManager.updateState(id, { location: ROOM, lastPerceptionTick: 0 });
  }
}

/** Build the fully-assembled world with the pair spawned (executor = real path). */
function buildWorld(): AssembledWorld {
  process.env['USE_REAL_LLM'] = 'true'; // the executor is built on the real-LLM path
  return assembleWorld({
    config: makeConfig(),
    sceneSetup: spawnPair,
    wireMemoryMaintenance: false,
  });
}

/** lastInteraction on agent's relationship toward other, post-talk_to. */
function lastInteraction(core: EngineCore, agentId: string, otherId: string): number {
  const rel = core.socialManager.getRelationships(agentId)[otherId];
  expect(rel, `expected a relationship ${agentId}→${otherId}`).toBeDefined();
  return rel!.lastInteraction;
}

/** The real Perceive→build chain over the production-assembled provider. */
async function renderPerception(core: EngineCore, agentId: string): Promise<string> {
  const service = new PerceptionServiceImpl({
    provider: core.bridges.perception,
    classifier: { prune: async (_d: string, affs: Affordance[]) => affs },
  });
  const perception = await service.perceive(agentId);
  return new PerceptionBuilderImpl().build(perception).perceptionContext;
}

// ── AC-4 — the wired provider returns the LIVE engine tickNumber ─────────────

describe('AC-4: assembly wires the executor tickProvider to the game loop (R4)', () => {
  it('real-LLM assembly builds the executor; pre-loop talk_to stamps tickNumber 0', async () => {
    process.env['USE_REAL_LLM'] = 'true';
    const { core, stack } = assembleWorld({
      config: makeConfig(),
      sceneSetup: spawnPair,
      wireMemoryMaintenance: false,
    });

    expect(stack).toBeDefined();
    expect(stack!.cognitiveToolExecutor).toBeDefined();

    // Before the loop starts, tickNumber is 0 — the provider must agree.
    expect(core.gameLoop.currentTick().tickNumber).toBe(0);
    const result = await stack!.cognitiveToolExecutor!.executeTalkTo(
      'agent-a',
      'agent-b',
      'hello at tick 0',
      'neutral',
    );
    expect(result.success).toBe(true);
    expect(lastInteraction(core, 'agent-a', 'agent-b')).toBe(0);
    expect(lastInteraction(core, 'agent-b', 'agent-a')).toBe(0);
  });

  it('the provider is LIVE: stamps advance as the game loop advances (same executor)', async () => {
    process.env['USE_REAL_LLM'] = 'true';
    const { core, stack } = assembleWorld({
      config: makeConfig(),
      sceneSetup: spawnPair,
      wireMemoryMaintenance: false,
    });
    const executor = stack!.cognitiveToolExecutor!;

    core.gameLoop.restoreState(500, 500 / 30);
    await executor.executeTalkTo('agent-a', 'agent-b', 'tick 500', 'neutral');
    expect(lastInteraction(core, 'agent-a', 'agent-b')).toBe(500);
    expect(lastInteraction(core, 'agent-b', 'agent-a')).toBe(500);

    core.gameLoop.restoreState(600, 600 / 30);
    await executor.executeTalkTo('agent-a', 'agent-b', 'tick 600', 'neutral');
    expect(lastInteraction(core, 'agent-a', 'agent-b')).toBe(600);
  });

  it('the unit is the tick NUMBER — not simulationTime (seconds)', async () => {
    process.env['USE_REAL_LLM'] = 'true';
    const { core, stack } = assembleWorld({
      config: makeConfig(),
      sceneSetup: spawnPair,
      wireMemoryMaintenance: false,
    });

    // tickNumber 600 but simulationTime far away — the stamp must track ticks.
    core.gameLoop.restoreState(600, 60000);
    await stack!.cognitiveToolExecutor!.executeTalkTo('agent-a', 'agent-b', 'units', 'neutral');
    expect(core.gameLoop.currentTick().simulationTime).toBe(60000);
    expect(lastInteraction(core, 'agent-a', 'agent-b')).toBe(600);

    // The conversation turn is stamped with the same tick number (spec 033).
    const conversation = core.conversationManager.getOpenConversationBetween('agent-a', 'agent-b');
    expect(conversation).not.toBeNull();
    const lastTurn = conversation!.turns[conversation!.turns.length - 1]!;
    expect(lastTurn.tick).toBe(600);
  });
});

// ── AC-5 (E2E) — freshness discrimination through the production wiring ──────

describe('AC-5: pending-address freshness through the production wiring (R5)', () => {
  it('100 ticks old → FRESH:-promoted; 4000 ticks old → no promotion; age non-negative', async () => {
    process.env['USE_REAL_LLM'] = 'true';
    const { core, stack } = assembleWorld({
      config: makeConfig(),
      sceneSetup: spawnPair,
      wireMemoryMaintenance: false,
    });

    // The addressing turn lands at tick 2000 (engine tickNumber).
    core.gameLoop.restoreState(2000, 2000 / 30);
    const opened = await stack!.cognitiveToolExecutor!.executeTalkTo(
      'agent-a',
      'agent-b',
      'Where do you get good beans?',
      'neutral',
    );
    expect(opened.success).toBe(true);

    // 100 ticks later, agent-b's perception sees a FRESH pending address.
    core.gameLoop.restoreState(2100, 2100 / 30);
    const freshContext = await renderPerception(core, 'agent-b');
    expect(freshContext).toContain(
      'FRESH: INFORMATION: agent-a addressed you, awaiting response: "Where do you get good beans?"',
    );
    const freshPending = core.bridges.perception
      .getConversationsAwaitingAgentReply('agent-b')
      .map((c) => {
        const last = c.turns[c.turns.length - 1]!;
        return { currentTick: core.gameLoop.currentTick().tickNumber, lastTurnTick: last.tick };
      });
    expect(freshPending.length).toBeGreaterThan(0);
    for (const p of freshPending) {
      expect(p.currentTick - p.lastTurnTick).toBe(100); // non-negative, exactly 100
    }

    // 4000 ticks later the address is stale — rendered WITHOUT promotion.
    core.gameLoop.restoreState(2000 + 4000, (2000 + 4000) / 30);
    const staleContext = await renderPerception(core, 'agent-b');
    expect(staleContext).not.toContain('FRESH:');
    expect(staleContext).toContain(
      'INFORMATION: agent-a addressed you, awaiting response: "Where do you get good beans?"',
    );
    const stalePending = core.bridges.perception
      .getConversationsAwaitingAgentReply('agent-b')
      .map((c) => {
        const last = c.turns[c.turns.length - 1]!;
        return { currentTick: core.gameLoop.currentTick().tickNumber, lastTurnTick: last.tick };
      });
    for (const p of stalePending) {
      expect(p.currentTick - p.lastTurnTick).toBe(4000); // non-negative, exactly 4000
    }
  });
});
