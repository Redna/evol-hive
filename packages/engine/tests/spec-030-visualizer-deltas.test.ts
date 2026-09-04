/**
 * Tests for live structural rendering support (spec 030, Req 15 / AC-6).
 *
 * The VisualizerDataAdapter reflects mutations without engine changes:
 * rooms/objects/agents that appear or disappear between snapshots are picked
 * up from the registries each snapshot, and mutation log deltas
 * (getMutationDeltas(sinceSeq)) are exposed for the WebSocket channel.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { AgentProfile, PPEROrchestratorPort, Room, SmartObject } from '@evol-hive/shared';
import { AgentManagerImpl } from '../src/agents/state/index.js';
import { SmartObjectRegistryImpl } from '../src/world/objects/index.js';
import { SceneManagerImpl } from '../src/world/scenes/index.js';
import { GameLoopImpl } from '../src/loop/index.js';
import { VisualizerDataAdapter } from '../src/visualizer/data-adapter.js';
import { SceneMutationServiceImpl, DormantAgentStore } from '../src/world/mutations/index.js';

function makeObject(id: string, roomId: string): SmartObject {
  return {
    id,
    name: id,
    type: 'furniture',
    state: {},
    affordances: [
      { id: 'observe', label: 'Observe', engineEffect: 'observe', preconditions: [], effects: {} },
    ],
    roomId,
  };
}

function profile(id: string): AgentProfile {
  return { id, name: id, description: '', traits: [], initialDrives: {} };
}

interface Harness {
  registry: SmartObjectRegistryImpl;
  sceneManager: SceneManagerImpl;
  agentManager: AgentManagerImpl;
  service: SceneMutationServiceImpl;
  adapter: VisualizerDataAdapter;
}

function buildHarness(): Harness {
  const roomA: Room = { id: 'room_a', name: 'A', description: '', connections: [], objectIds: [] };
  const registry = new SmartObjectRegistryImpl();
  const agentManager = new AgentManagerImpl();
  const sceneManager = new SceneManagerImpl(agentManager, new Map([['room_a', roomA]]));
  const service = new SceneMutationServiceImpl({
    registry,
    sceneManager,
    agentManager,
    dormantStore: new DormantAgentStore(),
  });
  const loop = new GameLoopImpl({
    fps: 60,
    spatialDebounceSeconds: 5,
    maxConcurrentLLM: 8,
    guardrailsEnabled: false,
    guardrails: { affordanceMasking: false, contextualForcing: false, planValidation: false },
  });
  const orchestrator: PPEROrchestratorPort = {
    runCycle: () => Promise.resolve(),
    getPhase: () => 'perceive',
  };
  const adapter = new VisualizerDataAdapter({
    gameLoop: loop,
    agentManager,
    smartObjectRegistry: registry,
    sceneManager,
    orchestrator,
    mutationService: service,
  });
  return { registry, sceneManager, agentManager, service, adapter };
}

describe('Visualizer live structural rendering (spec 030, AC-6 / Req 15)', () => {
  let h: Harness;
  beforeEach(() => {
    h = buildHarness();
  });

  it('an added object appears in the next snapshot without any adapter changes', () => {
    expect(h.adapter.getSnapshot().rooms[0]!.objects).toHaveLength(0);

    h.service.propose({
      type: 'add_object',
      payload: { object: makeObject('crate-1', 'room_a') },
    });
    h.service.applyPending(1);

    const snapshot = h.adapter.getSnapshot();
    expect(snapshot.rooms[0]!.objects.map((o) => o.id)).toContain('crate-1');
  });

  it('a removed object disappears from the next snapshot', () => {
    h.registry.register(makeObject('crate-1', 'room_a'));
    expect(h.adapter.getSnapshot().rooms[0]!.objects.map((o) => o.id)).toContain('crate-1');

    h.service.propose({ type: 'remove_object', payload: { objectId: 'crate-1' } });
    h.service.applyPending(1);

    expect(h.adapter.getSnapshot().rooms[0]!.objects.map((o) => o.id)).not.toContain('crate-1');
  });

  it('a spawned agent appears and a despawned agent disappears in the snapshots', () => {
    h.service.propose({ type: 'spawn_agent', payload: { profile: profile('visitor') } });
    h.service.applyPending(1);
    expect(h.adapter.getSnapshot().agents.map((a) => a.agentId)).toContain('visitor');

    h.service.propose({ type: 'despawn_agent', payload: { agentId: 'visitor' } });
    h.service.applyPending(2);
    expect(h.adapter.getSnapshot().agents.map((a) => a.agentId)).not.toContain('visitor');
  });

  it('getMutationDeltas(sinceSeq) streams only new mutation events for the WebSocket channel', () => {
    h.service.propose({ type: 'add_object', payload: { object: makeObject('crate-1', 'room_a') } });
    h.service.applyPending(1);
    h.service.propose({ type: 'add_object', payload: { object: makeObject('crate-2', 'room_a') } });
    h.service.applyPending(2);

    const all = h.adapter.getMutationDeltas(0);
    expect(all).toHaveLength(2);

    const delta = h.adapter.getMutationDeltas(1);
    expect(delta).toHaveLength(1);
    expect(delta[0]!.seq).toBe(2);
    expect(delta[0]!.type).toBe('add_object');
  });
});
