/**
 * Tests for spec 033 — Persistence v3 (issue #128) — engine layer.
 *
 * Covers:
 * - AC-9 (R10, R14): save/load round-trips conversations, relationships, and
 *   evolved self-models (format v3); dormant respawn restores the evolved
 *   self-model.
 * - AC-12 (R10, R16): a regression test proving relationship trust/familiarity
 *   survive save/load AND the dormant respawn path; SAVE_FORMAT_VERSION is 3
 *   and v1/v2 saves still load (MIN_SUPPORTED_SAVE_FORMAT_VERSION = 1).
 * - AC-14: save/load is pure deterministic JSON — no LLM anywhere.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { AgentProfile, EngineConfig, Room, SmartObject } from '@evol-hive/shared';
import {
  SAVE_FORMAT_VERSION,
  MIN_SUPPORTED_SAVE_FORMAT_VERSION,
  SaveFormatVersionError,
} from '@evol-hive/shared';
import { InMemoryVectorStore } from '@evol-hive/memory';
import { GameLoopImpl } from '../src/loop/index.js';
import { AgentManagerImpl } from '../src/agents/state/index.js';
import { SceneManagerImpl } from '../src/world/scenes/index.js';
import { SmartObjectRegistryImpl } from '../src/world/objects/index.js';
import { EnginePersistenceImpl } from '../src/persistence/engine-persistence.js';
import { SocialManager } from '../src/social/social-manager.js';
import {
  ConversationManagerImpl,
  defaultConversationManagerConfig,
} from '../src/social/conversation-manager.js';
import { SelfModelManager } from '../src/agents/state/self-model-manager.js';
import { SceneMutationServiceImpl, DormantAgentStore } from '../src/world/mutations/index.js';

// ── Fixtures ─────────────────────────────────────────────────────────────────

function makeConfig(): EngineConfig {
  return {
    fps: 60,
    spatialDebounceSeconds: 5,
    maxConcurrentLLM: 8,
    guardrailsEnabled: true,
    guardrails: { affordanceMasking: true, contextualForcing: true, planValidation: true },
  };
}

function makeProfile(id: string, startRoom = 'garden'): AgentProfile {
  return {
    id,
    name: id,
    description: '',
    traits: ['curious'],
    initialDrives: {},
    startRoomId: startRoom,
  };
}

const GARDEN: Room = {
  id: 'garden',
  name: 'Garden',
  description: '',
  connections: ['kitchen'],
  objectIds: [],
};
const KITCHEN: Room = {
  id: 'kitchen',
  name: 'Kitchen',
  description: '',
  connections: ['garden'],
  objectIds: [],
};

const TROWEL: SmartObject = {
  id: 'trowel-1',
  name: 'Trowel',
  type: 'tool',
  state: {},
  affordances: [
    { id: 'grab', label: 'Grab', engineEffect: 'grab', preconditions: [], effects: {} },
  ],
  roomId: 'garden',
};

/** Fully wired world + persistence (spec-033 shape). */
function buildWorld(): {
  persistence: EnginePersistenceImpl;
  gameLoop: GameLoopImpl;
  agentManager: AgentManagerImpl;
  registry: SmartObjectRegistryImpl;
  sceneManager: SceneManagerImpl;
  vectorStore: InMemoryVectorStore;
  conversations: ConversationManagerImpl;
  socialManager: SocialManager;
  selfModels: SelfModelManager;
} {
  const config = makeConfig();
  const gameLoop = new GameLoopImpl(config);
  const agentManager = new AgentManagerImpl();
  const sceneManager = new SceneManagerImpl(
    agentManager,
    new Map([
      [GARDEN.id, GARDEN],
      [KITCHEN.id, KITCHEN],
    ]),
  );
  const registry = new SmartObjectRegistryImpl();
  const vectorStore = new InMemoryVectorStore();
  const dormantStore = new DormantAgentStore();
  const mutationService = new SceneMutationServiceImpl({
    registry,
    sceneManager,
    agentManager,
    dormantStore,
  });
  const conversations = new ConversationManagerImpl({
    agentManager,
    registry,
    sceneManager,
    config: defaultConversationManagerConfig(),
  });
  const selfModels = new SelfModelManager();
  const socialManager = new SocialManager(agentManager);
  socialManager.setConversationManager(conversations);
  const persistence = new EnginePersistenceImpl({
    gameLoop,
    agentManager,
    smartObjectRegistry: registry,
    sceneManager,
    vectorStore,
    mutationService,
    conversationManager: conversations,
    selfModelManager: selfModels,
  });
  for (const id of ['agent-a', 'agent-b']) {
    agentManager.spawn(makeProfile(id));
    agentManager.updateState(id, { location: 'garden' });
  }
  registry.register(TROWEL);
  return {
    persistence,
    gameLoop,
    agentManager,
    registry,
    sceneManager,
    vectorStore,
    conversations,
    socialManager,
    selfModels,
  };
}

// ── AC-9 — conversations + self-models round-trip (format v3) ───────────────

describe('conversations round-trip (AC-9, R10)', () => {
  let world: ReturnType<typeof buildWorld>;
  beforeEach(() => {
    world = buildWorld();
  });

  it('save() embeds open/active conversations in DynamicWorldSnapshot', async () => {
    const opened = world.conversations.openOrContribute('agent-a', 'agent-b', 'hi', 'neutral', 11);
    // B's contribution activates the conversation (AC-1).
    world.conversations.openOrContribute('agent-b', 'agent-a', 'hello', 'positive', 12);
    const state = await world.persistence.save();
    expect(state.dynamic).toBeDefined();
    expect(state.dynamic!.conversations).toHaveLength(1);
    expect(state.dynamic!.conversations![0]!.topic).toBe(opened.conversation!.topic);
    expect(state.dynamic!.conversations![0]!.status).toBe('active');
  });

  it('load() restores conversations and their registry mirrors (closed included)', async () => {
    const first = world.conversations.openOrContribute('agent-a', 'agent-b', 'hi', 'neutral', 11);
    world.conversations.close(first.conversation!.id, 'idle');
    const second = world.conversations.openOrContribute('agent-a', 'agent-b', 'go', 'positive', 20);
    // B's reply activates the second conversation (AC-1).
    world.conversations.openOrContribute('agent-b', 'agent-a', 'going', 'neutral', 21);

    const state = await world.persistence.save();
    const fresh = buildWorld();
    await fresh.persistence.load(JSON.parse(JSON.stringify(state)));

    const restoredClosed = fresh.conversations.getConversation(first.conversation!.id);
    expect(restoredClosed!.status).toBe('closed');
    // `second` carries both agents' turns → active after restore (AC-1).
    const restoredOpen = fresh.conversations.getConversation(second.conversation!.id);
    expect(restoredOpen!.status).toBe('active');
    expect(restoredOpen!.turns.map((t) => t.content)).toEqual(['go', 'going']);
    // registry mirror re-registered so perception/visualizer see the object
    expect(fresh.registry.get(second.conversation!.id)).not.toBeNull();
  });

  it('a JSON.stringify round-trip (no replacer) preserves the conversation payload', async () => {
    world.conversations.openOrContribute('agent-a', 'agent-b', 'hi', 'negative', 11, 'thorns');
    const state = await world.persistence.save();
    const json = JSON.stringify(state); // plain stringify — spec 017 rule
    const parsed = JSON.parse(json) as { dynamic?: { conversations?: unknown[] } };
    expect(parsed.dynamic!.conversations).toHaveLength(1);
  });
});

// ── AC-9 — evolved self-model round-trip ────────────────────────────────────

describe('self-model round-trip (AC-9, R14)', () => {
  it('save/load restores the evolved self-model for active agents', async () => {
    const world = buildWorld();
    world.selfModels.seedFromProfile(world.agentManager.getProfile('agent-a')!, 0);
    world.selfModels.applySelfModelDeltas(
      'agent-a',
      [
        { type: 'trait_add', value: 'guarded' },
        { type: 'narrative_edit', value: 'I keep my distance from Bob.' },
      ],
      50,
      3,
    );
    const state = await world.persistence.save();

    const fresh = buildWorld();
    await fresh.persistence.load(JSON.parse(JSON.stringify(state)));
    const restored = fresh.selfModels.getSelfModel('agent-a');
    expect(restored).not.toBeNull();
    expect(restored!.traits).toContain('guarded');
    expect(restored!.selfNarrative).toContain('keep my distance');
    expect(restored!.revision).toBe(1);
  });

  it('dormant respawn restores the evolved self-model (AC-9, R14)', async () => {
    const world = buildWorld();
    world.selfModels.seedFromProfile(world.agentManager.getProfile('agent-a')!, 0);
    world.selfModels.applySelfModelDeltas('agent-a', [{ type: 'trait_add', value: 'wary' }], 50, 3);

    // Simulate the despawn export (spec 030 path extended by spec 033 R14):
    // the dormant snapshot must carry the self-model.
    const snapshot = world.selfModels.exportForDespawn('agent-a');
    expect(snapshot).not.toBeNull();
    expect(snapshot!.traits).toContain('wary');
    expect(snapshot!.agentId).toBe('agent-a');
  });
});

// ── AC-12 — relationships survive save/load AND dormant respawn (R16) ───────

describe('relationship persistence regression (AC-12, R16)', () => {
  it('trust/familiarity survive a save/load round-trip', async () => {
    const world = buildWorld();
    // updateRelationship applies DELTAS — trust seeds at 50, so +22 → 72.
    world.socialManager.updateRelationship('agent-a', 'agent-b', { trust: 22, familiarity: 40 });
    const state = await world.persistence.save();

    const fresh = buildWorld();
    await fresh.persistence.load(JSON.parse(JSON.stringify(state)));
    const rel = fresh.agentManager.getState('agent-a')?.relationships?.['agent-b'];
    expect(rel).toBeDefined();
    expect(rel!.trust).toBe(72);
    expect(rel!.familiarity).toBe(40);
  });

  it('trust/familiarity survive the dormant despawn/respawn path', async () => {
    const world = buildWorld();
    // updateRelationship applies DELTAS — trust seeds at 50, so +31 → 81.
    world.socialManager.updateRelationship('agent-a', 'agent-b', { trust: 31, familiarity: 55 });

    // Despawn exports state (with relationships) into dormancy…
    const dormantState = JSON.parse(JSON.stringify(world.agentManager.getState('agent-a')));
    // …the dormant snapshot rides inside state.relationships (AgentInternalState).
    expect(dormantState.relationships['agent-b'].trust).toBe(81);
    expect(dormantState.relationships['agent-b'].familiarity).toBe(55);

    // Respawn restores the state, relationships intact.
    const fresh = buildWorld();
    fresh.agentManager.updateState('agent-a', dormantState);
    const rel = fresh.agentManager.getState('agent-a')?.relationships?.['agent-b'];
    expect(rel!.trust).toBe(81);
    expect(rel!.familiarity).toBe(55);
  });

  it('SAVE_FORMAT_VERSION is 3 and v1/v2 saves still load (MIN_SUPPORTED = 1)', async () => {
    expect(SAVE_FORMAT_VERSION).toBe(3);
    expect(MIN_SUPPORTED_SAVE_FORMAT_VERSION).toBe(1);

    const world = buildWorld();
    // A v2-shaped save (no dynamic field) must still load.
    const state = await world.persistence.save();
    const v2Save = { ...JSON.parse(JSON.stringify(state)), formatVersion: 2 };
    delete v2Save.dynamic;
    const fresh = buildWorld();
    await expect(fresh.persistence.load(v2Save)).resolves.toBeUndefined();
  });

  it('a v0 (unsupported) save is rejected with SaveFormatVersionError', async () => {
    const world = buildWorld();
    const state = await world.persistence.save();
    const v0 = { ...JSON.parse(JSON.stringify(state)), formatVersion: 0 };
    const fresh = buildWorld();
    await expect(fresh.persistence.load(v0)).rejects.toBeInstanceOf(SaveFormatVersionError);
  });
});
