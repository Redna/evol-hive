/**
 * Tests for spec 033 — Conversation lifecycle engine (issue #128).
 *
 * Covers:
 * - AC-1 (R1, R2, R3): opening a directed exchange creates a conversation
 *   object; participants join/contribute; open → active on first contribution.
 * - AC-3 (R1, R3, R4): turns append with sentiment; derived roles and
 *   per-participant aggregates update; window capped.
 * - AC-4 (R2, R5): close (idle timeout or empty) produces per-participant
 *   `interaction` memory payloads with derived role + sentiment summary.
 * - AC-5 (R2, R7): an agent that leaves the room fails `contribute` gracefully
 *   and exits the conversation; last participant leaving closes it.
 * - AC-6 (R4): state stays bounded (≤ 8 turns) across arbitrarily long sessions.
 * - AC-2 (R3, R8): eligibility — non-participants see join/observe;
 *   participants see contribute/leave; the object registers in the smart
 *   object registry so guardrail masking/co-location apply unchanged.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { AgentManagerImpl } from '../src/agents/state/index.js';
import { SmartObjectRegistryImpl } from '../src/world/objects/index.js';
import { AffordanceRegistryImpl } from '../src/world/affordances/index.js';
import { SceneManagerImpl } from '../src/world/scenes/index.js';
import {
  ConversationManagerImpl,
  defaultConversationManagerConfig,
} from '../src/social/conversation-manager.js';
import type { AgentProfile, MemoryEntryInput } from '@evol-hive/shared';

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

interface InteractionRecord {
  agentId: string;
  entry: MemoryEntryInput;
}

function buildWorld(): {
  agentManager: AgentManagerImpl;
  registry: SmartObjectRegistryImpl;
  sceneManager: SceneManagerImpl;
  manager: ConversationManagerImpl;
  stored: InteractionRecord[];
} {
  const agentManager = new AgentManagerImpl();
  const registry = new SmartObjectRegistryImpl();
  const sceneManager = new SceneManagerImpl(
    agentManager,
    new Map([
      [GARDEN, { id: GARDEN, name: GARDEN, description: '', connections: [KITCHEN], objectIds: [] }],
      [
        KITCHEN,
        { id: KITCHEN, name: KITCHEN, description: '', connections: [GARDEN], objectIds: [] },
      ],
    ]),
  );
  const stored: InteractionRecord[] = [];
  const manager = new ConversationManagerImpl({
    agentManager,
    registry,
    sceneManager,
    config: defaultConversationManagerConfig(),
    consolidationSink: {
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

// ── AC-1 — creation & lifecycle ──────────────────────────────────────────────

describe('openOrContribute — conversation creation (AC-1, R1)', () => {
  let world: ReturnType<typeof buildWorld>;
  beforeEach(() => {
    world = buildWorld();
  });

  it('A talking to B opens a conversation object in the room', () => {
    const result = world.manager.openOrContribute('agent-a', 'agent-b', 'hi Bob', 'neutral', 11);
    expect(result.success).toBe(true);
    const conv = result.conversation!;
    expect(conv.id).toBeTruthy();
    expect(conv.roomId).toBe(GARDEN);
    expect(conv.status).toBe('open');
    expect(conv.participants.map((p) => p.agentId).sort()).toEqual(['agent-a', 'agent-b']);
    expect(conv.turns).toHaveLength(1);
    expect(conv.openedAt).toBe(11);
  });

  it('registers the conversation as a perceivable smart object in the room', () => {
    const result = world.manager.openOrContribute('agent-a', 'agent-b', 'hi', 'neutral', 11);
    const obj = world.registry.get(result.conversation!.id);
    expect(obj).not.toBeNull();
    expect(obj!.type).toBe('conversation');
    expect(obj!.roomId).toBe(GARDEN);
    // exactly the four spec-mandated affordances (R3)
    const ids = obj!.affordances.map((a) => a.id).sort();
    expect(ids).toEqual(['contribute', 'join', 'leave', 'observe']);
  });

  it('carries an LLM-derived topic', () => {
    const result = world.manager.openOrContribute(
      'agent-a',
      'agent-b',
      'let us discuss compost',
      'neutral',
      11,
      'composting tips',
    );
    expect(result.conversation!.topic).toBe('composting tips');
  });

  it('subsequent talk_to between the same pair attaches to the open conversation', () => {
    const first = world.manager.openOrContribute('agent-a', 'agent-b', 'hi', 'neutral', 11);
    const second = world.manager.openOrContribute('agent-b', 'agent-a', 'hello!', 'positive', 12);
    expect(second.conversation!.id).toBe(first.conversation!.id);
    expect(second.conversation!.turns).toHaveLength(2);
  });

  it('B contributing transitions the conversation open → active (AC-1)', () => {
    world.manager.openOrContribute('agent-a', 'agent-b', 'hi', 'neutral', 11);
    const second = world.manager.openOrContribute('agent-b', 'agent-a', 'hello!', 'positive', 12);
    expect(second.conversation!.status).toBe('active');
  });

  it('a third agent joining makes a group conversation emerge naturally', () => {
    const first = world.manager.openOrContribute('agent-a', 'agent-b', 'hi', 'neutral', 11);
    const join = world.manager.join('agent-c', first.conversation!.id, 12);
    expect(join.success).toBe(true);
    expect(join.conversation!.participants.map((p) => p.agentId).sort()).toEqual([
      'agent-a',
      'agent-b',
      'agent-c',
    ]);
  });
});

// ── AC-3 — turns, roles, aggregates ─────────────────────────────────────────

describe('turn bookkeeping (AC-3, R4)', () => {
  let world: ReturnType<typeof buildWorld>;
  beforeEach(() => {
    world = buildWorld();
  });

  it('derived roles: initiator keeps role, second turn makes a listener an active contributor', () => {
    const first = world.manager.openOrContribute('agent-a', 'agent-b', 'hi', 'neutral', 11);
    world.manager.openOrContribute('agent-b', 'agent-a', 'hello', 'positive', 12);
    world.manager.openOrContribute('agent-b', 'agent-a', 'again', 'neutral', 13);
    const conv = world.manager.getConversation(first.conversation!.id)!;
    const a = conv.participants.find((p) => p.agentId === 'agent-a')!;
    const b = conv.participants.find((p) => p.agentId === 'agent-b')!;
    expect(a.role).toBe('initiator');
    expect(b.role).toBe('active contributor');
  });

  it('per-participant sentiment aggregates update on each turn', () => {
    const first = world.manager.openOrContribute('agent-a', 'agent-b', 'hi', 'negative', 11);
    world.manager.openOrContribute('agent-b', 'agent-a', 'meh', 'negative', 12);
    const conv = world.manager.getConversation(first.conversation!.id)!;
    const a = conv.participants.find((p) => p.agentId === 'agent-a')!;
    expect(a.sentimentCounts.negative).toBe(1);
  });

  it('the window stays capped no matter how long the exchange runs (AC-6)', () => {
    const first = world.manager.openOrContribute('agent-a', 'agent-b', 'hi', 'neutral', 11);
    for (let i = 0; i < 50; i++) {
      world.manager.openOrContribute(
        i % 2 === 0 ? 'agent-a' : 'agent-b',
        i % 2 === 0 ? 'agent-b' : 'agent-a',
        `msg ${i}`,
        'neutral',
        20 + i,
      );
    }
    const conv = world.manager.getConversation(first.conversation!.id)!;
    expect(conv.turns.length).toBeLessThanOrEqual(8);
  });
});

// ── AC-5 — co-location exit (R7) ─────────────────────────────────────────────

describe('co-location exit (AC-5, R7)', () => {
  let world: ReturnType<typeof buildWorld>;
  beforeEach(() => {
    world = buildWorld();
  });

  it('contribute fails gracefully (no throw) when the agent left the room', async () => {
    const first = world.manager.openOrContribute('agent-a', 'agent-b', 'hi', 'neutral', 11);
    world.agentManager.updateState('agent-a', { location: KITCHEN });
    const result = world.manager.contribute(
      'agent-a',
      first.conversation!.id,
      'anyone there?',
      'neutral',
      12,
    );
    expect(result.success).toBe(false);
    expect(result.message.length).toBeGreaterThan(0);
  });

  it('the departed agent is removed from participants and the conversation closes when empty', () => {
    const first = world.manager.openOrContribute('agent-a', 'agent-b', 'hi', 'neutral', 11);
    world.agentManager.updateState('agent-a', { location: KITCHEN });
    world.manager.contribute('agent-a', first.conversation!.id, 'x', 'neutral', 12);
    const conv = world.manager.getConversation(first.conversation!.id)!;
    expect(conv.participants.map((p) => p.agentId)).toEqual(['agent-b']);
    // agent-b also wanders off → sweep removes them → last participant → close
    world.agentManager.updateState('agent-b', { location: KITCHEN });
    world.manager.tick(13);
    expect(world.manager.getConversation(first.conversation!.id)!.status).toBe('closed');
  });

  it('the tick sweep removes departed participants (wandering off = leaving)', () => {
    const first = world.manager.openOrContribute('agent-a', 'agent-b', 'hi', 'neutral', 11);
    world.agentManager.updateState('agent-a', { location: KITCHEN });
    world.manager.tick(20);
    const conv = world.manager.getConversation(first.conversation!.id)!;
    expect(conv.participants.map((p) => p.agentId)).toEqual(['agent-b']);
  });

  it('leave removes the participant and closes the conversation when the last one leaves', () => {
    const first = world.manager.openOrContribute('agent-a', 'agent-b', 'hi', 'neutral', 11);
    world.manager.leave('agent-a', first.conversation!.id, 12);
    expect(
      world.manager.getConversation(first.conversation!.id)!.participants.map((p) => p.agentId),
    ).toEqual(['agent-b']);
    world.manager.leave('agent-b', first.conversation!.id, 13);
    expect(world.manager.getConversation(first.conversation!.id)!.status).toBe('closed');
  });
});

// ── AC-4 — close-time consolidation (R5) ────────────────────────────────────

describe('close-time consolidation (AC-4, R5)', () => {
  let world: ReturnType<typeof buildWorld>;
  beforeEach(() => {
    world = buildWorld();
  });

  it('closing produces per-participant interaction memories with role + sentiment summary', () => {
    const first = world.manager.openOrContribute('agent-a', 'agent-b', 'hi', 'positive', 11);
    world.manager.openOrContribute('agent-b', 'agent-a', 'hello!', 'negative', 12);
    world.manager.close(first.conversation!.id, 'idle');

    expect(world.stored).toHaveLength(2);
    const byAgent = new Map(world.stored.map((r) => [r.agentId, r.entry]));
    const a = byAgent.get('agent-a')!;
    expect(a.type).toBe('interaction');
    expect(a.content).toContain('initiator');
    const b = byAgent.get('agent-b')!;
    expect(b.type).toBe('interaction');
    expect(b.content.toLowerCase()).toContain('negative');
  });

  it('idle timeout closes the conversation and consolidates', () => {
    const config = defaultConversationManagerConfig();
    const first = world.manager.openOrContribute('agent-a', 'agent-b', 'hi', 'neutral', 11);
    world.manager.tick(11 + config.idleTimeoutTicks + 1);
    expect(world.manager.getConversation(first.conversation!.id)!.status).toBe('closed');
    expect(world.stored).toHaveLength(2);
  });

  it('an active conversation is not closed before the idle timeout', () => {
    const first = world.manager.openOrContribute('agent-a', 'agent-b', 'hi', 'neutral', 11);
    world.manager.tick(11 + 1);
    expect(world.manager.getConversation(first.conversation!.id)!.status).toBe('active');
    expect(world.stored).toHaveLength(0);
  });

  it('an open conversation with no turns closes via the sweep too', () => {
    const config = defaultConversationManagerConfig();
    const first = world.manager.openOrContribute('agent-a', 'agent-b', 'hi', 'neutral', 11);
    world.manager.tick(11 + config.idleTimeoutTicks + 1);
    expect(world.manager.getConversation(first.conversation!.id)!.status).toBe('closed');
  });
});

// ── AC-2 — eligibility ──────────────────────────────────────────────────────

describe('affordance eligibility (AC-2, R3)', () => {
  let world: ReturnType<typeof buildWorld>;
  beforeEach(() => {
    world = buildWorld();
  });

  it('participants see contribute/leave; non-participants see join/observe', () => {
    const first = world.manager.openOrContribute('agent-a', 'agent-b', 'hi', 'neutral', 11);
    const convId = first.conversation!.id;
    const participantEligible = world.manager.getEligibleAffordances(convId, 'agent-a').sort();
    expect(participantEligible).toEqual(['contribute', 'leave']);
    const outsiderEligible = world.manager.getEligibleAffordances(convId, 'agent-c').sort();
    expect(outsiderEligible).toEqual(['join', 'observe']);
  });

  it('join adds a co-located non-participant; observe returns topic + participants only', () => {
    const first = world.manager.openOrContribute(
      'agent-a',
      'agent-b',
      'hi',
      'neutral',
      11,
      'roses',
    );
    const observed = world.manager.observe('agent-c', first.conversation!.id);
    expect(observed.success).toBe(true);
    expect(observed.topic).toBe('roses');
    expect(observed.participants!.sort()).toEqual(['agent-a', 'agent-b']);
    // non-participants do NOT see the full turn window (R3)
    expect(observed).not.toHaveProperty('turns');
  });

  it('join is rejected for agents in other rooms (co-location rule)', () => {
    const first = world.manager.openOrContribute('agent-a', 'agent-b', 'hi', 'neutral', 11);
    world.agentManager.updateState('agent-c', { location: KITCHEN });
    const result = world.manager.join('agent-c', first.conversation!.id, 12);
    expect(result.success).toBe(false);
  });
});

// ── persistence support (AC-9, R10) ─────────────────────────────────────────

describe('export/restore (AC-9, R10)', () => {
  it('round-trips conversations including closed ones', () => {
    const world = buildWorld();
    const first = world.manager.openOrContribute('agent-a', 'agent-b', 'hi', 'neutral', 11);
    world.manager.close(first.conversation!.id, 'idle');
    const second = world.manager.openOrContribute('agent-b', 'agent-c', 'hey', 'positive', 20);

    const exported = world.manager.exportConversations();
    expect(exported).toHaveLength(2);

    // restore into a fresh world
    const fresh = buildWorld();
    fresh.manager.restoreConversations(exported);
    expect(fresh.manager.getConversation(first.conversation!.id)!.status).toBe('closed');
    expect(fresh.manager.getConversation(second.conversation!.id)!.status).toBe('active');
    // mirrors re-registered in the fresh registry
    expect(fresh.registry.get(second.conversation!.id)).not.toBeNull();
  });
});