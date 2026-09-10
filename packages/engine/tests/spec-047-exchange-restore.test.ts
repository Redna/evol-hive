/**
 * Tests for spec 047 — Talk Loop Fix (issue #176) — engine layer (R6).
 *
 * Covers:
 * - R6 (detection): when a turn lands in a conversation by agent T, every
 *   other participant S whose contributions so far are unanswered messages
 *   (S has ≥ 1 prior turn in the thread) receives the deferred restore via the
 *   injected drive-apply callback — carrying SOCIAL_EXCHANGE_BONUS (8).
 * - AC-6 (idempotency): the +8 is granted exactly once per (sender,
 *   conversation) pair — re-contributions by the target (1..N turns),
 *   leave/rejoin, and multi-sender threads never double-grant.
 * - R6 (wiring shape): the callback is optional — without it the manager is
 *   inert and never breaks; the manager never touches drives itself (the
 *   applier is injected).
 * - AC-2 (engine side of the split): combined with the cognition-side +2 on
 *   send (covered in the cognition suite), the deferred +8 tops the sender up
 *   to the historical +10 for a real exchange.
 *
 * The cognition-side +2 and the production wiring (+2 on send through the
 * executor, +8 through the engine hook) are covered end-to-end in
 * examples/tests/spec-047-talk-loop-urge-gating.test.ts.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { AgentProfile } from '@evol-hive/shared';
import { SOCIAL_EXCHANGE_BONUS } from '@evol-hive/shared';
import { AgentManagerImpl } from '../src/agents/state/index.js';
import { DriveSystemImpl } from '../src/agents/drives/index.js';
import { SmartObjectRegistryImpl } from '../src/world/objects/index.js';
import { SceneManagerImpl } from '../src/world/scenes/index.js';
import { ConversationManagerImpl } from '../src/social/conversation-manager.js';
import { defaultConversationManagerConfig } from '../src/social/conversation-manager.js';

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
  driveSystem: DriveSystemImpl;
  conversationManager: ConversationManagerImpl;
  restores: Array<{ agentId: string; conversationId: string; amount: number }>;
}

function buildWorld(withCallback = true): World {
  const agentManager = new AgentManagerImpl();
  const driveSystem = new DriveSystemImpl(agentManager);
  const registry = new SmartObjectRegistryImpl();
  const sceneManager = new SceneManagerImpl(
    agentManager,
    new Map([
      [GARDEN, { id: GARDEN, name: GARDEN, description: '', connections: [KITCHEN], objectIds: [] }],
      [KITCHEN, { id: KITCHEN, name: KITCHEN, description: '', connections: [GARDEN], objectIds: [] }],
    ]),
  );
  const restores: World['restores'] = [];
  const conversationManager = new ConversationManagerImpl({
    agentManager,
    registry,
    sceneManager,
    config: defaultConversationManagerConfig(),
    ...(withCallback
      ? {
          onExchangeRestore: (agentId: string, conversationId: string, amount: number) => {
            restores.push({ agentId, conversationId, amount });
            driveSystem.applyChanges(agentId, { social: amount });
          },
        }
      : {}),
  });
  for (const id of ['agent-a', 'agent-b', 'agent-c']) {
    agentManager.spawn(makeProfile(id, GARDEN));
    agentManager.updateState(id, { location: GARDEN });
  }
  return { agentManager, driveSystem, conversationManager, restores };
}

/** A's monologue: open the thread (the executor's +2 is cognition-side). */
function monologue(world: World, from: string, to: string, tick: number): string {
  const result = world.conversationManager.openOrContribute(from, to, 'hello', 'neutral', tick);
  expect(result.success).toBe(true);
  return result.conversationId!;
}

let world: World;
beforeEach(() => {
  world = buildWorld();
});

// ── R6 — exchange-completion detection & deferred restore ────────────────────

describe('exchange-completion detection (R6)', () => {
  it('a target contributing to a thread where the sender previously monologued grants the +8 to the sender', () => {
    world.agentManager.getState('agent-a')!.drives.social = 40; // below the clamp
    const before = world.agentManager.getState('agent-a')!.drives.social;
    const conversationId = monologue(world, 'agent-a', 'agent-b', 10);
    expect(world.restores).toEqual([]); // the monologue itself restores nothing engine-side

    world.conversationManager.contribute('agent-b', conversationId, 'hi back', 'neutral', 11);

    expect(world.restores).toEqual([
      { agentId: 'agent-a', conversationId, amount: SOCIAL_EXCHANGE_BONUS },
    ]);
    const after = world.agentManager.getState('agent-a')!.drives.social;
    expect(after - before).toBe(8);
  });

  it('the callback carries the conversation id and the SOCIAL_EXCHANGE_BONUS amount (AC-2 split)', () => {
    const conversationId = monologue(world, 'agent-a', 'agent-b', 10);
    world.conversationManager.contribute('agent-b', conversationId, 'reply', 'neutral', 11);
    expect(world.restores[0]!.amount).toBe(8);
    expect(world.restores[0]!.conversationId).toBe(conversationId);
  });

  it('a silent participant (no prior turns in the thread) is not topped up', () => {
    const conversationId = monologue(world, 'agent-a', 'agent-b', 10);
    // C joins and speaks; A monologued (gets topped up), B never sent anything.
    world.conversationManager.join('agent-c', conversationId, 11);
    world.conversationManager.contribute('agent-c', conversationId, 'hello all', 'neutral', 12);
    expect(world.restores.map((r) => r.agentId)).toEqual(['agent-a']);
  });

  it('without the injected callback the manager is inert (no crash, no drives touched)', () => {
    const bare = buildWorld(false);
    const conversationId = monologue(bare, 'agent-a', 'agent-b', 10);
    expect(() =>
      bare.conversationManager.contribute('agent-b', conversationId, 'reply', 'neutral', 11),
    ).not.toThrow();
    expect(bare.restores).toEqual([]);
  });
});

// ── AC-6 — idempotency ───────────────────────────────────────────────────────

describe('deferred restore idempotency (AC-6)', () => {
  it('the target contributing 1..N turns grants the +8 exactly once per (sender, conversation)', () => {
    const conversationId = monologue(world, 'agent-a', 'agent-b', 10);
    for (let tick = 11; tick <= 15; tick++) {
      world.conversationManager.contribute(
        'agent-b',
        conversationId,
        `reply ${tick}`,
        'neutral',
        tick,
      );
    }
    expect(world.restores).toHaveLength(1);
    expect(world.restores[0]).toEqual({
      agentId: 'agent-a',
      conversationId,
      amount: 8,
    });
  });

  it('leave + rejoin never re-grants: the sender is topped up once per conversation', () => {
    const conversationId = monologue(world, 'agent-a', 'agent-b', 10);
    world.conversationManager.contribute('agent-b', conversationId, 'reply', 'neutral', 11);
    expect(world.restores).toHaveLength(1);

    // A leaves, rejoins, B contributes again — still exactly one grant.
    world.conversationManager.leave('agent-a', conversationId, 12);
    world.conversationManager.join('agent-a', conversationId, 13);
    world.conversationManager.contribute('agent-b', conversationId, 'again', 'neutral', 14);
    expect(world.restores).toHaveLength(1);
  });

  it('multi-sender threads: each sender is topped up at most once, no double-granting', () => {
    // A opens the thread with B (A's monologue); C joins and also speaks.
    const conversationId = monologue(world, 'agent-a', 'agent-b', 10);
    world.conversationManager.join('agent-c', conversationId, 11);

    // C's turn: A (monologuer) gets topped up; B (silent so far) does not.
    world.conversationManager.contribute('agent-c', conversationId, 'hello all', 'neutral', 12);
    expect(world.restores.map((r) => r.agentId)).toEqual(['agent-a']);

    // B replies: C (monologuer) gets topped up; A is already granted.
    world.conversationManager.contribute('agent-b', conversationId, 'hi', 'neutral', 13);
    expect(world.restores.map((r) => r.agentId)).toEqual(['agent-a', 'agent-c']);

    // A's turn answers B's "hi" — B is now a topped-up sender too.
    world.conversationManager.contribute('agent-a', conversationId, 'great', 'neutral', 14);
    expect(world.restores.map((r) => r.agentId)).toEqual(['agent-a', 'agent-c', 'agent-b']);

    // Further turns by anyone change nothing — every sender is already granted.
    world.conversationManager.contribute('agent-c', conversationId, 'nice', 'neutral', 15);
    world.conversationManager.contribute('agent-b', conversationId, 'cool', 'neutral', 16);
    expect(world.restores).toHaveLength(3);
    expect(world.restores.every((r) => r.amount === 8)).toBe(true);
  });

  it('the restore does not fire when the "reply" comes from the sender themselves', () => {
    const conversationId = monologue(world, 'agent-a', 'agent-b', 10);
    world.conversationManager.contribute('agent-a', conversationId, 'hello again', 'neutral', 11);
    expect(world.restores).toEqual([]);
  });
});

// ── AC-2 — the split tops up to the historical +10 ───────────────────────────

describe('exchange restores social as a real exchange does (AC-2, engine side)', () => {
  it('the drive delta across send (+2) and the target reply (+8) is the historical +10', () => {
    // Start below the clamp so both grants are visible.
    world.agentManager.getState('agent-a')!.drives.social = 40;

    // Cognition-side grant on send (R5 — asserted precisely in the cognition
    // suite); here it is simulated through the same DriveSystem path.
    world.driveSystem.applyChanges('agent-a', { social: 2 });
    const afterSend = world.agentManager.getState('agent-a')!.drives.social;
    expect(afterSend).toBe(42);

    // The target replies into the thread → engine-side deferred restore.
    const conversationId = monologue(world, 'agent-a', 'agent-b', 10);
    world.conversationManager.contribute('agent-b', conversationId, 'reply', 'neutral', 11);
    const afterReply = world.agentManager.getState('agent-a')!.drives.social;
    expect(afterReply).toBe(50);
    expect(afterReply - 40).toBe(10); // total across the two events: +10
  });
});