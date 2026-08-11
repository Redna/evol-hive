/**
 * Tests for PerceptionDataProviderImpl — the engine-side bridge for the
 * Perceive phase (spec 001 bridge, wired in spec 005).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { Affordance, SmartObject } from '@evol-hive/shared';
import { AgentManagerImpl } from '../src/agents/state/index.js';
import { DriveSystemImpl } from '../src/agents/drives/index.js';
import { SmartObjectRegistryImpl } from '../src/world/objects/index.js';
import { SystemFeedbackStore } from '../src/agents/feedback/index.js';
import { PerceptionDataProviderImpl } from '../src/agents/perception/index.js';

const brewCoffee: Affordance = {
  id: 'brew_coffee',
  label: 'Brew coffee',
  engineEffect: 'brew_coffee',
  preconditions: [],
  effects: { energy: 20 },
};

const coffeeMachine: SmartObject = {
  id: 'coffee-1',
  name: 'Coffee Machine',
  type: 'appliance',
  state: { water_level: 5 },
  affordances: [brewCoffee],
  roomId: 'kitchen',
};

function setup() {
  const agentManager = new AgentManagerImpl();
  agentManager.spawn({
    id: 'a1',
    name: 'a1',
    description: 'test',
    traits: [],
    initialDrives: { energy: 20, hunger: 50, social: 50, comfort: 50, curiosity: 50 },
  });
  agentManager.updateState('a1', { location: 'kitchen' });
  const driveSystem = new DriveSystemImpl(agentManager);
  const registry = new SmartObjectRegistryImpl();
  registry.register(coffeeMachine);
  const feedback = new SystemFeedbackStore();
  const provider = new PerceptionDataProviderImpl(agentManager, registry, driveSystem, feedback);
  return { agentManager, driveSystem, registry, feedback, provider };
}

describe('PerceptionDataProviderImpl', () => {
  it('getAgentLocation returns the agent current location', () => {
    const { provider } = setup();
    expect(provider.getAgentLocation('a1')).toBe('kitchen');
  });

  it('getObjectsInRoom returns projected summaries', () => {
    const { provider } = setup();
    const objs = provider.getObjectsInRoom('kitchen');
    expect(objs).toHaveLength(1);
    expect(objs[0]).toEqual({ id: 'coffee-1', name: 'Coffee Machine', type: 'appliance' });
  });

  it('getAffordancesInRoom returns all affordances in the room', () => {
    const { provider } = setup();
    const affs = provider.getAffordancesInRoom('kitchen');
    expect(affs).toHaveLength(1);
    expect(affs[0]?.id).toBe('brew_coffee');
  });

  it('getAgentDrives returns a snapshot of the drives', () => {
    const { provider } = setup();
    const drives = provider.getAgentDrives('a1');
    expect(drives.energy).toBe(20);
  });

  it('getPrimaryDriveLabel returns the semantic label of the primary drive', () => {
    const { provider } = setup();
    expect(provider.getPrimaryDriveLabel('a1')).toBe('low energy, need to restore energy');
  });

  it('getSystemFeedback returns stored feedback or undefined', () => {
    const { provider, feedback } = setup();
    expect(provider.getSystemFeedback('a1')).toBeUndefined();
    feedback.setSystemFeedback('a1', 'failed');
    expect(provider.getSystemFeedback('a1')).toBe('failed');
  });
});
