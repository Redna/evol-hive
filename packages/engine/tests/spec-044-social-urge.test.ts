/**
 * Tests for spec 044 — Social Urge Model (issue #160) — engine layer.
 *
 * Covers:
 * - AC-3 (R4a, data layer): after A talks to co-located B, B is reported as
 *   awaiting a reply (`getConversationsAwaitingAgentReply`) with A's turn as
 *   the last turn — the data behind the pending-address perception line.
 * - AC-7 (R2, engine side): reciprocity counters merge additively through the
 *   real `SocialManager.updateRelationship` bridge (the write path the
 *   cognition executor calls once per exchange) and ride the existing
 *   relationship state (the spec-033 R16-proven snapshot path).
 * - R1/Decision 6: `spawnTick` is set by `AgentManager` at spawn; absent for
 *   legacy spawns (neutral scene novelty).
 * - AC-10 (R5): a pending-address marker alone does NOT enqueue a forced
 *   cycle — the scheduler's gate semantics (spec 035/040) are unchanged;
 *   no scheduler source changes.
 * - Persistence constraint (QA): the new optional fields (relationship
 *   sentCount/receivedCount, AgentInternalState.spawnTick) survive a
 *   save/load round-trip, and a save from before 044 loads with them
 *   undefined (neutral urge inputs).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  GameTick,
  HardTriggerFlags,
  PPEROrchestratorPort,
  PPERSchedulerConfig,
  ReactGateDecision,
  System1GatePort,
} from '@evol-hive/shared';
import type { AgentProfile, EngineConfig } from '@evol-hive/shared';
import { InMemoryVectorStore } from '@evol-hive/memory';
import { GameLoopImpl } from '../src/loop/index.js';
import { AgentManagerImpl } from '../src/agents/state/index.js';
import { SmartObjectRegistryImpl } from '../src/world/objects/index.js';
import { SceneManagerImpl } from '../src/world/scenes/index.js';
import { EnginePersistenceImpl } from '../src/persistence/engine-persistence.js';
import { SelfModelManager } from '../src/agents/state/self-model-manager.js';
import { SceneMutationServiceImpl, DormantAgentStore } from '../src/world/mutations/index.js';
import {
  ConversationManagerImpl,
  defaultConversationManagerConfig,
} from '../src/social/conversation-manager.js';
import { SocialManager } from '../src/social/social-manager.js';
import { PPERScheduler } from '../src/systems/pper-scheduler.js';

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
  conversationManager: ConversationManagerImpl;
  socialManager: SocialManager;
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
  const conversationManager = new ConversationManagerImpl({
    agentManager,
    registry,
    sceneManager,
    config: defaultConversationManagerConfig(),
  });
  const socialManager = new SocialManager(agentManager);
  socialManager.setConversationManager(conversationManager);
  for (const id of ['agent-a', 'agent-b']) {
    agentManager.spawn(makeProfile(id, GARDEN));
    agentManager.updateState(id, { location: GARDEN });
  }
  return { agentManager, registry, sceneManager, conversationManager, socialManager };
}

// ── spawnTick (R1, Decision 6) ───────────────────────────────────────────────

describe('AgentManager.spawnTick (Decision 6)', () => {
  it('sets spawnTick on the state when a tick is provided at spawn', () => {
    const agents = new AgentManagerImpl();
    agents.spawn(makeProfile('agent-a', GARDEN), 42);
    expect(agents.getState('agent-a')?.spawnTick).toBe(42);
  });

  it('leaves spawnTick undefined for legacy spawns (no tick passed)', () => {
    const agents = new AgentManagerImpl();
    agents.spawn(makeProfile('agent-a', GARDEN));
    expect(agents.getState('agent-a')?.spawnTick).toBeUndefined();
  });
});

// ── AC-3 — awaiting-reply data layer (R4a, Decision 4) ───────────────────────

describe('getConversationsAwaitingAgentReply (AC-3 data layer, Decision 4)', () => {
  let world: ReturnType<typeof buildWorld>;
  beforeEach(() => {
    world = buildWorld();
  });

  it('after A talks to co-located B, B awaits a reply (A made the last turn); A does not', () => {
    const open = world.conversationManager.openOrContribute(
      'agent-a',
      'agent-b',
      'Hello there, B!',
      'neutral',
      10,
    );
    expect(open.success).toBe(true);

    const awaitingB = world.conversationManager.getConversationsAwaitingAgentReply('agent-b');
    expect(awaitingB).toHaveLength(1);
    expect(awaitingB[0]!.id).toBe(open.conversationId);
    const lastTurn = awaitingB[0]!.turns[awaitingB[0]!.turns.length - 1]!;
    expect(lastTurn.agentId).toBe('agent-a');
    expect(lastTurn.content).toBe('Hello there, B!');

    // The initiator owes nobody a reply.
    expect(world.conversationManager.getConversationsAwaitingAgentReply('agent-a')).toHaveLength(0);
  });

  it('after B replies, nobody awaits a reply in that conversation', () => {
    world.conversationManager.openOrContribute('agent-a', 'agent-b', 'hi', 'neutral', 10);
    const conv = world.conversationManager.getOpenConversationBetween('agent-a', 'agent-b')!;
    world.conversationManager.contribute('agent-b', conv.id, 'hi yourself', 'neutral', 11);

    expect(world.conversationManager.getConversationsAwaitingAgentReply('agent-b')).toHaveLength(0);
    // Now A owes B a reply.
    const awaitingA = world.conversationManager.getConversationsAwaitingAgentReply('agent-a');
    expect(awaitingA).toHaveLength(1);
    expect(awaitingA[0]!.turns[awaitingA[0]!.turns.length - 1]!.agentId).toBe('agent-b');
  });

  it('closed conversations never report an owed reply', () => {
    world.conversationManager.openOrContribute('agent-a', 'agent-b', 'hi', 'neutral', 10);
    world.conversationManager.close(
      world.conversationManager.getOpenConversationBetween('agent-a', 'agent-b')!.id,
      'test close',
    );
    expect(world.conversationManager.getConversationsAwaitingAgentReply('agent-b')).toHaveLength(0);
  });

  it('a non-participant is never reported as awaiting a reply', () => {
    world.conversationManager.openOrContribute('agent-a', 'agent-b', 'hi', 'neutral', 10);
    expect(
      world.conversationManager.getConversationsAwaitingAgentReply('agent-nobody'),
    ).toHaveLength(0);
  });

  it('is exposed through the SocialManager ConversationBridge delegate', () => {
    world.conversationManager.openOrContribute('agent-a', 'agent-b', 'hey', 'neutral', 10);
    const awaiting = world.socialManager.getConversationsAwaitingAgentReply('agent-b');
    expect(awaiting).toHaveLength(1);
    expect(awaiting[0]!.turns[awaiting[0]!.turns.length - 1]!.content).toBe('hey');
  });
});

// ── AC-7 — reciprocity counter merge through the real bridge (R2) ────────────

describe('reciprocity counters via SocialManager.updateRelationship (AC-7 engine side, R2)', () => {
  let world: ReturnType<typeof buildWorld>;
  beforeEach(() => {
    world = buildWorld();
  });

  it('a sentCount delta of 1 increments the speaker-side counter', () => {
    world.socialManager.updateRelationship('agent-a', 'agent-b', { sentCount: 1 });
    expect(world.agentManager.getState('agent-a')?.relationships?.['agent-b']?.sentCount).toBe(1);
  });

  it('a receivedCount delta of 1 increments the target-side counter', () => {
    world.socialManager.updateRelationship('agent-b', 'agent-a', { receivedCount: 1 });
    expect(world.agentManager.getState('agent-b')?.relationships?.['agent-a']?.receivedCount).toBe(
      1,
    );
  });

  it('counters accumulate additively across exchanges (exactly-once per call)', () => {
    world.socialManager.updateRelationship('agent-a', 'agent-b', { sentCount: 1 });
    world.socialManager.updateRelationship('agent-a', 'agent-b', { sentCount: 1 });
    world.socialManager.updateRelationship('agent-a', 'agent-b', { sentCount: 1 });
    const rel = world.agentManager.getState('agent-a')?.relationships?.['agent-b'];
    expect(rel?.sentCount).toBe(3);
  });

  it('counters ride the SAME relationship state as trust/familiarity deltas (no new write path)', () => {
    world.socialManager.updateRelationship('agent-a', 'agent-b', {
      trust: 2,
      familiarity: 5,
      lastInteraction: 77,
      sentCount: 1,
    });
    const rel = world.agentManager.getState('agent-a')?.relationships?.['agent-b'];
    expect(rel?.trust).toBe(52); // 50 default + 2
    expect(rel?.familiarity).toBe(5);
    expect(rel?.lastInteraction).toBe(77);
    expect(rel?.sentCount).toBe(1);
    expect(rel?.receivedCount).toBeUndefined();
  });

  it('counter deltas cannot drive a counter negative', () => {
    world.socialManager.updateRelationship('agent-a', 'agent-b', { sentCount: -5 });
    expect(world.agentManager.getState('agent-a')?.relationships?.['agent-b']?.sentCount).toBe(0);
  });

  it('updating one agent leaves the other side untouched', () => {
    world.socialManager.updateRelationship('agent-a', 'agent-b', { sentCount: 1 });
    expect(world.agentManager.getState('agent-b')?.relationships?.['agent-a']).toBeUndefined();
  });
});

// ── AC-10 — no forced cycle from a pending-address marker (R5) ───────────────

const TICK: GameTick = { tickNumber: 1, simulationTime: 0.0167, deltaSeconds: 0.0167 };

class FakeOrchestrator implements PPEROrchestratorPort {
  runCycleCalls: string[] = [];
  async runCycle(agentId: string): Promise<void> {
    this.runCycleCalls.push(agentId);
  }
  getPhase(_agentId: string) {
    return 'perceive' as const;
  }
}

class ScriptedGate implements System1GatePort {
  decisions: ReactGateDecision[] = [];
  decide(
    _agentId: string,
    _tickNumber: number,
    _hardTriggers: HardTriggerFlags,
  ): ReactGateDecision {
    const next = this.decisions.shift();
    if (next) return next;
    return { pReact: 0, react: false, hardTrigger: false, headVersion: 1, failOpen: false };
  }
}

function noReact(): ReactGateDecision {
  return { pReact: 0, react: false, hardTrigger: false, headVersion: 1, failOpen: false };
}

function react(): ReactGateDecision {
  return { pReact: 0.99, react: true, hardTrigger: false, headVersion: 1, failOpen: false };
}

describe('pending-address marker never forces a scheduler cycle (AC-10, R5)', () => {
  it('an agent owing a reply gets NO cycle when the gate says no-react (no marker bypass)', async () => {
    const world = buildWorld();
    // B owes A a reply (pending-address marker exists).
    world.conversationManager.openOrContribute('agent-a', 'agent-b', 'hello B', 'neutral', 10);
    expect(world.conversationManager.getConversationsAwaitingAgentReply('agent-b')).toHaveLength(1);

    const orchestrator = new FakeOrchestrator();
    const gate = new ScriptedGate();
    gate.decisions = [noReact(), noReact(), noReact(), noReact()];
    const scheduler = new PPERScheduler(
      world.agentManager,
      orchestrator,
      { maxConcurrentCycles: 8 } as PPERSchedulerConfig,
      { gate },
    );

    scheduler.update(TICK);
    await vi.waitFor(() => {}, { timeout: 10 }).catch(() => undefined);
    // The marker alone must not enqueue a cycle for either agent.
    expect(orchestrator.runCycleCalls).toHaveLength(0);
  });

  it('normal gate-approved cycling is unchanged while a marker exists (round-robin intact)', async () => {
    const world = buildWorld();
    world.conversationManager.openOrContribute('agent-a', 'agent-b', 'hello B', 'neutral', 10);

    const orchestrator = new FakeOrchestrator();
    const gate = new ScriptedGate();
    gate.decisions = [react(), react(), react(), react()];
    const scheduler = new PPERScheduler(
      world.agentManager,
      orchestrator,
      { maxConcurrentCycles: 8 } as PPERSchedulerConfig,
      { gate },
    );

    scheduler.update(TICK);
    await vi.waitFor(() => expect(orchestrator.runCycleCalls).toHaveLength(2), { timeout: 200 });
    expect(orchestrator.runCycleCalls.sort()).toEqual(['agent-a', 'agent-b']);
  });
});

// ── Persistence — new optional fields ride the spec-033-proven snapshot path ─

function makePersistenceConfig(): EngineConfig {
  return {
    fps: 60,
    spatialDebounceSeconds: 5,
    maxConcurrentLLM: 8,
    guardrailsEnabled: true,
    guardrails: { affordanceMasking: true, contextualForcing: true, planValidation: true },
  };
}

function buildPersistableWorld(): {
  persistence: EnginePersistenceImpl;
  agentManager: AgentManagerImpl;
  socialManager: SocialManager;
} {
  const config = makePersistenceConfig();
  const gameLoop = new GameLoopImpl(config);
  const agentManager = new AgentManagerImpl();
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
  const registry = new SmartObjectRegistryImpl();
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
  const socialManager = new SocialManager(agentManager);
  socialManager.setConversationManager(conversations);
  const persistence = new EnginePersistenceImpl({
    gameLoop,
    agentManager,
    smartObjectRegistry: registry,
    sceneManager,
    vectorStore: new InMemoryVectorStore(),
    mutationService,
    conversationManager: conversations,
    selfModelManager: new SelfModelManager(),
  });
  for (const id of ['agent-a', 'agent-b']) {
    agentManager.spawn(makeProfile(id, GARDEN));
    agentManager.updateState(id, { location: GARDEN });
  }
  return { persistence, agentManager, socialManager };
}

describe('spec 044 fields survive save/load (persistence constraint)', () => {
  it('relationship sentCount/receivedCount survive a save/load round-trip', async () => {
    const world = buildPersistableWorld();
    // Speaker-side counters, exactly as executeTalkTo applies them (AC-7).
    world.socialManager.updateRelationship('agent-a', 'agent-b', { sentCount: 1 });
    world.socialManager.updateRelationship('agent-a', 'agent-b', { sentCount: 1 });
    world.socialManager.updateRelationship('agent-b', 'agent-a', { receivedCount: 1 });

    const state = await world.persistence.save();
    const fresh = buildPersistableWorld();
    await fresh.persistence.load(JSON.parse(JSON.stringify(state)));

    const aToB = fresh.agentManager.getState('agent-a')?.relationships?.['agent-b'];
    const bToA = fresh.agentManager.getState('agent-b')?.relationships?.['agent-a'];
    expect(aToB?.sentCount).toBe(2);
    expect(bToA?.receivedCount).toBe(1);
  });

  it('spawnTick survives a save/load round-trip', async () => {
    const world = buildPersistableWorld();
    world.agentManager.spawn(makeProfile('agent-late', GARDEN), 777);

    const state = await world.persistence.save();
    const fresh = buildPersistableWorld();
    await fresh.persistence.load(JSON.parse(JSON.stringify(state)));

    expect(fresh.agentManager.getState('agent-late')?.spawnTick).toBe(777);
  });

  it('a pre-044 save (no new fields) loads with counters/spawnTick undefined', async () => {
    const world = buildPersistableWorld();
    // Populate the 044 fields first so the strip below is provably a no-op
    // guard: if the paths were wrong the assertions would fail loudly.
    world.agentManager.spawn(makeProfile('agent-late', GARDEN), 777);
    world.socialManager.updateRelationship('agent-late', 'agent-b', { sentCount: 2 });

    // Simulate a v1/v2-era snapshot: strip everything spec 044 added.
    const state = JSON.parse(JSON.stringify(await world.persistence.save()));
    const savedLate = state.agents.find(
      (a: { profile?: { id?: string } }) => a.profile?.id === 'agent-late',
    );
    expect(savedLate?.state?.spawnTick).toBe(777);
    expect(savedLate?.state?.relationships?.['agent-b']?.sentCount).toBe(2);
    for (const agent of state.agents) {
      delete agent.state.spawnTick;
      for (const rel of Object.values(agent.state.relationships ?? {})) {
        delete rel.sentCount;
        delete rel.receivedCount;
      }
    }

    const fresh = buildPersistableWorld();
    await fresh.persistence.load(state);
    const loaded = fresh.agentManager.getState('agent-late');
    expect(loaded?.spawnTick).toBeUndefined();
    expect(loaded?.relationships?.['agent-b']?.sentCount).toBeUndefined();
    expect(loaded?.relationships?.['agent-b']?.receivedCount).toBeUndefined();
  });
});
