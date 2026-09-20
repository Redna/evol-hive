/**
 * Issue #224 — a closed conversation must leave no trace in room state.
 *
 * The leak: `syncMirror` registered a `Conversation: <topic>` SmartObject and
 * pushed its id into `room.objectIds`, while `close()` only patched that mirror's
 * state. Nothing ever removed it, so every conversation ever opened kept adding
 * an object plus its four CONVERSATION_AFFORDANCES to the room. Observed live:
 * `objects=76 conversationObjects=62` after 26 minutes, with dead chips tiling
 * the visualizer. The blast radius was not only rendering — `room.objectIds` is
 * what perception reads (`assembly` builds `objectIds` from it) and
 * `getAffordancesInRoom` is what grows with each mirror, so the plan prompt's
 * tool enum inflated too.
 *
 * The invariant under test: **a closed conversation has no mirror.** It is
 * enforced in `syncMirror` so every path upholds it — `close`, `commit`, and
 * `restoreConversations` (a legacy snapshot can still contain closed ones).
 *
 * Both directions matter equally here: the tests below also pin the OPPOSITE
 * failure, because "fix the leak by removing too much" would silently break live
 * conversations.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { AgentManagerImpl } from '../src/agents/state/index.js';
import { SmartObjectRegistryImpl } from '../src/world/objects/index.js';
import { SceneManagerImpl } from '../src/world/scenes/index.js';
import {
  ConversationManagerImpl,
  defaultConversationManagerConfig,
} from '../src/social/conversation-manager.js';
import type { AgentProfile, ConversationObject } from '@evol-hive/shared';

const GARDEN = 'garden';
const KITCHEN = 'kitchen';

function makeProfile(id: string, startRoom: string): AgentProfile {
  return {
    id,
    name: id,
    description: '',
    traits: [],
    initialDrives: {},
    startRoomId: startRoom,
  };
}

function buildWorld(): {
  agentManager: AgentManagerImpl;
  registry: SmartObjectRegistryImpl;
  sceneManager: SceneManagerImpl;
  manager: ConversationManagerImpl;
} {
  const agentManager = new AgentManagerImpl();
  const registry = new SmartObjectRegistryImpl();
  const sceneManager = new SceneManagerImpl(
    agentManager,
    new Map([
      [
        GARDEN,
        { id: GARDEN, name: GARDEN, description: '', connections: [KITCHEN], objectIds: [] },
      ],
      [
        KITCHEN,
        { id: KITCHEN, name: KITCHEN, description: '', connections: [GARDEN], objectIds: [] },
      ],
    ]),
  );
  const manager = new ConversationManagerImpl({
    agentManager,
    registry,
    sceneManager,
    config: defaultConversationManagerConfig(),
    consolidationSink: { storeInteraction: (): void => {} },
  });
  for (const id of ['agent-a', 'agent-b', 'agent-c']) {
    agentManager.spawn(makeProfile(id, GARDEN));
    agentManager.updateState(id, { location: GARDEN });
  }
  return { agentManager, registry, sceneManager, manager };
}

describe('conversation mirror lifecycle — issue #224', () => {
  let world: ReturnType<typeof buildWorld>;

  beforeEach(() => {
    world = buildWorld();
  });

  /** Open a conversation and return its id. */
  function openOne(tick: number): string {
    const result = world.manager.openOrContribute('agent-a', 'agent-b', 'hello', 'neutral', tick);
    expect(result.success).toBe(true);
    return result.conversation!.id;
  }

  function roomObjectIds(): string[] {
    return world.sceneManager.getRoom(GARDEN)!.objectIds;
  }

  function perceivedIds(): string[] {
    return world.registry.getObjectsInRoom(GARDEN).map((o) => o.id);
  }

  function conversationMirrorCount(): number {
    return world.registry.getAll().filter((o) => o.type === 'conversation').length;
  }

  // ── the leak itself ────────────────────────────────────────────────────────

  it('removes the mirror from the registry AND the room when a conversation closes', () => {
    const id = openOne(10);
    expect(world.registry.get(id)).not.toBeNull();
    expect(roomObjectIds()).toContain(id);

    world.manager.close(id, 'done');

    expect(world.registry.get(id)).toBeNull();
    // The room half is the one perception reads; registry removal alone would
    // leave a dangling id behind and the object would still be enumerated.
    expect(roomObjectIds()).not.toContain(id);
  });

  it('stops being perceivable in its room once closed', () => {
    const id = openOne(10);
    expect(perceivedIds()).toContain(id);

    world.manager.close(id, 'done');

    expect(perceivedIds()).not.toContain(id);
  });

  it('leaves room state at its baseline across repeated open/close cycles (no drift)', () => {
    const baselineIds = [...roomObjectIds()];
    const baselineAffordances = world.registry.getAffordancesInRoom(GARDEN).length;

    for (let i = 0; i < 5; i += 1) {
      const id = openOne(20 + i * 2);
      world.manager.close(id, 'done');
    }

    expect(roomObjectIds()).toEqual(baselineIds);
    expect(world.registry.getAffordancesInRoom(GARDEN)).toHaveLength(baselineAffordances);
    expect(conversationMirrorCount()).toBe(0);
  });

  it('does not grow the room affordance list with the number of conversations ever opened', () => {
    // The leak's mechanism: every mirror carried four CONVERSATION_AFFORDANCES,
    // and getAffordancesInRoom does not dedupe, so the enum grew per conversation.
    const first = openOne(10);
    const withOneOpen = world.registry.getAffordancesInRoom(GARDEN).length;
    world.manager.close(first, 'done');

    for (let i = 0; i < 4; i += 1) {
      const id = openOne(20 + i * 2);
      world.manager.close(id, 'done');
    }

    const current = openOne(40);
    expect(world.registry.getAffordancesInRoom(GARDEN)).toHaveLength(withOneOpen);
    world.manager.close(current, 'done');
  });

  // ── the opposite failure: do not over-remove ───────────────────────────────

  it('keeps an OPEN conversation registered, perceivable and offering its affordances', () => {
    const id = openOne(10);

    expect(world.registry.get(id)).not.toBeNull();
    expect(roomObjectIds()).toContain(id);
    expect(perceivedIds()).toContain(id);

    const affordanceIds = world.registry.getAffordancesInRoom(GARDEN).map((a) => a.id);
    expect(affordanceIds).toContain('join');
    expect(affordanceIds).toContain('contribute');
  });

  it('closing one conversation does not disturb another that is still open', () => {
    const first = openOne(10);
    world.manager.close(first, 'done');
    const second = openOne(20);

    // A later (idempotent) close of the older conversation must not touch `second`.
    world.manager.close(first, 'done again');

    expect(world.registry.get(second)).not.toBeNull();
    expect(roomObjectIds()).toContain(second);
    expect(world.registry.get(first)).toBeNull();
  });

  it('is idempotent for double closes and for unknown ids', () => {
    const id = openOne(10);
    world.manager.close(id, 'done');

    expect(() => world.manager.close(id, 'done again')).not.toThrow();
    expect(() => world.manager.close('conv-does-not-exist', 'x')).not.toThrow();
    expect(conversationMirrorCount()).toBe(0);
  });

  // ── the second leak path: restoring a snapshot ─────────────────────────────

  it('does not resurrect a mirror when restoring a snapshot containing a CLOSED conversation', () => {
    const id = openOne(10);
    const open = world.manager.getOpenConversationBetween('agent-a', 'agent-b')!;
    const closedSnapshot: ConversationObject = {
      ...open,
      status: 'closed',
      closedAt: open.lastActivity,
    };

    world.manager.close(id, 'done');
    world.manager.restoreConversations([closedSnapshot]);

    expect(world.registry.get(id)).toBeNull();
    expect(roomObjectIds()).not.toContain(id);
  });

  it('still mirrors an OPEN conversation restored from a snapshot', () => {
    const id = openOne(10);
    const open = world.manager.getOpenConversationBetween('agent-a', 'agent-b')!;

    world.manager.close(id, 'done');
    expect(world.registry.get(id)).toBeNull();

    world.manager.restoreConversations([open]);

    expect(world.registry.get(id)).not.toBeNull();
    expect(roomObjectIds()).toContain(id);
  });
});
