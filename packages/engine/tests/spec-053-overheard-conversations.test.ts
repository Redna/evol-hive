/**
 * Tests for spec 053 — Room-Perceivable Conversation Content (issue #192)
 * — engine layer: the deterministic overheard provider and the upgraded
 * `observe`.
 *
 * Covers:
 * - AC-1 (R1): a co-located non-participant's provider result contains the
 *   open/active conversation of their room with bounded, latest-first lines;
 *   no affordance invocation involved — co-location is the only gate.
 * - AC-2 (R3): `observe` returns topic, participants, and the full
 *   rolling-window `turns` (agent, content, sentiment, tick — oldest first);
 *   the observing agent is NOT added to participants; a non-participant's
 *   eligible-affordance set still contains join/observe only (no contribute).
 * - AC-3 (R4): the same conversation is absent from the result of an agent in
 *   a different room; a participant gets no overheard entry for their own
 *   conversation (R5).
 * - AC-4 (R2): a conversation with 8 turns yields exactly 3 overheard lines,
 *   latest turn first (`availableLines` = 8); a 1-turn conversation yields
 *   exactly 1.
 * - AC-9: the provider path is pure TypeScript — no LLM anywhere.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { AgentManagerImpl } from '../src/agents/state/index.js';
import { SmartObjectRegistryImpl } from '../src/world/objects/index.js';
import { SceneManagerImpl } from '../src/world/scenes/index.js';
import {
  ConversationManagerImpl,
  defaultConversationManagerConfig,
} from '../src/social/conversation-manager.js';
import type { AgentProfile, ConversationSentiment } from '@evol-hive/shared';

// ── Fixtures ─────────────────────────────────────────────────────────────────

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
      [GARDEN, { id: GARDEN, name: GARDEN, description: '', connections: [KITCHEN], objectIds: [] }],
      [KITCHEN, { id: KITCHEN, name: KITCHEN, description: '', connections: [GARDEN], objectIds: [] }],
    ]),
  );
  const manager = new ConversationManagerImpl({
    agentManager,
    registry,
    sceneManager,
    config: defaultConversationManagerConfig(),
  });
  for (const id of ['agent-a', 'agent-b', 'agent-c']) {
    agentManager.spawn(makeProfile(id, GARDEN));
    agentManager.updateState(id, { location: GARDEN });
  }
  return { agentManager, registry, sceneManager, manager };
}

/**
 * Seed a conversation by script: each entry is [speaker, content, sentiment].
 * The first pair opens via openOrContribute (speaker → other); the rest are
 * direct contributions. Returns the conversation id.
 */
function seedConversation(
  world: ReturnType<typeof buildWorld>,
  script: Array<[speaker: string, other: string, content: string, sentiment: ConversationSentiment]>,
): string {
  const [first, ...rest] = script;
  const opened = world.manager.openOrContribute(
    first![0],
    first![1],
    first![2],
    first![3],
    100,
  );
  expect(opened.success).toBe(true);
  const id = opened.conversationId!;
  let tick = 101;
  for (const [speaker, , content, sentiment] of rest) {
    const result = world.manager.contribute(speaker, id, content, sentiment, tick++);
    expect(result.success).toBe(true);
  }
  return id;
}

// ── AC-1 (R1) — passive overheard perception ─────────────────────────────────

describe('spec 053 R1 — passive overheard provider (AC-1)', () => {
  let world: ReturnType<typeof buildWorld>;
  beforeEach(() => {
    world = buildWorld();
  });

  it('a co-located non-participant perceives the conversation without any affordance invocation', () => {
    // A ↔ B talk; C co-locates but never joins.
    const id = seedConversation(world, [
      ['agent-a', 'agent-b', 'the pump is clogged again', 'negative'],
      ['agent-b', '', 'I will bring a wrench', 'positive'],
    ]);

    const overheard = world.manager.getOverheardConversations('agent-c');
    expect(overheard).toHaveLength(1);
    const entry = overheard[0]!;
    expect(entry.conversationId).toBe(id);
    expect(entry.topic).toBe('a conversation');
    // Latest first (R2): B's reply renders before A's opening turn.
    expect(entry.lines).toHaveLength(2);
    expect(entry.lines[0]).toEqual({
      speakerId: 'agent-b',
      addresseeId: 'agent-a',
      content: 'I will bring a wrench',
    });
    expect(entry.lines[1]).toEqual({
      speakerId: 'agent-a',
      addresseeId: 'agent-b',
      content: 'the pump is clogged again',
    });
    expect(entry.availableLines).toBe(2);
  });

  it('an agent whose location is unknown receives nothing (no room, no overhearing)', () => {
    seedConversation(world, [
      ['agent-a', 'agent-b', 'hello', 'neutral'],
    ]);
    const ghost = 'agent-ghost';
    world.agentManager.spawn(makeProfile(ghost, GARDEN));
    world.agentManager.updateState(ghost, { location: '' });
    expect(world.manager.getOverheardConversations(ghost)).toHaveLength(0);
  });

  it('closed conversations are not overheard', () => {
    const id = seedConversation(world, [
      ['agent-a', 'agent-b', 'hello', 'neutral'],
      ['agent-b', '', 'hi', 'neutral'],
    ]);
    world.manager.leave('agent-a', id, 200);
    world.manager.leave('agent-b', id, 201); // last participant → closed
    expect(world.manager.getOverheardConversations('agent-c')).toHaveLength(0);
  });
});

// ── AC-3 (R4) — room walls ───────────────────────────────────────────────────

describe('spec 053 R4 — room-wall scope (AC-3)', () => {
  let world: ReturnType<typeof buildWorld>;
  beforeEach(() => {
    world = buildWorld();
  });

  it('the same conversation is absent from the result of an agent in a different room', () => {
    seedConversation(world, [
      ['agent-a', 'agent-b', 'garden things', 'neutral'],
    ]);
    world.agentManager.updateState('agent-c', { location: KITCHEN });
    expect(world.manager.getOverheardConversations('agent-c')).toHaveLength(0);
  });

  it('a participant receives no overheard entry for their own conversation (R5)', () => {
    seedConversation(world, [
      ['agent-a', 'agent-b', 'garden things', 'neutral'],
      ['agent-b', '', 'gladly', 'positive'],
    ]);
    expect(world.manager.getOverheardConversations('agent-a')).toHaveLength(0);
    expect(world.manager.getOverheardConversations('agent-b')).toHaveLength(0);
  });
});

// ── AC-4 (R2) — bounded rolling scope & per-cycle cap ────────────────────────

describe('spec 053 R2 — bounded rolling scope (AC-4)', () => {
  let world: ReturnType<typeof buildWorld>;
  beforeEach(() => {
    world = buildWorld();
  });

  it('a conversation with 8 turns renders exactly 3 overheard lines, latest turn first', () => {
    const id = seedConversation(world, [
      ['agent-a', 'agent-b', 'turn-1', 'neutral'],
      ['agent-b', '', 'turn-2', 'neutral'],
      ['agent-a', '', 'turn-3', 'neutral'],
      ['agent-b', '', 'turn-4', 'neutral'],
      ['agent-a', '', 'turn-5', 'neutral'],
      ['agent-b', '', 'turn-6', 'neutral'],
      ['agent-a', '', 'turn-7', 'neutral'],
      ['agent-b', '', 'turn-8', 'neutral'],
    ]);

    const entry = world.manager.getOverheardConversations('agent-c')[0]!;
    expect(entry.conversationId).toBe(id);
    expect(entry.lines).toHaveLength(3);
    expect(entry.availableLines).toBe(8);
    // Latest first: the window's three most recent turns, newest at the front.
    expect(entry.lines.map((l) => l.content)).toEqual(['turn-8', 'turn-7', 'turn-6']);
    expect(entry.lines.map((l) => l.speakerId)).toEqual([
      'agent-b',
      'agent-a',
      'agent-b',
    ]);
  });

  it('a conversation with 1 turn renders exactly 1 overheard line', () => {
    seedConversation(world, [
      ['agent-a', 'agent-b', 'only turn', 'neutral'],
    ]);
    const entry = world.manager.getOverheardConversations('agent-c')[0]!;
    expect(entry.lines).toHaveLength(1);
    expect(entry.availableLines).toBe(1);
    expect(entry.lines[0]!.content).toBe('only turn');
  });
});

// ── R1 — deterministic addressee resolution ──────────────────────────────────

describe('spec 053 R1 — line addressee resolution', () => {
  let world: ReturnType<typeof buildWorld>;
  beforeEach(() => {
    world = buildWorld();
  });

  it('the addressee is the nearest prior distinct speaker; the opening turn addresses the other participant', () => {
    const id = seedConversation(world, [
      ['agent-a', 'agent-b', 'a opens', 'neutral'], // A → B (first other participant)
      ['agent-b', '', 'b replies', 'neutral'], // B → A (prior speaker)
    ]);
    // C joins and speaks, then A speaks again — A's addressee is now C.
    expect(world.manager.join('agent-c', id, 110).success).toBe(true);
    expect(world.manager.contribute('agent-c', id, 'c chips in', 'neutral', 111).success).toBe(
      true,
    );
    expect(world.manager.contribute('agent-a', id, 'a answers c', 'neutral', 112).success).toBe(
      true,
    );

    // A 4th agent observes from the garden.
    world.agentManager.spawn(makeProfile('agent-d', GARDEN));
    world.agentManager.updateState('agent-d', { location: GARDEN });
    const entry = world.manager.getOverheardConversations('agent-d')[0]!;
    // Latest 3: A→C, C→B, B→A.
    expect(entry.lines.map((l) => `${l.speakerId}->${l.addresseeId}`)).toEqual([
      'agent-a->agent-c',
      'agent-c->agent-b',
      'agent-b->agent-a',
    ]);
  });
});

// ── AC-2 (R3) — observe upgraded to full history ─────────────────────────────

describe('spec 053 R3 — observe returns the full rolling window (AC-2)', () => {
  let world: ReturnType<typeof buildWorld>;
  beforeEach(() => {
    world = buildWorld();
  });

  it('returns topic, participants, and the full rolling-window turns oldest first', () => {
    const id = seedConversation(world, [
      ['agent-a', 'agent-b', 'first', 'negative'],
      ['agent-b', '', 'second', 'positive'],
      ['agent-a', '', 'third', 'neutral'],
      ['agent-b', '', 'fourth', 'neutral'],
      ['agent-a', '', 'fifth', 'neutral'],
      ['agent-b', '', 'sixth', 'neutral'],
      ['agent-a', '', 'seventh', 'neutral'],
      ['agent-b', '', 'eighth', 'neutral'],
    ]);

    const observed = world.manager.observe('agent-c', id);
    expect(observed.success).toBe(true);
    expect(observed.topic).toBe('a conversation');
    expect(observed.participants).toEqual(['agent-a', 'agent-b']);
    expect(observed.turns).toHaveLength(8);
    // Oldest first (R3) — the exact inverse of the overheard render order.
    expect(observed.turns!.map((t) => t.content)).toEqual([
      'first',
      'second',
      'third',
      'fourth',
      'fifth',
      'sixth',
      'seventh',
      'eighth',
    ]);
    expect(observed.turns![0]).toEqual({
      agentId: 'agent-a',
      content: 'first',
      sentiment: 'negative',
      tick: 100,
    });
    // The message names the speakers.
    expect(observed.message).toContain('agent-a');
    expect(observed.message).toContain('agent-b');
  });

  it('does NOT add the observer to participants; eligibility stays join/observe only', () => {
    const id = seedConversation(world, [
      ['agent-a', 'agent-b', 'hello', 'neutral'],
    ]);
    const before = world.manager.getConversation(id)!.participants.map((p) => p.agentId);
    world.manager.observe('agent-c', id);
    const after = world.manager.getConversation(id)!.participants.map((p) => p.agentId);
    expect(after).toEqual(before);
    expect(after).not.toContain('agent-c');

    // The eligible-affordance set for a co-located non-participant is unchanged.
    const eligible = world.manager.getEligibleAffordances(id, 'agent-c');
    expect(eligible).toEqual(['join', 'observe']);
    expect(eligible).not.toContain('contribute');
  });
});