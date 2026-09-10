/**
 * Tests for spec 046 — talk_to Target Resolution & Sentiment Passthrough
 * (issue #173) — engine layer.
 *
 * Covers:
 * - R1 (AC-1, AC-7, AC-8): `SocialManager.resolveAgentId` — exact agent-ID
 *   passthrough first (active state only), case-insensitive profile-name
 *   match over active agents preferring co-location with the requester,
 *   `null` when nothing unambiguous matches (including despawned agents and
 *   empty input). Deterministic — no LLM anywhere.
 * - R3 (AC-9): `ConversationManagerImpl` tolerance — a display-name key
 *   resolves to the real agent for `openOrContribute` (and `contribute`
 *   speaker keys); unresolvable keys fail with `success: false` and NEVER
 *   create a phantom participant; the refusal message names the present
 *   agents (Req 17 self-correction). The `ConversationBridge` interface is
 *   unchanged (pinned below against the shared source).
 *
 * The cognition-side normalization (R2), the sentiment passthrough (R5),
 * the perception ID rendering (R4), and the production-stack E2E coverage
 * live in the cognition and examples suites (package boundaries).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentManagerImpl } from '../src/agents/state/index.js';
import { SmartObjectRegistryImpl } from '../src/world/objects/index.js';
import { SceneManagerImpl } from '../src/world/scenes/index.js';
import { SocialManager } from '../src/social/social-manager.js';
import {
  ConversationManagerImpl,
  defaultConversationManagerConfig,
} from '../src/social/conversation-manager.js';
import type { AgentProfile } from '@evol-hive/shared';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONVERSATION_TYPES_PATH = resolve(HERE, '../../shared/src/types/conversation.ts');

// ── Fixtures ─────────────────────────────────────────────────────────────────

const GARDEN = 'garden';
const KITCHEN = 'kitchen';

/** A profile whose display name may differ from its ID (the spec 046 hazard). */
function makeProfile(id: string, name: string, startRoom: string): AgentProfile {
  return {
    id,
    name,
    description: '',
    traits: [],
    initialDrives: {},
    startRoomId: startRoom,
  };
}

function buildWorld(): {
  agentManager: AgentManagerImpl;
  social: SocialManager;
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
  const social = new SocialManager(agentManager);
  const manager = new ConversationManagerImpl({
    agentManager,
    registry,
    sceneManager,
    config: defaultConversationManagerConfig(),
  });
  social.setConversationManager(manager);
  return { agentManager, social, manager };
}

/** alice + bob co-located in the garden (display names differ from IDs). */
function spawnGardenPair(agentManager: AgentManagerImpl): void {
  agentManager.spawn(makeProfile('agent-alice', 'Alice', GARDEN));
  agentManager.spawn(makeProfile('agent-bob', 'Bob', GARDEN));
  agentManager.updateState('agent-alice', { location: GARDEN });
  agentManager.updateState('agent-bob', { location: GARDEN });
}

// ── R1: SocialManager.resolveAgentId ─────────────────────────────────────────

describe('spec 046 R1 — SocialManager.resolveAgentId', () => {
  let world: ReturnType<typeof buildWorld>;

  beforeEach(() => {
    world = buildWorld();
    spawnGardenPair(world.agentManager);
  });

  it('passes an exact active agent ID through unchanged (AC-10 basis)', () => {
    expect(world.social.resolveAgentId('agent-alice', 'agent-bob')).toBe('agent-bob');
    expect(world.social.resolveAgentId('agent-bob', 'agent-alice')).toBe('agent-alice');
  });

  it('resolves a display name case-insensitively to the real ID (AC-1)', () => {
    expect(world.social.resolveAgentId('agent-alice', 'Bob')).toBe('agent-bob');
    expect(world.social.resolveAgentId('agent-alice', 'bob')).toBe('agent-bob');
    expect(world.social.resolveAgentId('agent-alice', 'BOB')).toBe('agent-bob');
    expect(world.social.resolveAgentId('agent-bob', 'Alice')).toBe('agent-alice');
  });

  it('prefers the agent co-located with the requester over a same-named agent elsewhere', () => {
    // A second Bob works the kitchen — the garden-local Bob must win for a
    // requester standing in the garden.
    world.agentManager.spawn(makeProfile('agent-bob-2', 'Bob', KITCHEN));
    world.agentManager.updateState('agent-bob-2', { location: KITCHEN });
    expect(world.social.resolveAgentId('agent-alice', 'Bob')).toBe('agent-bob');
    // From the kitchen, the kitchen-local Bob is the intended target.
    expect(world.social.resolveAgentId('agent-bob-2', 'Bob')).toBe('agent-bob-2');
  });

  it('resolves a unique non-co-located match when the requester has no room-mate match', () => {
    // Carol works the kitchen alone; Alice (garden) asks for 'Carol'.
    world.agentManager.spawn(makeProfile('agent-carol', 'Carol', KITCHEN));
    world.agentManager.updateState('agent-carol', { location: KITCHEN });
    expect(world.social.resolveAgentId('agent-alice', 'Carol')).toBe('agent-carol');
  });

  it('returns null for ambiguous duplicate names in the requester’s room (never silent guessing)', () => {
    world.agentManager.spawn(makeProfile('agent-bob-2', 'Bob', GARDEN));
    world.agentManager.updateState('agent-bob-2', { location: GARDEN });
    expect(world.social.resolveAgentId('agent-alice', 'Bob')).toBeNull();
  });

  it('returns null for an unresolvable target (AC-8 basis)', () => {
    expect(world.social.resolveAgentId('agent-alice', 'Zed')).toBeNull();
  });

  it('returns null for a despawned agent — exact-ID passthrough requires ACTIVE state', () => {
    world.agentManager.despawn('agent-bob');
    expect(world.social.resolveAgentId('agent-alice', 'agent-bob')).toBeNull();
    expect(world.social.resolveAgentId('agent-alice', 'Bob')).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(world.social.resolveAgentId('agent-alice', '')).toBeNull();
  });
});

// ── R3 / AC-9: ConversationManagerImpl tolerance ─────────────────────────────

describe('spec 046 R3 / AC-9 — bare ConversationManagerImpl resolves display-name keys', () => {
  let world: ReturnType<typeof buildWorld>;

  beforeEach(() => {
    world = buildWorld();
    spawnGardenPair(world.agentManager);
  });

  it('openOrContribute with a display-name target opens a conversation with REAL participant IDs', () => {
    const result = world.manager.openOrContribute('agent-alice', 'Bob', 'Hey Bob!', 'neutral', 7);
    expect(result.success).toBe(true);
    expect(result.conversation).toBeDefined();
    const participants = result.conversation!.participants.map((p) => p.agentId);
    expect(participants).toEqual(['agent-alice', 'agent-bob']);
    expect(participants).not.toContain('Bob');
    // The turn is recorded under the resolved speaker/target — no phantom keys.
    expect(result.conversation!.turns).toHaveLength(1);
    expect(result.conversation!.turns[0]!.agentId).toBe('agent-alice');
  });

  it('openOrContribute with an unresolvable target fails with success:false and names the present agents', () => {
    const sizeBefore = world.manager.size();
    const result = world.manager.openOrContribute('agent-alice', 'Zed', 'hello?', 'neutral', 7);
    expect(result.success).toBe(false);
    // Req 17 self-correction: the refusal lists the present agents with IDs.
    expect(result.message).toContain('Zed');
    expect(result.message).toContain('Bob (agent-bob)');
    // No phantom participant, no conversation, nothing written.
    expect(world.manager.size()).toBe(sizeBefore);
    expect(world.manager.getOpenConversationBetween('agent-alice', 'Zed')).toBeNull();
  });

  it('openOrContribute with a display-name SELF-target resolves to the self-talk failure', () => {
    const result = world.manager.openOrContribute('agent-alice', 'Alice', 'hi me', 'neutral', 7);
    expect(result.success).toBe(false);
    expect(result.message).toBe('You cannot talk to yourself.');
    expect(world.manager.size()).toBe(0);
  });

  it('contribute with a display-name speaker key resolves to the real participant', () => {
    const opened = world.manager.openOrContribute(
      'agent-alice',
      'agent-bob',
      'hello',
      'neutral',
      7,
    );
    expect(opened.success).toBe(true);
    const contributed = world.manager.contribute(
      'Alice', // display name of the initiator
      opened.conversationId!,
      'again',
      'positive',
      8,
    );
    expect(contributed.success).toBe(true);
    expect(contributed.conversation!.turns).toHaveLength(2);
    expect(contributed.conversation!.turns[1]!.agentId).toBe('agent-alice');
  });

  it('contribute with an unresolvable speaker key fails — no phantom participant is created', () => {
    const opened = world.manager.openOrContribute(
      'agent-alice',
      'agent-bob',
      'hello',
      'neutral',
      7,
    );
    const convId = opened.conversationId!;
    const contributed = world.manager.contribute('Zed', convId, 'ghost turn', 'neutral', 8);
    expect(contributed.success).toBe(false);
    const conv = world.manager.getConversation(convId);
    expect(conv!.turns).toHaveLength(1);
    expect(conv!.participants.map((p) => p.agentId)).toEqual(['agent-alice', 'agent-bob']);
  });

  it('the R7 co-location sweep does NOT close a resolved-ID thread while both agents remain in the room (AC-1 basis)', () => {
    const opened = world.manager.openOrContribute('agent-alice', 'Bob', 'Hey Bob!', 'neutral', 7);
    expect(opened.success).toBe(true);
    world.manager.tick(8); // sweep one tick later, both agents still in the garden
    const conv = world.manager.getConversation(opened.conversationId!);
    expect(conv).not.toBeNull();
    expect(conv!.status).toBe('open'); // survives the sweep; open until the reply
  });
});

// ── AC-9: the ConversationBridge interface is unchanged ──────────────────────

describe('spec 046 AC-9 — ConversationBridge interface unchanged', () => {
  it('does not declare resolveAgentId (that method lives on SocialActionBridge only)', () => {
    const source = readFileSync(CONVERSATION_TYPES_PATH, 'utf8');
    const bridgeStart = source.indexOf('export interface ConversationBridge');
    expect(bridgeStart).toBeGreaterThan(-1);
    const bridgeEnd = source.indexOf('\n}', bridgeStart);
    const bridgeBody = source.slice(bridgeStart, bridgeEnd);
    expect(bridgeBody).not.toContain('resolveAgentId');
    // The pre-existing members are intact.
    for (const member of [
      'openOrContribute(',
      'join(',
      'leave(',
      'contribute(',
      'observe(',
      'getOpenConversationBetween(',
    ]) {
      expect(bridgeBody).toContain(member);
    }
  });
});
