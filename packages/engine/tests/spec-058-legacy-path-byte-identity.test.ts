/**
 * Spec 058 — Eligibility-Bound Plan Affordances — legacy-path byte identity
 * ═══════════════════════════════════════════════════════════════════════════
 * AC-8 (R1, R2, R3): "legacy providers without a conversation manager are
 * byte-identical." The PR's AC-1 case asserts the four conversation
 * affordances still *appear* when the manager is unwired; this suite pins the
 * stronger property the spec claims — the unwired path returns exactly the
 * registry's available set, in the same order, untouched by the eligibility
 * predicate and with no reference rewriting.
 *
 * QA gap-fill: deterministic, no LLM, mirroring the engine suite's fixtures.
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

const GARDEN = 'garden';

function makeProfile(id: string): AgentProfile {
  return { id, name: id, description: id, traits: [], initialDrives: {}, startRoomId: GARDEN };
}

function makeAffordance(id: string): Affordance {
  return { id, label: id, engineEffect: id, preconditions: [], effects: {} };
}

const ROOMS: Room[] = [
  { id: GARDEN, name: 'Garden', description: '', connections: [], objectIds: [] },
];

/** A non-conversation object plus a registered conversation mirror. */
const TROWEL: SmartObject = {
  id: 'trowel-1',
  name: 'Trowel',
  type: 'tool',
  state: {},
  affordances: [makeAffordance('grab')],
  roomId: GARDEN,
};

function buildWorld(): {
  agentManager: AgentManagerImpl;
  registry: SmartObjectRegistryImpl;
  perception: PerceptionDataProviderImpl;
} {
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
  // Deliberately NOT wiring the conversation manager — the legacy path.
  for (const id of ['agent-a', 'agent-b']) {
    agentManager.spawn(makeProfile(id));
    agentManager.updateState(id, { location: GARDEN });
  }
  // Open + close a real conversation so the room carries a conversation mirror
  // with its four declared affordances; the unwired provider must still emit
  // the raw available set (byte-identical legacy behavior).
  conversations.openOrContribute('agent-a', 'agent-b', 'hi', 'neutral', 1);
  return { agentManager, registry, perception };
}

describe('spec 058 AC-8 — unwired conversation manager is byte-identical', () => {
  let world: ReturnType<typeof buildWorld>;
  beforeEach(() => {
    world = buildWorld();
  });

  it('getVisibleAffordancesInRoom equals the registry available set exactly (order + values)', () => {
    const available = world.perception.getAvailableAffordancesInRoom(GARDEN);
    const visible = world.perception.getVisibleAffordancesInRoom('agent-a', GARDEN);
    expect(visible).toEqual(available);
    // The conversation mirror's four affordances are all present (legacy).
    const ids = visible.map((a) => a.id);
    for (const id of ['join', 'contribute', 'leave', 'observe']) {
      expect(ids).toContain(id);
    }
    expect(ids).toContain('grab');
  });

  it('getEligibleAffordancesInRoom is the same pass-through when unwired', () => {
    const available = world.perception.getAvailableAffordancesInRoom(GARDEN);
    const eligible = world.perception.getEligibleAffordancesInRoom(GARDEN, 'agent-a');
    expect(eligible).toEqual(available);
    expect(eligible.map((a) => a.id)).toEqual(available.map((a) => a.id));
  });
});
