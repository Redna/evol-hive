/**
 * Spec 059 — Plan-Retention Re-Validation (assembly E2E, issue #210)
 * ═══════════════════════════════════════════════════════════════════════
 * AC-2 (R1): the production `AffordanceGuard` adapter's
 * `isAffordanceEligibleForAgent` reads the live
 * `getVisibleAffordancesInRoom(agentId, roomId)` projection — an ineligible
 * conversation affordance for that agent is not eligible, an eligible one is,
 * a non-conversation affordance is unaffected, and the read is uncached
 * across ticks.
 *
 * AC-9 (R5): an invalidated plan's `superseded` outcome renders the spec-056
 * "Your last plan was … — superseded after N of M steps." line in the next
 * cycle's plan prompt.
 *
 * Deterministic throughout — the LLM client is constructed but never invoked.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Affordance, AgentPlan, EngineConfig, PerceptionResult } from '@evol-hive/shared';
import { PlanBuilderImpl } from '@evol-hive/cognition';
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

function makeConfig(): EngineConfig {
  return {
    fps: 30,
    spatialDebounceSeconds: 2,
    maxConcurrentLLM: 8,
    guardrailsEnabled: true,
  };
}

function makeAffordance(id: string, effects: Record<string, number> = {}): Affordance {
  return { id, label: id, engineEffect: id, preconditions: [], effects };
}

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
    core.agentManager.spawn({
      id,
      name: id,
      description: `agent ${id}`,
      traits: [],
      initialDrives: {},
    });
    core.agentManager.updateState(id, { location: ROOM, lastPerceptionTick: 0 });
  }
}

function buildWorld(): AssembledWorld {
  process.env['USE_REAL_LLM'] = 'true';
  return assembleWorld({
    config: makeConfig(),
    sceneSetup: setupScene,
    wireMemoryMaintenance: false,
  });
}

// ── AC-2 (R1) ────────────────────────────────────────────────────────────────

describe('spec 059 AC-2 — agent-scoped eligibility adapter reads the live projection', () => {
  it('an ineligible conversation affordance is not eligible; an eligible one is; non-conversation is unaffected', async () => {
    const { core, stack } = buildWorld();
    const guard = stack!.affordanceGuard;

    const opened = await stack!.cognitiveToolExecutor!.executeTalkTo(
      'agent-a',
      'agent-b',
      'hello there',
      'neutral',
    );
    expect(opened.success).toBe(true);

    // Participant agent-a: contribute/leave eligible, join not.
    expect(guard.isAffordanceEligibleForAgent?.('contribute', ROOM, 'agent-a')).toBe(true);
    expect(guard.isAffordanceEligibleForAgent?.('leave', ROOM, 'agent-a')).toBe(true);
    expect(guard.isAffordanceEligibleForAgent?.('join', ROOM, 'agent-a')).toBe(false);

    // Bystander agent-c: join eligible, contribute/leave not.
    expect(guard.isAffordanceEligibleForAgent?.('join', ROOM, 'agent-c')).toBe(true);
    expect(guard.isAffordanceEligibleForAgent?.('contribute', ROOM, 'agent-c')).toBe(false);
    expect(guard.isAffordanceEligibleForAgent?.('leave', ROOM, 'agent-c')).toBe(false);

    // Non-conversation affordance is unaffected for everyone.
    expect(guard.isAffordanceEligibleForAgent?.('sit', ROOM, 'agent-a')).toBe(true);
    expect(guard.isAffordanceEligibleForAgent?.('sit', ROOM, 'agent-c')).toBe(true);

    void core;
  });

  it('the read is uncached across ticks — registry changes are observed live', () => {
    const { core, stack } = buildWorld();
    const guard = stack!.affordanceGuard;

    expect(guard.isAffordanceEligibleForAgent?.('new_aff', ROOM, 'agent-a')).toBe(false);

    core.smartObjectRegistry.register({
      id: 'new-obj',
      name: 'New object',
      type: 'furniture',
      state: {},
      affordances: [makeAffordance('new_aff')],
      roomId: ROOM,
    });

    expect(guard.isAffordanceEligibleForAgent?.('new_aff', ROOM, 'agent-a')).toBe(true);

    core.smartObjectRegistry.setRoom('new-obj', 'workshop');

    expect(guard.isAffordanceEligibleForAgent?.('new_aff', ROOM, 'agent-a')).toBe(false);
  });

  it('the legacy room-scoped method is still backed by the live registry', () => {
    const { core, stack } = buildWorld();
    const guard = stack!.affordanceGuard;

    expect(guard.isAffordanceAvailableInRoom('sit', ROOM)).toBe(true);
    core.smartObjectRegistry.setRoom('bench-1', 'workshop');
    expect(guard.isAffordanceAvailableInRoom('sit', ROOM)).toBe(false);
  });
});

// ── AC-9 (R5) ────────────────────────────────────────────────────────────────

function inFlightPlan(): AgentPlan {
  return {
    id: 'plan_agent-a_150.6_40',
    description: 'Water the greenhouse',
    steps: [
      { description: 'Walk', completed: true, targetAffordance: 'go_to_greenhouse' },
      { description: 'Prepare', completed: true, targetAffordance: 'prepare' },
      { description: 'Water', completed: false, targetAffordance: 'water_plants' },
    ],
    currentStepIndex: 2,
    createdAt: 150.6,
  };
}

describe('spec 059 AC-9 — an invalidated plan renders the superseded verdict in the prompt', () => {
  it('renders the spec-056 superseded line from the invalidation stamp', () => {
    const { core } = buildWorld();
    core.agentManager.updateState('agent-a', { currentPlan: inFlightPlan() });

    core.planManager.invalidatePlan('agent-a');

    const outcome = core.agentManager.getState('agent-a')?.lastPlanOutcome;
    expect(outcome?.superseded).toBe(true);

    const perception: PerceptionResult = {
      passive: {
        roomId: ROOM,
        objectsPresent: [],
        drives: { energy: 50, hunger: 50, social: 50, comfort: 50, curiosity: 50 },
      },
      prunedAffordances: [makeAffordance('water_plants')],
      primaryDriveLabel: 'low curiosity, need to restore curiosity',
      lastPlanOutcome: outcome,
    };

    const payload = new PlanBuilderImpl().build(perception);

    expect(payload.perceptionContext).toContain(
      'Your last plan was "go_to_greenhouse, prepare, water_plants" — superseded after 2 of 3 steps.',
    );
  });
});
