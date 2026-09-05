/**
 * QA coverage tests for spec 033 (issue #128, PR #131) — gaps found during the
 * QA audit that the PR's own spec-033 suites did not cover:
 *
 * - AC-8 (R11–R13): the ENGINE-side guarded `SelfModelManager` is the actual
 *   enforcement point of identity evolution — rate limiting, the per-session
 *   delta budget, malformed-delta validation, and the auditable
 *   `identity_change` event (before/after snapshots) had no direct tests (the
 *   cognition suites only exercise bridge doubles).
 * - AC-9 / AC-12 (R10, R14, R16): the REAL dormant despawn → respawn path
 *   (`SceneMutationServiceImpl` + `DormantAgentStore`) must carry the evolved
 *   self-model AND relationships across dormancy — prior tests used
 *   simplified manual snapshot copies.
 * - AC-13 (R14): the engine→cognition glue — `PerceptionDataProviderImpl.
 *   getSelfModel` must expose the restored/seeded self-model so respawned
 *   agents' prompts reflect the evolved identity; agents without a self-model
 *   fall back to the persona seed.
 * - AC-2 (R3, R8): perception-level conversation-affordance eligibility
 *   filtering (`getEligibleAffordancesInRoom`) — participants see
 *   contribute/leave, co-located non-participants see join/observe, and
 *   non-conversation affordances pass through unchanged.
 * - AC-5 / R7 (despawn support): a despawned agent leaves every conversation.
 *
 * All paths here are deterministic — no LLM anywhere (AC-14).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { AgentProfile, MemoryNode, Room, SmartObject } from '@evol-hive/shared';
import { IDENTITY_MAX_DELTAS_PER_SESSION, IDENTITY_MAX_DELTAS_PER_UPDATE } from '@evol-hive/shared';
import { AgentManagerImpl } from '../src/agents/state/index.js';
import { SelfModelManager } from '../src/agents/state/self-model-manager.js';
import { SmartObjectRegistryImpl } from '../src/world/objects/index.js';
import { SceneManagerImpl } from '../src/world/scenes/index.js';
import { SceneMutationServiceImpl, DormantAgentStore } from '../src/world/mutations/index.js';
import {
  ConversationManagerImpl,
  defaultConversationManagerConfig,
} from '../src/social/conversation-manager.js';
import { SocialManager } from '../src/social/social-manager.js';
import { PerceptionDataProviderImpl } from '../src/agents/perception/index.js';
import { DriveSystemImpl } from '../src/agents/drives/index.js';
import { SystemFeedbackStore } from '../src/agents/feedback/index.js';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const GARDEN = 'garden';
const KITCHEN = 'kitchen';

function makeProfile(id: string, startRoom = GARDEN): AgentProfile {
  return {
    id,
    name: id,
    description: `agent ${id}`,
    traits: ['curious'],
    initialDrives: {},
    backstory: 'Tends the community garden.',
    longTermGoals: ['grow a rare orchid'],
    startRoomId: startRoom,
  };
}

const ROOMS: Room[] = [
  { id: GARDEN, name: 'Garden', description: '', connections: [KITCHEN], objectIds: [] },
  { id: KITCHEN, name: 'Kitchen', description: '', connections: [GARDEN], objectIds: [] },
];

const TROWEL: SmartObject = {
  id: 'trowel-1',
  name: 'Trowel',
  type: 'tool',
  state: {},
  affordances: [
    { id: 'grab', label: 'Grab', engineEffect: 'grab', preconditions: [], effects: {} },
  ],
  roomId: GARDEN,
};

function makeMemoryNode(agentId: string, content: string): MemoryNode {
  return {
    id: `mem_${content.replace(/\s+/g, '-')}`,
    agentId,
    content,
    embedding: [1, 0, 0],
    timestamp: 1,
    importance: 5,
    type: 'observation',
  };
}

interface World {
  agentManager: AgentManagerImpl;
  registry: SmartObjectRegistryImpl;
  sceneManager: SceneManagerImpl;
  dormantStore: DormantAgentStore;
  mutationService: SceneMutationServiceImpl;
  conversations: ConversationManagerImpl;
  selfModels: SelfModelManager;
  social: SocialManager;
  perception: PerceptionDataProviderImpl;
}

/** Full spec-033 wiring: mutation service ↔ self-models ↔ conversations ↔ perception. */
function buildWorld(): World {
  const agentManager = new AgentManagerImpl();
  const registry = new SmartObjectRegistryImpl();
  const sceneManager = new SceneManagerImpl(agentManager, new Map(ROOMS.map((r) => [r.id, r])));
  registry.register(TROWEL);
  const dormantStore = new DormantAgentStore();
  const selfModels = new SelfModelManager();
  const conversations = new ConversationManagerImpl({
    agentManager,
    registry,
    sceneManager,
    config: defaultConversationManagerConfig(),
  });
  const social = new SocialManager(agentManager);
  social.setConversationManager(conversations);
  const perception = new PerceptionDataProviderImpl(
    agentManager,
    registry,
    new DriveSystemImpl(agentManager, 0.1),
    new SystemFeedbackStore(),
  );
  perception.setSocialManager(social);
  perception.setConversationManager(conversations);
  perception.setSelfModelManager(selfModels);
  const mutationService = new SceneMutationServiceImpl({
    registry,
    sceneManager,
    agentManager,
    dormantStore,
    memoryPort: {
      exportMemories: (agentId: string) => [makeMemoryNode(agentId, 'memory from last session')],
      importMemories: () => undefined,
    },
    selfModelManager: selfModels,
    conversationManager: conversations,
  });
  return {
    agentManager,
    registry,
    sceneManager,
    dormantStore,
    mutationService,
    conversations,
    selfModels,
    social,
    perception,
  };
}

// ── AC-8 — the engine-side guarded SelfModelManager (R11–R13) ────────────────

describe('SelfModelManager guards (AC-8, R11–R13)', () => {
  let world: World;
  beforeEach(() => {
    world = buildWorld();
  });

  it('seeds from the immutable spawn profile and falls back to null before seeding', () => {
    expect(world.selfModels.getSelfModel('agent-a')).toBeNull();
    const model = world.selfModels.seedFromProfile(makeProfile('agent-a'), 5);
    expect(model.traits).toEqual(['curious']);
    expect(model.selfNarrative).toContain('Tends the community garden');
    expect(model.longTermGoals).toEqual(['grow a rare orchid']);
    expect(model.revision).toBe(0);
    // Idempotent: seeding twice returns the same record.
    expect(world.selfModels.seedFromProfile(makeProfile('agent-a'), 9)).toBe(model);
  });

  it('rejects identity writes for agents without a self-model', () => {
    const result = world.selfModels.applySelfModelDeltas('ghost', [
      { type: 'trait_add', value: 'patient' },
    ]);
    expect(result.success).toBe(false);
    expect(result.applied).toBe(0);
    expect(result.message).toContain('No self-model exists');
  });

  it('is rate-limited: at most one apply per minApplyIntervalTicks per agent', () => {
    world.selfModels.seedFromProfile(makeProfile('agent-a'), 0);
    const first = world.selfModels.applySelfModelDeltas(
      'agent-a',
      [{ type: 'trait_add', value: 'patient' }],
      10,
    );
    expect(first.success).toBe(true);
    // Too soon (default interval is 20 ticks).
    const second = world.selfModels.applySelfModelDeltas(
      'agent-a',
      [{ type: 'trait_add', value: 'resilient' }],
      15,
    );
    expect(second.success).toBe(false);
    expect(second.message).toContain('Rate limit');
    // After the interval the apply goes through.
    const third = world.selfModels.applySelfModelDeltas(
      'agent-a',
      [{ type: 'trait_add', value: 'resilient' }],
      31,
    );
    expect(third.success).toBe(true);
  });

  it('is bounded: max deltas per update and max deltas per session (AC-8, R13)', () => {
    const manager = new SelfModelManager({ minApplyIntervalTicks: 0 });
    manager.seedFromProfile(makeProfile('agent-a'), 0);
    expect(IDENTITY_MAX_DELTAS_PER_UPDATE).toBe(3);
    expect(IDENTITY_MAX_DELTAS_PER_SESSION).toBe(10);

    const batch = (): { type: 'trait_add'; value: string } => ({
      type: 'trait_add',
      value: `t${Math.random()}`,
    });
    // Three full batches of 3 → 9 used, 1 remaining in the 10/session budget.
    expect(manager.applySelfModelDeltas('agent-a', [batch(), batch(), batch()], 1).applied).toBe(3);
    expect(manager.applySelfModelDeltas('agent-a', [batch(), batch(), batch()], 2).applied).toBe(3);
    expect(manager.applySelfModelDeltas('agent-a', [batch(), batch(), batch()], 3).applied).toBe(3);
    // The 4th batch is clamped to the 1 remaining session delta.
    const fourth = manager.applySelfModelDeltas('agent-a', [batch(), batch(), batch()], 4);
    expect(fourth.applied).toBe(1);
    expect(fourth.rejected).toBe(2);
    // The budget is exhausted → structured refusal.
    const fifth = manager.applySelfModelDeltas('agent-a', [batch()], 5);
    expect(fifth.success).toBe(false);
    expect(fifth.message).toContain('per session');
  });

  it('drops malformed deltas before they touch identity (validation guard)', () => {
    world.selfModels.seedFromProfile(makeProfile('agent-a'), 0);
    const result = world.selfModels.applySelfModelDeltas(
      'agent-a',
      [
        { type: 'explode_identity', value: 'evil' },
        { type: 'trait_add', value: '' },
        { type: 'trait_add', value: 'patient' },
      ] as never,
      1,
    );
    expect(result.success).toBe(true);
    expect(result.applied).toBe(1);
    expect(world.selfModels.getSelfModel('agent-a')!.traits).toContain('patient');
    expect(world.selfModels.getSelfModel('agent-a')!.traits).not.toContain('evil');
  });

  it('records auditable identity_change events with before/after snapshots (AC-8, R13)', () => {
    world.selfModels.seedFromProfile(makeProfile('agent-a'), 0);
    const result = world.selfModels.applySelfModelDeltas(
      'agent-a',
      [
        { type: 'trait_add', value: 'guarded', reason: 'Bob was hostile' },
        { type: 'narrative_edit', value: 'I keep my distance from Bob.' },
      ],
      42,
    );
    expect(result.success).toBe(true);
    const log = world.selfModels.getIdentityAuditLog('agent-a');
    expect(log).toHaveLength(1);
    const audit = log[0]!;
    expect(audit.agentId).toBe('agent-a');
    expect(audit.appliedAt).toBe(42);
    expect(audit.deltas).toHaveLength(2);
    expect(audit.before.traits).toEqual(['curious']);
    expect(audit.after.traits).toContain('guarded');
    expect(audit.after.selfNarrative).toContain('keep my distance');
    expect(audit.revision).toBe(audit.before.revision + 1);
    // The returned audit matches the stored trail.
    expect(result.audit).toEqual(audit);
  });

  it('resetSessionBudget re-opens the per-session budget for a new session', () => {
    const manager = new SelfModelManager({ minApplyIntervalTicks: 0, maxDeltasPerSession: 2 });
    manager.seedFromProfile(makeProfile('agent-a'), 0);
    expect(
      manager.applySelfModelDeltas('agent-a', [{ type: 'trait_add', value: 'a' }], 1).applied,
    ).toBe(1);
    expect(
      manager.applySelfModelDeltas('agent-a', [{ type: 'trait_add', value: 'b' }], 2).applied,
    ).toBe(1);
    expect(
      manager.applySelfModelDeltas('agent-a', [{ type: 'trait_add', value: 'c' }], 3).success,
    ).toBe(false);
    manager.resetSessionBudget('agent-a');
    expect(
      manager.applySelfModelDeltas('agent-a', [{ type: 'trait_add', value: 'c' }], 4).success,
    ).toBe(true);
  });
});

// ── AC-9 / AC-12 — dormant despawn → respawn carries identity + relations ────

describe('dormant despawn → respawn (AC-9, AC-12, AC-13, R14/R16)', () => {
  let world: World;
  beforeEach(() => {
    world = buildWorld();
    world.mutationService.propose({
      type: 'spawn_agent',
      payload: { profile: makeProfile('agent-a') },
      source: 'engine',
    });
    world.mutationService.propose({
      type: 'spawn_agent',
      payload: { profile: makeProfile('agent-b') },
      source: 'engine',
    });
    world.mutationService.applyPending(1);
  });

  it('the dormant snapshot carries the evolved self-model (R14)', () => {
    world.selfModels.applySelfModelDeltas('agent-a', [{ type: 'trait_add', value: 'wary' }], 2);
    world.mutationService.propose({
      type: 'despawn_agent',
      payload: { agentId: 'agent-a' },
      source: 'engine',
    });
    world.mutationService.applyPending(3);
    const dormant = world.dormantStore.get('agent-a');
    expect(dormant).not.toBeNull();
    expect(dormant!.selfModel).toBeDefined();
    expect(dormant!.selfModel!.traits).toContain('wary');
    expect(dormant!.selfModel!.revision).toBe(1);
  });

  it('respawn restores the evolved self-model AND relationships (AC-9, AC-12)', () => {
    world.selfModels.applySelfModelDeltas(
      'agent-a',
      [
        { type: 'trait_add', value: 'wary' },
        { type: 'narrative_edit', value: 'I keep my distance from Bob.' },
      ],
      2,
    );
    world.agentManager.updateState('agent-a', {
      relationships: {
        'agent-b': { trust: 72, familiarity: 40, lastInteraction: 5 },
      },
    });
    world.mutationService.propose({
      type: 'despawn_agent',
      payload: { agentId: 'agent-a' },
      source: 'engine',
    });
    world.mutationService.applyPending(3);
    expect(world.agentManager.getState('agent-a')).toBeNull();

    // Respawn from dormancy — no profile argument.
    world.mutationService.propose({
      type: 'spawn_agent',
      payload: { dormantAgentId: 'agent-a' },
      source: 'engine',
    });
    world.mutationService.applyPending(4);

    const restored = world.selfModels.getSelfModel('agent-a');
    expect(restored).not.toBeNull();
    expect(restored!.traits).toContain('wary');
    expect(restored!.selfNarrative).toContain('keep my distance');
    expect(restored!.revision).toBe(1);
    // Relationships (R16): trust/familiarity survive the real dormancy path.
    const rel = world.agentManager.getState('agent-a')?.relationships?.['agent-b'];
    expect(rel).toBeDefined();
    expect(rel!.trust).toBe(72);
    expect(rel!.familiarity).toBe(40);
  });

  it('respawn without a dormant self-model seeds from the spawn persona (fallback)', () => {
    // agent-b never evolved — respawn (via fresh spawn here) must seed the profile.
    world.mutationService.propose({
      type: 'despawn_agent',
      payload: { agentId: 'agent-b' },
      source: 'engine',
    });
    world.mutationService.applyPending(2);
    expect(world.dormantStore.get('agent-b')!.selfModel).toBeDefined(); // seeded at spawn
    // A self-model-less manager (fresh engine) must fall back to the profile seed.
    const fresh = buildWorld();
    fresh.mutationService.propose({
      type: 'spawn_agent',
      payload: { profile: makeProfile('agent-c') },
      source: 'engine',
    });
    fresh.mutationService.applyPending(1);
    const seeded = fresh.selfModels.getSelfModel('agent-c');
    expect(seeded).not.toBeNull();
    expect(seeded!.traits).toEqual(['curious']);
    expect(seeded!.revision).toBe(0);
  });
});

// ── AC-13 — the engine→cognition self-model glue (perception provider) ──────

describe('perception self-model accessor (AC-13, R11/R14)', () => {
  let world: World;
  beforeEach(() => {
    world = buildWorld();
    world.mutationService.propose({
      type: 'spawn_agent',
      payload: { profile: makeProfile('agent-a') },
      source: 'engine',
    });
    world.mutationService.applyPending(1);
  });

  it('exposes the spawned agent persona-seeded self-model (R11)', () => {
    const model = world.perception.getSelfModel('agent-a');
    expect(model).not.toBeNull();
    expect(model!.traits).toEqual(['curious']);
    expect(model!.selfNarrative).toContain('Tends the community garden');
  });

  it('reflects identity evolution immediately (the live record, not the seed)', () => {
    world.selfModels.applySelfModelDeltas('agent-a', [{ type: 'goal_add', value: 'avoid Bob' }], 2);
    const model = world.perception.getSelfModel('agent-a');
    expect(model!.longTermGoals).toContain('avoid Bob');
    expect(model!.revision).toBe(1);
  });

  it('returns null for unknown agents (persona fallback, backward compat)', () => {
    expect(world.perception.getSelfModel('stranger')).toBeNull();
  });
});

// ── AC-2 — perception-level conversation affordance eligibility (R3/R8) ──────

describe('perception eligibility filtering (AC-2, R3/R8)', () => {
  let world: World;
  beforeEach(() => {
    world = buildWorld();
    for (const id of ['agent-a', 'agent-b', 'agent-c']) {
      world.mutationService.propose({
        type: 'spawn_agent',
        payload: { profile: makeProfile(id) },
        source: 'engine',
      });
    }
    world.mutationService.applyPending(1);
  });

  it('a participant sees contribute/leave of the conversation, not join/observe', () => {
    world.conversations.openOrContribute('agent-a', 'agent-b', 'hi', 'neutral', 2);
    const eligible = world.perception
      .getEligibleAffordancesInRoom(GARDEN, 'agent-a')
      .map((a) => a.id);
    expect(eligible).toContain('contribute');
    expect(eligible).toContain('leave');
    expect(eligible).not.toContain('join');
    expect(eligible).not.toContain('observe');
    // Non-conversation affordances pass through unchanged (R8 — reuse, don't rebuild).
    expect(eligible).toContain('grab');
  });

  it('a co-located non-participant sees join/observe, not contribute/leave', () => {
    const opened = world.conversations.openOrContribute('agent-a', 'agent-b', 'hi', 'neutral', 2);
    expect(opened.success).toBe(true);
    const eligible = world.perception
      .getEligibleAffordancesInRoom(GARDEN, 'agent-c')
      .map((a) => a.id);
    expect(eligible).toContain('join');
    expect(eligible).toContain('observe');
    expect(eligible).not.toContain('contribute');
    expect(eligible).not.toContain('leave');
  });

  it('without a conversation manager the registry-level affordances pass through', () => {
    const bare = new PerceptionDataProviderImpl(
      world.agentManager,
      world.registry,
      new DriveSystemImpl(world.agentManager, 0.1),
      new SystemFeedbackStore(),
    );
    const eligible = bare.getEligibleAffordancesInRoom(GARDEN, 'agent-a').map((a) => a.id);
    expect(eligible).toContain('grab');
  });
});

// ── AC-5 / R7 — a despawned agent leaves every conversation ─────────────────

describe('despawn conversation cleanup (AC-5, R7)', () => {
  let world: World;
  beforeEach(() => {
    world = buildWorld();
    for (const id of ['agent-a', 'agent-b']) {
      world.mutationService.propose({
        type: 'spawn_agent',
        payload: { profile: makeProfile(id) },
        source: 'engine',
      });
    }
    world.mutationService.applyPending(1);
  });

  it('despawn removes the agent from the conversation; the last despawn closes it', () => {
    const opened = world.conversations.openOrContribute('agent-a', 'agent-b', 'hi', 'neutral', 2);
    const convId = opened.conversation!.id;

    world.mutationService.propose({
      type: 'despawn_agent',
      payload: { agentId: 'agent-a' },
      source: 'engine',
    });
    world.mutationService.applyPending(3);
    let conv = world.conversations.getConversation(convId)!;
    expect(conv.status).toBe('open'); // agent-b still present
    expect(conv.participants.map((p) => p.agentId)).toEqual(['agent-b']);

    world.mutationService.propose({
      type: 'despawn_agent',
      payload: { agentId: 'agent-b' },
      source: 'engine',
    });
    world.mutationService.applyPending(4);
    conv = world.conversations.getConversation(convId)!;
    expect(conv.status).toBe('closed'); // last participant gone → closed
  });
});
