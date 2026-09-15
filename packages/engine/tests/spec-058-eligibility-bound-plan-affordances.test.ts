/**
 * Spec 058 — Eligibility-Bound Plan Affordances (engine side, issue #206)
 * ═══════════════════════════════════════════════════════════════════════
 * R1 — `getVisibleAffordancesInRoom` composes the spec-033 conversation
 *      eligibility projection with the spec-039 fog filter. The plan enum's
 *      value space therefore becomes the agent's moment-scoped eligible set.
 * R2 — ownership is resolved per OBJECT, never by looking up an affordance id
 *      across the room's flat list (`observe` collides with non-conversation
 *      objects).
 *
 * Deterministic throughout — no LLM anywhere.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { Affordance, AgentProfile, Room, SmartObject } from '@evol-hive/shared';
import { AgentManagerImpl } from '../src/agents/state/index.js';
import { SmartObjectRegistryImpl } from '../src/world/objects/index.js';
import { SceneManagerImpl } from '../src/world/scenes/index.js';
import {
  ConversationManagerImpl,
  defaultConversationManagerConfig,
} from '../src/social/conversation-manager.js';
import { PerceptionDataProviderImpl } from '../src/agents/perception/index.js';
import { DriveSystemImpl } from '../src/agents/drives/index.js';
import { SystemFeedbackStore } from '../src/agents/feedback/index.js';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const GARDEN = 'garden';
const WORKSHOP = 'workshop';

function makeProfile(id: string, startRoom = GARDEN): AgentProfile {
  return {
    id,
    name: id,
    description: `agent ${id}`,
    traits: [],
    initialDrives: {},
    startRoomId: startRoom,
  };
}

function makeAffordance(id: string, effects: Record<string, number> = {}): Affordance {
  return { id, label: id, engineEffect: id, preconditions: [], effects };
}

const ROOMS: Room[] = [
  { id: GARDEN, name: 'Garden', description: '', connections: [WORKSHOP], objectIds: [] },
  { id: WORKSHOP, name: 'Workshop', description: '', connections: [GARDEN], objectIds: [] },
];

/** The garden trowel — a non-conversation object with the `grab` affordance. */
const TROWEL: SmartObject = {
  id: 'trowel-1',
  name: 'Trowel',
  type: 'tool',
  state: {},
  affordances: [makeAffordance('grab')],
  roomId: GARDEN,
};

const CONVERSATION_IDS = ['join', 'contribute', 'leave', 'observe'] as const;

interface World {
  agentManager: AgentManagerImpl;
  registry: SmartObjectRegistryImpl;
  sceneManager: SceneManagerImpl;
  conversations: ConversationManagerImpl;
  perception: PerceptionDataProviderImpl;
}

function buildWorld(): World {
  const agentManager = new AgentManagerImpl();
  const registry = new SmartObjectRegistryImpl();
  registry.register(TROWEL);
  const sceneManager = new SceneManagerImpl(agentManager, new Map(ROOMS.map((r) => [r.id, r])));
  const conversations = new ConversationManagerImpl({
    agentManager,
    registry,
    sceneManager,
    config: defaultConversationManagerConfig(),
  });
  const perception = new PerceptionDataProviderImpl(
    agentManager,
    registry,
    new DriveSystemImpl(agentManager, 0.1),
    new SystemFeedbackStore(),
  );
  perception.setConversationManager(conversations);
  for (const id of ['agent-a', 'agent-b', 'agent-c']) {
    agentManager.spawn(makeProfile(id));
    agentManager.updateState(id, { location: GARDEN });
  }
  return { agentManager, registry, sceneManager, conversations, perception };
}

function ids(affordances: Affordance[]): string[] {
  return affordances.map((a) => a.id);
}

function openConversation(world: World): string {
  const opened = world.conversations.openOrContribute('agent-a', 'agent-b', 'hi', 'neutral', 1);
  expect(opened.success).toBe(true);
  return opened.conversation!.id;
}

// ── AC-1 (R1) — eligibility composition in getVisibleAffordancesInRoom ───────

describe('spec 058 AC-1 — conversation eligibility composes into visible affordances', () => {
  let world: World;
  beforeEach(() => {
    world = buildWorld();
  });

  it('an open conversation in the room yields contribute/leave to a participant, never join', () => {
    openConversation(world);
    const visible = ids(world.perception.getVisibleAffordancesInRoom('agent-a', GARDEN));
    expect(visible).toContain('contribute');
    expect(visible).toContain('leave');
    expect(visible).not.toContain('join');
    // Non-conversation affordances pass through (R1).
    expect(visible).toContain('grab');
  });

  it('a co-located non-participant sees join/observe, never contribute/leave', () => {
    openConversation(world);
    const visible = ids(world.perception.getVisibleAffordancesInRoom('agent-c', GARDEN));
    expect(visible).toContain('join');
    expect(visible).toContain('observe');
    expect(visible).not.toContain('contribute');
    expect(visible).not.toContain('leave');
    expect(visible).toContain('grab');
  });

  it('a closed conversation contributes none of the four affordances', () => {
    const conversationId = openConversation(world);
    world.conversations.close(conversationId, 'test');
    const visibleParticipant = ids(world.perception.getVisibleAffordancesInRoom('agent-a', GARDEN));
    const visibleBystander = ids(world.perception.getVisibleAffordancesInRoom('agent-c', GARDEN));
    for (const id of CONVERSATION_IDS) {
      expect(visibleParticipant).not.toContain(id);
      expect(visibleBystander).not.toContain(id);
    }
    expect(visibleParticipant).toContain('grab');
    expect(visibleBystander).toContain('grab');
  });

  it('with the conversation manager unwired, all four legacy affordances appear', () => {
    openConversation(world); // registers the conversation mirror in the registry
    const bare = new PerceptionDataProviderImpl(
      world.agentManager,
      world.registry,
      new DriveSystemImpl(world.agentManager, 0.1),
      new SystemFeedbackStore(),
    );
    const visible = ids(bare.getVisibleAffordancesInRoom('agent-a', GARDEN));
    for (const id of CONVERSATION_IDS) {
      expect(visible).toContain(id);
    }
    expect(visible).toContain('grab');
  });
});

// ── AC-2 (R1) — fog + eligibility compose in one call ────────────────────────

describe('spec 058 AC-2 — fog and eligibility compose without short-circuiting', () => {
  let world: World;
  beforeEach(() => {
    world = buildWorld();
    world.registry.register({
      id: 'door-garden',
      name: 'door',
      type: 'doorway',
      state: {},
      affordances: [makeAffordance('go_to_workshop')],
      roomId: GARDEN,
    });
    // The agent stands in the garden but has not yet seen the garden↔workshop door.
    world.agentManager.updateState('agent-c', {
      location: GARDEN,
      spatialMemory: {
        visitedRooms: [GARDEN],
        knownDoors: [],
        discoveredAt: { [GARDEN]: 1 },
      },
    });
  });

  it('an unknown go_to_<room> is fogged out in the same call that applies eligibility', () => {
    openConversation(world);
    const visible = ids(world.perception.getVisibleAffordancesInRoom('agent-c', GARDEN));
    expect(visible).not.toContain('go_to_workshop');
    // Eligibility still applied — the bystander sees join/observe.
    expect(visible).toContain('join');
    expect(visible).toContain('observe');
  });

  it('a known go_to_<room> survives while eligibility still filters conversation affordances', () => {
    openConversation(world);
    world.agentManager.updateState('agent-c', {
      spatialMemory: {
        visitedRooms: [GARDEN],
        knownDoors: [`${GARDEN}|${WORKSHOP}`],
        discoveredAt: { [GARDEN]: 1 },
      },
    });
    const visible = ids(world.perception.getVisibleAffordancesInRoom('agent-c', GARDEN));
    expect(visible).toContain('go_to_workshop');
    expect(visible).toContain('join');
    expect(visible).not.toContain('contribute');
  });
});

// ── AC-3 (R2) — per-object ownership resolution (collision safety) ───────────

describe('spec 058 AC-3 — duplicate affordance ids resolve per owning object', () => {
  let world: World;
  beforeEach(() => {
    world = buildWorld();
  });

  it('keeps a non-conversation observe when a closed conversation also declares observe', () => {
    const conversationId = openConversation(world);
    world.conversations.close(conversationId, 'test');
    // Registered AFTER the conversation mirror, so the old flat-id lookup would
    // attribute this object's `observe` to the (first) conversation owner.
    world.registry.register({
      id: 'bench-1',
      name: 'Bench',
      type: 'furniture',
      state: {},
      affordances: [makeAffordance('observe'), makeAffordance('contribute')],
      roomId: GARDEN,
    });
    const eligible = ids(world.perception.getEligibleAffordancesInRoom(GARDEN, 'agent-a'));
    // The closed conversation's observe/contribute are filtered, but the
    // unrelated object's duplicates are preserved.
    expect(eligible.filter((id) => id === 'observe')).toHaveLength(1);
    expect(eligible.filter((id) => id === 'contribute')).toHaveLength(1);
    expect(eligible).toContain('grab');
  });

  it('a conversation-only id from the conversation is dropped without touching unrelated ids', () => {
    const conversationId = openConversation(world);
    world.conversations.close(conversationId, 'test');
    const eligible = ids(world.perception.getEligibleAffordancesInRoom(GARDEN, 'agent-a'));
    expect(eligible).not.toContain('contribute');
    expect(eligible).not.toContain('join');
    expect(eligible).not.toContain('leave');
    expect(eligible).not.toContain('observe');
    expect(eligible).toContain('grab');
  });
});
