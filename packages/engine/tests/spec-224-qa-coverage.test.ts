/**
 * QA coverage for issue #224 (PR #227) — gaps left by
 * `spec-224-conversation-mirror-lifecycle.test.ts`.
 *
 * The PR pins the leak fix (registry + `room.objectIds` removal on close, the
 * restore path, idempotency, and the do-not-over-remove direction). What its
 * suite does not pin is the *other half* of the issue's design direction —
 * "**keeping the conversation record in the manager for consolidation/history**"
 * — nor the PR's explicit ordering claim that "removal runs before
 * `consolidate` … so the mirror is gone even if the consolidation sink throws".
 *
 * These tests close that gap:
 *   AC-HIST (issue #224 Direction): after close the conversation record is
 *     retained in the manager and exported with the persistence snapshot —
 *     history is not deleted along with the mirror.
 *   AC-CONS (spec 033 R5): close still produces per-participant `interaction`
 *     memories; the mirror fix did not replace consolidation.
 *   AC-ORDER (PR #227 design): the mirror is already removed *at the moment*
 *     consolidation runs, and stays removed even if the consolidation sink
 *     throws.
 *
 * No implementation is modified; these are additive tests only.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { AgentManagerImpl } from '../src/agents/state/index.js';
import { SmartObjectRegistryImpl } from '../src/world/objects/index.js';
import { SceneManagerImpl } from '../src/world/scenes/index.js';
import {
  ConversationManagerImpl,
  defaultConversationManagerConfig,
} from '../src/social/conversation-manager.js';
import type { AgentProfile, MemoryEntryInput } from '@evol-hive/shared';

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

interface World {
  agentManager: AgentManagerImpl;
  registry: SmartObjectRegistryImpl;
  sceneManager: SceneManagerImpl;
  manager: ConversationManagerImpl;
  stored: Array<{ agentId: string; entry: MemoryEntryInput }>;
}

/** Build a world whose consolidation sink is injectable. */
function buildWorld(
  sink?: (
    registry: SmartObjectRegistryImpl,
    sceneManager: SceneManagerImpl,
  ) => {
    storeInteraction(agentId: string, entry: MemoryEntryInput): void;
  },
): World {
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
  const stored: Array<{ agentId: string; entry: MemoryEntryInput }> = [];
  const manager = new ConversationManagerImpl({
    agentManager,
    registry,
    sceneManager,
    config: defaultConversationManagerConfig(),
    consolidationSink:
      sink !== undefined
        ? sink(registry, sceneManager)
        : {
            storeInteraction(agentId: string, entry: MemoryEntryInput): void {
              stored.push({ agentId, entry });
            },
          },
  });
  for (const id of ['agent-a', 'agent-b', 'agent-c']) {
    agentManager.spawn(makeProfile(id, GARDEN));
    agentManager.updateState(id, { location: GARDEN });
  }
  return { agentManager, registry, sceneManager, manager, stored };
}

describe('spec 224 QA — history retained, consolidation intact, removal ordering', () => {
  let world: World;

  beforeEach(() => {
    world = buildWorld();
  });

  function openOne(tick = 10): string {
    const result = world.manager.openOrContribute('agent-a', 'agent-b', 'hello', 'neutral', tick);
    expect(result.success).toBe(true);
    return result.conversation!.id;
  }

  function roomObjectIds(): string[] {
    return world.sceneManager.getRoom(GARDEN)!.objectIds;
  }

  // ── AC-HIST: the record survives; the mirror does not ─────────────────────

  it('retains the CLOSED conversation record in the manager after the mirror is removed', () => {
    const id = openOne();

    world.manager.close(id, 'done');

    const kept = world.manager.getConversation(id);
    expect(kept, 'the conversation record must be retained for history').not.toBeNull();
    expect(kept!.status).toBe('closed');
    // The mirror is gone; the record is not.
    expect(world.registry.get(id)).toBeNull();
  });

  it('exports the closed conversation with the persistence snapshot (history, not just the live thread)', () => {
    const id = openOne();
    world.manager.close(id, 'done');

    const exported = world.manager.exportConversations();
    const record = exported.find((c) => c.id === id);
    expect(record, 'closed conversations stay in the export (spec 033 R10/AC-9)').toBeDefined();
    expect(record!.status).toBe('closed');
  });

  // ── AC-CONS: close-time consolidation still happens ───────────────────────

  it('still consolidates per-participant interaction memories when the conversation closes', () => {
    const id = openOne();
    world.manager.close(id, 'done');

    expect(world.stored.map((s) => s.agentId).sort()).toEqual(['agent-a', 'agent-b']);
    expect(world.stored.every((s) => s.entry.type === 'interaction')).toBe(true);
    // And the fix still removed the mirror in the same close.
    expect(world.registry.get(id)).toBeNull();
    expect(roomObjectIds()).not.toContain(id);
  });

  // ── AC-ORDER: removal precedes consolidation, and survives a sink throw ───

  it('has already removed the mirror when the consolidation sink runs (removal before consolidate)', () => {
    const duringConsolidation: Array<{
      conversationMirrors: number;
      roomObjectIds: string[];
    }> = [];
    const orderingWorld = buildWorld((registry, sceneManager) => ({
      storeInteraction(): void {
        duringConsolidation.push({
          conversationMirrors: registry.getAll().filter((o) => o.type === 'conversation').length,
          roomObjectIds: [...sceneManager.getRoom(GARDEN)!.objectIds],
        });
      },
    }));
    const id = orderingWorld.manager.openOrContribute('agent-a', 'agent-b', 'hello', 'neutral', 10)
      .conversation!.id;

    orderingWorld.manager.close(id, 'done');

    // The sink ran (once per participant) and, at that moment, the mirror was
    // already gone from both halves of registration.
    expect(duringConsolidation).toHaveLength(2);
    expect(duringConsolidation.every((s) => s.conversationMirrors === 0)).toBe(true);
    expect(duringConsolidation.every((s) => !s.roomObjectIds.includes(id))).toBe(true);
  });

  it('leaves the room clean even when the consolidation sink throws', () => {
    const throwingWorld = buildWorld(() => ({
      storeInteraction(): void {
        throw new Error('consolidation sink exploded');
      },
    }));
    const result = throwingWorld.manager.openOrContribute(
      'agent-a',
      'agent-b',
      'hello',
      'neutral',
      10,
    );
    const id = result.conversation!.id;
    expect(throwingWorld.registry.get(id)).not.toBeNull();

    // The sink throws out of `close`, but removal already ran before it.
    expect(() => throwingWorld.manager.close(id, 'done')).toThrow('consolidation sink exploded');

    expect(throwingWorld.registry.get(id)).toBeNull();
    expect(throwingWorld.sceneManager.getRoom(GARDEN)!.objectIds).not.toContain(id);
    expect(throwingWorld.manager.getConversation(id)!.status).toBe('closed');
  });
});
