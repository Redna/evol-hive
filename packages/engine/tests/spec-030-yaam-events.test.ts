/**
 * Tests for YAAM persistence of dormant agents (spec 030, Req 12 / AC-10).
 *
 * On despawn, the agent's state summary and key memories are written to a
 * YAAM-format append-only JSONL event log (`UPSERT_NODE` with agent-scoped
 * labels; `DELETE_NODE` on re-spawn claim) so a later session can re-spawn
 * the agent with its prior state via the memory pipeline.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { AgentProfile, MemoryNode, Room } from '@evol-hive/shared';
import { AgentManagerImpl } from '../src/agents/state/index.js';
import { SmartObjectRegistryImpl } from '../src/world/objects/index.js';
import { SceneManagerImpl } from '../src/world/scenes/index.js';
import {
  SceneMutationServiceImpl,
  DormantAgentStore,
  YaamEventLog,
} from '../src/world/mutations/index.js';

function makeMemoryNode(agentId: string, content: string): MemoryNode {
  return {
    id: `mem_${agentId}_${content}`,
    agentId,
    content,
    embedding: [0.1, 0.2, 0.3],
    timestamp: 12,
    importance: 7,
    type: 'observation',
    location: 'room_a',
  };
}

function profile(id: string): AgentProfile {
  return { id, name: id, description: '', traits: [], initialDrives: {} };
}

interface Harness {
  agentManager: AgentManagerImpl;
  dormantStore: DormantAgentStore;
  yaamLog: YaamEventLog;
  service: SceneMutationServiceImpl;
  memory: { exported: Map<string, MemoryNode[]> };
}

function buildHarness(): Harness {
  const roomA: Room = {
    id: 'room_a',
    name: 'A',
    description: '',
    connections: [],
    objectIds: [],
  };
  const agentManager = new AgentManagerImpl();
  const sceneManager = new SceneManagerImpl(agentManager, new Map([['room_a', roomA]]));
  const registry = new SmartObjectRegistryImpl();
  const dormantStore = new DormantAgentStore();
  const yaamLog = new YaamEventLog();
  const memory = { exported: new Map<string, MemoryNode[]>() };
  const service = new SceneMutationServiceImpl({
    registry,
    sceneManager,
    agentManager,
    dormantStore,
    yaamLog,
    memoryPort: {
      exportMemories: (agentId: string) => memory.exported.get(agentId) ?? [],
      importMemories: () => undefined,
    },
  });
  return { agentManager, dormantStore, yaamLog, service, memory };
}

describe('YAAM event log on despawn/respawn (spec 030, Req 12 / AC-10)', () => {
  let h: Harness;
  beforeEach(() => {
    h = buildHarness();
  });

  it('despawn appends an agent-scoped UPSERT_NODE event containing the state summary', () => {
    h.service.propose({ type: 'spawn_agent', payload: { profile: profile('diarist') } });
    h.service.applyPending(1);
    h.agentManager.updateState('diarist', { currentGoal: 'write the memoir' });
    h.memory.exported.set('diarist', [makeMemoryNode('diarist', 'saw the garden')]);

    h.service.propose({ type: 'despawn_agent', payload: { agentId: 'diarist' } });
    h.service.applyPending(2);

    const events = h.yaamLog.events();
    const upserts = events.filter((e) => e.type === 'UPSERT_NODE');
    // At least one state-summary node and one memory node, both agent-scoped.
    const agentScoped = upserts.filter((e) => e.label?.startsWith('agent:diarist:'));
    expect(agentScoped.length).toBeGreaterThanOrEqual(2);

    const summary = agentScoped.find((e) => e.label === 'agent:diarist:state');
    expect(summary).toBeDefined();
    expect(summary!.content).toContain('write the memoir');
    expect(summary!.content).toContain('energy');

    const memoryNode = agentScoped.find((e) => e.content === 'saw the garden');
    expect(memoryNode).toBeDefined();
  });

  it('respawn claims the dormant agent with a DELETE_NODE event', () => {
    h.service.propose({ type: 'spawn_agent', payload: { profile: profile('waker') } });
    h.service.applyPending(1);
    h.service.propose({ type: 'despawn_agent', payload: { agentId: 'waker' } });
    h.service.applyPending(2);

    const before = h.yaamLog.events().filter((e) => e.type === 'DELETE_NODE');
    expect(before).toHaveLength(0);

    h.service.propose({ type: 'spawn_agent', payload: { dormantAgentId: 'waker' } });
    h.service.applyPending(3);

    const after = h.yaamLog.events().filter((e) => e.type === 'DELETE_NODE');
    expect(after).toHaveLength(1);
    expect(after[0]!.label).toContain('waker');
  });

  it('the log serializes to JSONL that a fresh session can replay to recover memories', () => {
    h.service.propose({ type: 'spawn_agent', payload: { profile: profile('legacy') } });
    h.service.applyPending(1);
    h.memory.exported.set('legacy', [makeMemoryNode('legacy', 'the vault code is 1234')]);
    h.service.propose({ type: 'despawn_agent', payload: { agentId: 'legacy' } });
    h.service.applyPending(2);

    // Simulate the memory pipeline: serialize → fresh session → replay.
    const jsonl = h.yaamLog.toJsonl();
    expect(jsonl.split('\n').length).toBeGreaterThanOrEqual(2);

    const freshLog = YaamEventLog.fromJsonl(jsonl);
    const nodes = freshLog.replayNodes();
    const recovered = nodes.filter((n) => n.content === 'the vault code is 1234');
    expect(recovered).toHaveLength(1);
    expect(recovered[0]!.agentId).toBe('legacy');
    expect(recovered[0]!.importance).toBe(7);
  });
});
