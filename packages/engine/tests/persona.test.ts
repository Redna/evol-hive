/**
 * Tests for the Agent Persona System — engine layer (spec 012).
 * Covers AC-23 through AC-25, AC-30, AC-31 (AgentManager profile storage,
 * DataProvider bridges, read-only profile, backward compatibility).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { AgentProfile, Affordance, SmartObject } from '@evol-hive/shared';
import { formatPersona } from '@evol-hive/shared';
import { MINIMAL_SCENE, buildMinimalEngine } from '../../../examples/minimal-scene.ts';
import { AgentManagerImpl } from '../src/agents/state/index.js';
import { DriveSystemImpl } from '../src/agents/drives/index.js';
import { SmartObjectRegistryImpl } from '../src/world/objects/index.js';
import { SystemFeedbackStore } from '../src/agents/feedback/index.js';
import { PerceptionDataProviderImpl } from '../src/agents/perception/index.js';
import { PlanManagerImpl } from '../src/agents/plans/index.js';
import { ReflectDataProviderImpl } from '../src/agents/reflect/index.js';
import type { MemoryStore } from '@evol-hive/memory';
import type { MemoryEntryInput, MemoryNode } from '@evol-hive/shared';

// ─── AC-23: AgentManager stores AgentProfile ─────────────────────────────────

describe('AgentManagerImpl — profile storage (AC-23, AC-30)', () => {
  let manager: AgentManagerImpl;

  const profile: AgentProfile = {
    id: 'alice',
    name: 'Alice',
    description: 'A sleepy researcher',
    traits: ['diligent'],
    initialDrives: { energy: 20 },
    backstory: 'A sleepy researcher',
    behavioralTendencies: ['cautious'],
  };

  beforeEach(() => {
    manager = new AgentManagerImpl();
  });

  it('getProfile returns the profile after spawn (AC-23)', () => {
    manager.spawn(profile);
    const retrieved = manager.getProfile('alice');
    expect(retrieved).toBe(profile);
  });

  it('getProfile returns the same object reference after spawn (AC-23)', () => {
    manager.spawn(profile);
    expect(manager.getProfile('alice')).toBe(profile);
  });

  it('getProfile returns null for an unknown agent (AC-23)', () => {
    expect(manager.getProfile('unknown')).toBeNull();
  });

  it('getProfile returns null after despawn (AC-23)', () => {
    manager.spawn(profile);
    manager.despawn('alice');
    expect(manager.getProfile('alice')).toBeNull();
  });

  it('does not have updateProfile or setProfile methods (AC-30)', () => {
    manager.spawn(profile);
    expect((manager as unknown as Record<string, unknown>)['updateProfile']).toBeUndefined();
    expect((manager as unknown as Record<string, unknown>)['setProfile']).toBeUndefined();
  });
});

// ─── AC-24: PerceptionDataProviderImpl.getAgentProfile ───────────────────────

describe('PerceptionDataProviderImpl.getAgentProfile (AC-24)', () => {
  it('delegates to AgentManager.getProfile (AC-24)', () => {
    const agentManager = new AgentManagerImpl();
    const profile: AgentProfile = {
      id: 'a1',
      name: 'Alice',
      description: 'A researcher',
      traits: [],
      initialDrives: { energy: 20 },
      backstory: 'A sleepy researcher',
    };
    agentManager.spawn(profile);
    agentManager.updateState('a1', { location: 'kitchen' });

    const driveSystem = new DriveSystemImpl(agentManager);
    const registry = new SmartObjectRegistryImpl();
    const feedback = new SystemFeedbackStore();
    const provider = new PerceptionDataProviderImpl(agentManager, registry, driveSystem, feedback);

    expect(provider.getAgentProfile('a1')).toBe(profile);
  });

  it('returns null for unknown agent (AC-24)', () => {
    const agentManager = new AgentManagerImpl();
    const driveSystem = new DriveSystemImpl(agentManager);
    const registry = new SmartObjectRegistryImpl();
    const feedback = new SystemFeedbackStore();
    const provider = new PerceptionDataProviderImpl(agentManager, registry, driveSystem, feedback);

    expect(provider.getAgentProfile('unknown')).toBeNull();
  });
});

// ─── AC-25: ReflectDataProviderImpl.getAgentProfile ───────────────────────────

class FakeMemoryStore implements MemoryStore {
  async store(_agentId: string, _entry: MemoryEntryInput, _timestamp: number): Promise<MemoryNode> {
    return {
      id: 'mem_1',
      agentId: _agentId,
      content: _entry.content,
      embedding: [],
      timestamp: _timestamp,
      importance: _entry.importance,
      type: _entry.type,
    };
  }
  async get(): Promise<MemoryNode | null> {
    return null;
  }
}

describe('ReflectDataProviderImpl.getAgentProfile (AC-25)', () => {
  it('delegates to AgentManager.getProfile (AC-25)', () => {
    const agentManager = new AgentManagerImpl();
    const profile: AgentProfile = {
      id: 'a1',
      name: 'Alice',
      description: 'A researcher',
      traits: [],
      initialDrives: { energy: 50 },
      backstory: 'A sleepy researcher',
    };
    agentManager.spawn(profile);

    const planManager = new PlanManagerImpl(agentManager, () => 1000);
    const driveSystem = new DriveSystemImpl(agentManager);
    const memoryStore = new FakeMemoryStore();
    const clock = () => 1000;
    const provider = new ReflectDataProviderImpl(
      agentManager,
      driveSystem,
      planManager,
      memoryStore,
      clock,
    );

    expect(provider.getAgentProfile('a1')).toBe(profile);
  });

  it('returns null for unknown agent (AC-25)', () => {
    const agentManager = new AgentManagerImpl();
    const planManager = new PlanManagerImpl(agentManager, () => 1000);
    const driveSystem = new DriveSystemImpl(agentManager);
    const memoryStore = new FakeMemoryStore();
    const clock = () => 1000;
    const provider = new ReflectDataProviderImpl(
      agentManager,
      driveSystem,
      planManager,
      memoryStore,
      clock,
    );

    expect(provider.getAgentProfile('unknown')).toBeNull();
  });
});

// ─── AC-31: Backward compatibility with minimal scene (old-style profile) ─────

describe('Backward compatibility — minimal scene old-style profile (AC-31)', () => {
  it('minimal scene agent profile has no new persona fields', () => {
    const agent = MINIMAL_SCENE.agents[0]!;
    expect(agent.backstory).toBeUndefined();
    expect(agent.longTermGoals).toBeUndefined();
    expect(agent.behavioralTendencies).toBeUndefined();
    expect(agent.speechStyle).toBeUndefined();
    expect(agent.relationships).toBeUndefined();
  });

  it('formatPersona falls back to description for the minimal scene profile', () => {
    const agent = MINIMAL_SCENE.agents[0]!;
    const personaText = formatPersona(agent);
    // With no new persona fields, formatPersona returns the description.
    expect(personaText).toBe(agent.description);
    expect(personaText).toContain('sleepy agent who needs coffee');
  });

  it('minimal scene runs a full PPER cycle without modification (AC-31; spec 050: demo log wrapper removed with the second wiring path)', async () => {
    const engine = buildMinimalEngine();
    const { gameLoop, agentManager } = engine;

    try {
      gameLoop.start();
      await new Promise((r) => setTimeout(r, 50));
      gameLoop.stop();
    } finally {
      // restore no-op
    }

    // The PPER cycle completed successfully — the Reflect phase stored a
    // memory node in the assembler's store and the cycle ended (isThinking
    // reset). The demo log line the former LoggingOrchestrator emitted was
    // spec-019 demo sugar; spec 050 removes the demo-side orchestrator wrapper
    // (the promoted assembler owns the orchestrator), so the state assertions
    // carry AC-31.
    const state = agentManager.getState('agent-1');
    expect(state?.isThinking).toBe(false);
    const memories = await engine.vectorStore.queryByAgent('agent-1');
    expect(memories.length).toBeGreaterThan(0);
  });
});
