/**
 * Tests for spec 018 — Multi-Agent Social (engine layer).
 * Covers AC-16 through AC-24.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { AgentProfile, AgentInternalState } from '@evol-hive/shared';
import { AgentManagerImpl } from '../src/agents/state/index.js';
import { DriveSystemImpl } from '../src/agents/drives/index.js';
import { SmartObjectRegistryImpl } from '../src/world/objects/index.js';
import { SystemFeedbackStore } from '../src/agents/feedback/index.js';
import { PerceptionDataProviderImpl } from '../src/agents/perception/index.js';
import { MessageQueue } from '../src/social/message-queue.js';
import { SocialManager } from '../src/social/social-manager.js';

// ── AC-16: MessageQueue ───────────────────────────────────────────────────────

describe('AC-16: MessageQueue', () => {
  it('enqueue adds to the queue; dequeue returns all and clears', () => {
    const mq = new MessageQueue();
    mq.enqueue('agent-b', { fromAgentId: 'a', fromName: 'Alice', content: 'Hi 1', timestamp: 100 });
    mq.enqueue('agent-b', { fromAgentId: 'a', fromName: 'Alice', content: 'Hi 2', timestamp: 200 });
    expect(mq.pendingCount('agent-b')).toBe(2);

    const messages = mq.dequeue('agent-b');
    expect(messages).toHaveLength(2);
    expect(messages[0].content).toBe('Hi 1');
    expect(messages[1].content).toBe('Hi 2');
    expect(mq.pendingCount('agent-b')).toBe(0);
  });

  it('dequeue returns [] when no messages pending', () => {
    const mq = new MessageQueue();
    expect(mq.dequeue('agent-x')).toEqual([]);
    expect(mq.pendingCount('agent-x')).toBe(0);
  });

  it('enqueue/dequeue for different agents are independent', () => {
    const mq = new MessageQueue();
    mq.enqueue('agent-b', { fromAgentId: 'a', fromName: 'A', content: 'msg to B', timestamp: 1 });
    mq.enqueue('agent-c', { fromAgentId: 'a', fromName: 'A', content: 'msg to C', timestamp: 2 });
    expect(mq.pendingCount('agent-b')).toBe(1);
    expect(mq.pendingCount('agent-c')).toBe(1);
    expect(mq.dequeue('agent-b')).toHaveLength(1);
    expect(mq.dequeue('agent-c')).toHaveLength(1);
  });
});

// ── Setup helper ─────────────────────────────────────────────────────────────

function setupSocial() {
  const agentManager = new AgentManagerImpl();

  const aliceProfile: AgentProfile = {
    id: 'agent-alice',
    name: 'Alice',
    description: 'test agent',
    traits: [],
    initialDrives: { energy: 50, hunger: 50, social: 30, comfort: 50, curiosity: 50 },
  };
  const bobProfile: AgentProfile = {
    id: 'agent-bob',
    name: 'Bob',
    description: 'test agent',
    traits: [],
    initialDrives: { energy: 80, hunger: 50, social: 70, comfort: 50, curiosity: 50 },
  };
  agentManager.spawn(aliceProfile);
  agentManager.spawn(bobProfile);
  agentManager.updateState('agent-alice', { location: 'kitchen' });
  agentManager.updateState('agent-bob', { location: 'kitchen' });

  const socialManager = new SocialManager(agentManager);
  return { agentManager, socialManager };
}

// ── AC-17: SocialManager implements SocialActionBridge ───────────────────────

describe('AC-17: SocialManager implements SocialActionBridge', () => {
  it('queueMessage enqueues a SocialMessage with fromName from the profile', () => {
    const { socialManager } = setupSocial();
    socialManager.queueMessage('agent-alice', 'agent-bob', 'Hello Bob!');
    const messages = socialManager.dequeueSocialMessages('agent-bob');
    expect(messages).toHaveLength(1);
    expect(messages[0].fromAgentId).toBe('agent-alice');
    expect(messages[0].fromName).toBe('Alice');
    expect(messages[0].content).toBe('Hello Bob!');
  });

  it('getAgentSummary returns AgentSummary with currentActivity derived from state', () => {
    const { agentManager, socialManager } = setupSocial();
    // idle agent
    let summary = socialManager.getAgentSummary('agent-bob');
    expect(summary).not.toBeNull();
    expect(summary!.name).toBe('Bob');
    expect(summary!.currentActivity).toBe('idle');
    expect(summary!.isThinking).toBe(false);

    // thinking agent
    agentManager.updateState('agent-bob', { isThinking: true });
    summary = socialManager.getAgentSummary('agent-bob');
    expect(summary!.currentActivity).toBe('thinking');
    expect(summary!.isThinking).toBe(true);

    // working on plan
    agentManager.updateState('agent-bob', {
      isThinking: false,
      currentPlan: {
        id: 'plan-1',
        description: 'Get coffee',
        steps: [],
        currentStepIndex: 0,
        createdAt: 0,
      },
    });
    summary = socialManager.getAgentSummary('agent-bob');
    expect(summary!.currentActivity).toBe('working on: Get coffee');
  });

  it('getAgentSummary returns null for nonexistent agent', () => {
    const { socialManager } = setupSocial();
    expect(socialManager.getAgentSummary('nonexistent')).toBeNull();
  });

  it('getAgentDrives returns drives record', () => {
    const { socialManager } = setupSocial();
    const drives = socialManager.getAgentDrives('agent-bob');
    expect(drives.energy).toBe(80);
    expect(drives.social).toBe(70);
  });

  it('getAgentDrives returns {} for nonexistent agent', () => {
    const { socialManager } = setupSocial();
    expect(socialManager.getAgentDrives('nonexistent')).toEqual({});
  });
});

// ── AC-18: getAgentsInRoom ────────────────────────────────────────────────────

describe('AC-18: SocialManager.getAgentsInRoom', () => {
  it('returns summaries for agents in the room excluding the given agent', () => {
    const { agentManager, socialManager } = setupSocial();
    // Add agent C in a different room
    agentManager.spawn({
      id: 'agent-carol',
      name: 'Carol',
      description: 'test',
      traits: [],
      initialDrives: {},
    });
    agentManager.updateState('agent-carol', { location: 'office' });

    const inKitchen = socialManager.getAgentsInRoom('kitchen', 'agent-alice');
    expect(inKitchen).toHaveLength(1);
    expect(inKitchen[0].agentId).toBe('agent-bob');
    expect(inKitchen[0].name).toBe('Bob');
  });
});

// ── AC-19: dequeueSocialMessages ─────────────────────────────────────────────

describe('AC-19: SocialManager.dequeueSocialMessages', () => {
  it('returns messages and clears the queue', () => {
    const { socialManager } = setupSocial();
    socialManager.queueMessage('agent-alice', 'agent-bob', 'Hi!');
    expect(socialManager.dequeueSocialMessages('agent-bob')).toHaveLength(1);
    expect(socialManager.dequeueSocialMessages('agent-bob')).toEqual([]);
  });
});

// ── AC-20: getRelationships ──────────────────────────────────────────────────

describe('AC-20: SocialManager.getRelationships', () => {
  it('returns relationships from state or {} when not set', () => {
    const { agentManager, socialManager } = setupSocial();
    agentManager.updateState('agent-alice', {
      relationships: { 'agent-bob': { trust: 60, familiarity: 20, lastInteraction: 100 } },
    });
    const rels = socialManager.getRelationships('agent-alice');
    expect(rels['agent-bob'].trust).toBe(60);

    // Agent without relationships
    expect(socialManager.getRelationships('agent-bob')).toEqual({});
  });
});

// ── AC-21: updateRelationship ────────────────────────────────────────────────

describe('AC-21: SocialManager.updateRelationship', () => {
  it('creates new relationship with defaults when none exists', () => {
    const { agentManager, socialManager } = setupSocial();
    socialManager.updateRelationship('agent-alice', 'agent-bob', { trust: 10 });
    const rels = socialManager.getRelationships('agent-alice');
    // defaults: trust 50, familiarity 0, then +10 trust → 60
    expect(rels['agent-bob'].trust).toBe(60);
    expect(rels['agent-bob'].familiarity).toBe(0);
    expect(rels['agent-bob'].lastInteraction).toBe(0);
  });

  it('clamps trust to 100 when exceeding', () => {
    const { agentManager, socialManager } = setupSocial();
    agentManager.updateState('agent-alice', {
      relationships: { 'agent-bob': { trust: 50, familiarity: 0, lastInteraction: 0 } },
    });
    socialManager.updateRelationship('agent-alice', 'agent-bob', { trust: 60 });
    expect(socialManager.getRelationships('agent-alice')['agent-bob'].trust).toBe(100);
  });

  it('clamps trust to 0 when going negative', () => {
    const { agentManager, socialManager } = setupSocial();
    agentManager.updateState('agent-alice', {
      relationships: { 'agent-bob': { trust: 50, familiarity: 0, lastInteraction: 0 } },
    });
    socialManager.updateRelationship('agent-alice', 'agent-bob', { trust: -60 });
    expect(socialManager.getRelationships('agent-alice')['agent-bob'].trust).toBe(0);
  });

  it('clamps familiarity to 0–100', () => {
    const { agentManager, socialManager } = setupSocial();
    socialManager.updateRelationship('agent-alice', 'agent-bob', { familiarity: -10 });
    expect(socialManager.getRelationships('agent-alice')['agent-bob'].familiarity).toBe(0);

    socialManager.updateRelationship('agent-alice', 'agent-bob', { familiarity: 200 });
    expect(socialManager.getRelationships('agent-alice')['agent-bob'].familiarity).toBe(100);
  });
});

// ── AC-22: PerceptionDataProviderImpl delegation ──────────────────────────────

describe('AC-22: PerceptionDataProviderImpl social delegation', () => {
  function setupWithSocial() {
    const agentManager = new AgentManagerImpl();
    agentManager.spawn({
      id: 'a1',
      name: 'A1',
      description: 'test',
      traits: [],
      initialDrives: { energy: 50 },
    });
    agentManager.spawn({
      id: 'a2',
      name: 'A2',
      description: 'test',
      traits: [],
      initialDrives: {},
    });
    agentManager.updateState('a1', { location: 'kitchen' });
    agentManager.updateState('a2', { location: 'kitchen' });
    const driveSystem = new DriveSystemImpl(agentManager);
    const registry = new SmartObjectRegistryImpl();
    const feedback = new SystemFeedbackStore();
    const provider = new PerceptionDataProviderImpl(agentManager, registry, driveSystem, feedback);
    const socialManager = new SocialManager(agentManager);
    provider.setSocialManager(socialManager);
    return { provider, socialManager, agentManager };
  }

  it('getAgentsInRoom delegates to SocialManager', () => {
    const { provider } = setupWithSocial();
    const agents = provider.getAgentsInRoom!('kitchen', 'a1');
    expect(agents).toHaveLength(1);
    expect(agents[0].agentId).toBe('a2');
  });

  it('dequeueSocialMessages delegates to SocialManager', () => {
    const { provider, socialManager } = setupWithSocial();
    socialManager.queueMessage('a1', 'a2', 'hello');
    expect(provider.dequeueSocialMessages!('a2')).toHaveLength(1);
    expect(provider.dequeueSocialMessages!('a2')).toEqual([]);
  });

  it('getRelationships delegates to SocialManager', () => {
    const { provider, agentManager } = setupWithSocial();
    agentManager.updateState('a1', {
      relationships: { a2: { trust: 55, familiarity: 10, lastInteraction: 5 } },
    });
    expect(provider.getRelationships!('a1').a2.trust).toBe(55);
  });

  it('when SocialManager is not wired, returns empty results', () => {
    const agentManager = new AgentManagerImpl();
    agentManager.spawn({
      id: 'a1',
      name: 'A1',
      description: 'test',
      traits: [],
      initialDrives: {},
    });
    const driveSystem = new DriveSystemImpl(agentManager);
    const registry = new SmartObjectRegistryImpl();
    const feedback = new SystemFeedbackStore();
    const provider = new PerceptionDataProviderImpl(agentManager, registry, driveSystem, feedback);
    // No setSocialManager called
    expect(provider.getAgentsInRoom!('kitchen', 'a1')).toEqual([]);
    expect(provider.dequeueSocialMessages!('a1')).toEqual([]);
    expect(provider.getRelationships!('a1')).toEqual({});
  });
});

// ── AC-23: AgentManagerImpl relationship seeding ──────────────────────────────

describe('AC-23: AgentManagerImpl.spawn relationship seeding', () => {
  it('seeds relationships from profile.relationships', () => {
    const agentManager = new AgentManagerImpl();
    const profile: AgentProfile = {
      id: 'agent-alice',
      name: 'Alice',
      description: 'test',
      traits: [],
      initialDrives: {},
      relationships: { 'agent-bob': 'trusted colleague' },
    };
    agentManager.spawn(profile);
    const state = agentManager.getState('agent-alice');
    expect(state!.relationships).toBeDefined();
    expect(state!.relationships!['agent-bob']).toEqual({
      trust: 50,
      familiarity: 0,
      lastInteraction: 0,
    });
  });

  it('does not set relationships when profile.relationships is absent', () => {
    const agentManager = new AgentManagerImpl();
    const profile: AgentProfile = {
      id: 'agent-alice',
      name: 'Alice',
      description: 'test',
      traits: [],
      initialDrives: {},
    };
    agentManager.spawn(profile);
    const state = agentManager.getState('agent-alice');
    expect(state!.relationships).toBeUndefined();
  });

  it('does not set relationships when profile.relationships is empty', () => {
    const agentManager = new AgentManagerImpl();
    const profile: AgentProfile = {
      id: 'agent-alice',
      name: 'Alice',
      description: 'test',
      traits: [],
      initialDrives: {},
      relationships: {},
    };
    agentManager.spawn(profile);
    const state = agentManager.getState('agent-alice');
    expect(state!.relationships).toBeUndefined();
  });
});

// ── AC-24: Export from engine index ──────────────────────────────────────────

describe('AC-24: SocialManager and MessageQueue exported from engine index', () => {
  it('imports from @evol-hive/engine package', async () => {
    const engine = await import('../src/index.js');
    expect(engine.SocialManager).toBeDefined();
    expect(engine.MessageQueue).toBeDefined();
  });
});
