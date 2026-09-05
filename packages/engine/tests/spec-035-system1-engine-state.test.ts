/**
 * Spec 035 — Engine-state hard-trigger source + agent tracker (Req 1, 5 / AC-1, AC-3).
 * Every hard-trigger flag toggles from engine state alone: queued social
 * message, open conversation (participant or open invite in room), recent
 * object mutation in the agent's room, drive threshold crossing. The tracker
 * records the drive snapshot + tick at each completed cycle.
 *
 * `detectThresholdCrossings` is part of the shared feature-schema contract
 * (Req 2) — the engine consumes the same pure function the cognition extractor
 * uses, without a cross-package import (ADR-0001).
 */
import { describe, it, expect } from 'vitest';
import { detectThresholdCrossings } from '@evol-hive/shared';
import type { SceneMutationEvent } from '@evol-hive/shared';
import { AgentManagerImpl } from '../src/agents/state/index.js';
import { SocialManager } from '../src/social/social-manager.js';
import {
  ConversationManagerImpl,
  defaultConversationManagerConfig,
} from '../src/social/conversation-manager.js';
import type { SmartObjectRegistryImpl } from '../src/world/objects/index.js';
import type { SceneManagerImpl } from '../src/world/scenes/index.js';
import { System1TriggerSourceImpl, System1AgentTracker } from '../src/systems/index.js';

function makeAgent(id: string) {
  return {
    id,
    name: id,
    description: 'test',
    traits: [],
    initialDrives: { energy: 50, hunger: 50, social: 50, comfort: 50, curiosity: 50 },
  };
}

/** Fake SceneMutationPort with a scripted event log. */
class FakeMutationPort {
  log: SceneMutationEvent[] = [];
  getMutations(sinceSeq?: number): SceneMutationEvent[] {
    return this.log.filter((m) => (sinceSeq === undefined ? true : m.seq > sinceSeq));
  }
}

/** Duck-typed registry/scene-manager stubs for ConversationManagerImpl (open path only). */
const registryStub = {
  get: () => null,
  applyStatePatch: () => {},
  register: () => {},
} as unknown as SmartObjectRegistryImpl;

const sceneStub = {
  getRoom: () => ({ objectIds: [] as string[] }),
} as unknown as SceneManagerImpl;

function makeConversationManager(agents: AgentManagerImpl): ConversationManagerImpl {
  return new ConversationManagerImpl({
    agentManager: agents,
    registry: registryStub,
    sceneManager: sceneStub,
    config: defaultConversationManagerConfig(),
  });
}

describe('Spec 035 — hard triggers toggle from engine state (AC-1, Req 5)', () => {
  it('messagePending fires when a social message is queued for the agent (peek, not consume)', () => {
    const agents = new AgentManagerImpl();
    agents.spawn(makeAgent('a1'));
    const social = new SocialManager(agents);
    const source = new System1TriggerSourceImpl({
      agentManager: agents,
      socialManager: social,
      tracker: new System1AgentTracker(),
    });

    expect(source.getHardTriggers('a1').messagePending).toBe(false);
    social.queueMessage('b2', 'a1', 'hello!');
    expect(source.getHardTriggers('a1').messagePending).toBe(true);
    // Peeking does not consume: still pending after re-check.
    expect(source.getHardTriggers('a1').messagePending).toBe(true);
  });

  it('conversationOpen fires when the agent participates in a live conversation', () => {
    const agents = new AgentManagerImpl();
    agents.spawn(makeAgent('a1'));
    agents.spawn(makeAgent('a2'));
    agents.updateState('a1', { location: 'cafe' });
    agents.updateState('a2', { location: 'cafe' });

    const conversations = makeConversationManager(agents);
    const source = new System1TriggerSourceImpl({
      agentManager: agents,
      conversationManager: conversations,
      tracker: new System1AgentTracker(),
    });

    expect(source.getHardTriggers('a1').conversationOpen).toBe(false);
    const result = conversations.openOrContribute('a2', 'a1', 'hi', 'neutral', 1);
    expect(result.success).toBe(true);
    const triggers = source.getHardTriggers('a1');
    expect(triggers.conversationOpen).toBe(true);
    // a1 IS a participant here → not merely invited.
    expect(triggers.conversationInvite).toBe(false);
  });

  it('conversationInvite fires for a live conversation in the room the agent could join', () => {
    const agents = new AgentManagerImpl();
    agents.spawn(makeAgent('a1'));
    agents.spawn(makeAgent('a2'));
    agents.spawn(makeAgent('a3'));
    agents.updateState('a1', { location: 'cafe' });
    agents.updateState('a2', { location: 'cafe' });
    agents.updateState('a3', { location: 'cafe' });

    const conversations = makeConversationManager(agents);
    const source = new System1TriggerSourceImpl({
      agentManager: agents,
      conversationManager: conversations,
      tracker: new System1AgentTracker(),
    });

    const opened = conversations.openOrContribute('a2', 'a3', 'hi', 'neutral', 1);
    expect(opened.success).toBe(true);
    // a1 is not a participant, but a live conversation exists in its room.
    const triggers = source.getHardTriggers('a1');
    expect(triggers.conversationInvite).toBe(true);
    expect(triggers.conversationOpen).toBe(false);
  });

  it('nearbyObjectMutation fires for mutations in the agent’s room since its last cycle', () => {
    const agents = new AgentManagerImpl();
    agents.spawn(makeAgent('a1'));
    agents.updateState('a1', { location: 'cafe' });
    const mutations = new FakeMutationPort();
    const tracker = new System1AgentTracker();
    const source = new System1TriggerSourceImpl({
      agentManager: agents,
      mutationPort: mutations as never,
      tracker,
    });

    expect(source.getHardTriggers('a1').nearbyObjectMutation).toBe(false);
    mutations.log.push({
      seq: 1,
      tick: 5,
      simTime: 0.1,
      type: 'set_state',
      source: 'agent',
      actorId: 'b2',
      roomId: 'cafe',
      payload: { objectId: 'coffee_machine', state: { power: 'on' } },
      summary: 'coffee_machine power → on',
    } as unknown as SceneMutationEvent);
    expect(source.getHardTriggers('a1').nearbyObjectMutation).toBe(true);

    // After the agent completes a cycle (tracker records seq 1), the same
    // mutation no longer triggers.
    tracker.recordCycleCompleted(
      'a1',
      { energy: 50, hunger: 50, social: 50, comfort: 50, curiosity: 50 },
      6,
      1,
    );
    expect(source.getHardTriggers('a1').nearbyObjectMutation).toBe(false);

    // A mutation in ANOTHER room never triggers.
    mutations.log.push({
      seq: 2,
      tick: 7,
      simTime: 0.2,
      type: 'add_object',
      source: 'engine',
      roomId: 'lab',
      payload: { objectId: 'laser', name: 'Laser', type: 'device' },
      summary: 'laser added to lab',
    } as unknown as SceneMutationEvent);
    expect(source.getHardTriggers('a1').nearbyObjectMutation).toBe(false);
  });

  it('driveThresholdCrossing fires from tracker drive snapshots (engine state alone)', () => {
    const agents = new AgentManagerImpl();
    agents.spawn(makeAgent('a1'));
    agents.updateState('a1', { location: 'cafe' });
    const tracker = new System1AgentTracker();
    const source = new System1TriggerSourceImpl({
      agentManager: agents,
      tracker,
    });

    // Record the last-cycle drive snapshot at hunger 25 (above the low threshold 20).
    tracker.recordCycleCompleted(
      'a1',
      { energy: 50, hunger: 25, social: 50, comfort: 50, curiosity: 50 },
      1,
      0,
    );
    // Drive decay (or an affordance) pushes hunger to 18 → crossing.
    agents.updateState('a1', {
      drives: { energy: 50, hunger: 18, social: 50, comfort: 50, curiosity: 50 },
    });
    const triggers = source.getHardTriggers('a1');
    expect(triggers.driveThresholdCrossing).toBe(true);
    expect(
      detectThresholdCrossings(
        { energy: 50, hunger: 25, social: 50, comfort: 50, curiosity: 50 },
        { energy: 50, hunger: 18, social: 50, comfort: 50, curiosity: 50 },
      ),
    ).toBe(true);

    // No snapshot recorded → no crossing detectable → false.
    const fresh = new System1AgentTracker();
    const source2 = new System1TriggerSourceImpl({ agentManager: agents, tracker: fresh });
    expect(source2.getHardTriggers('a1').driveThresholdCrossing).toBe(false);
  });

  it('an unknown agent yields no triggers (no crash)', () => {
    const agents = new AgentManagerImpl();
    const source = new System1TriggerSourceImpl({
      agentManager: agents,
      tracker: new System1AgentTracker(),
    });
    expect(source.getHardTriggers('ghost')).toEqual({
      messagePending: false,
      conversationInvite: false,
      nearbyObjectMutation: false,
      driveThresholdCrossing: false,
    });
  });
});

describe('Spec 035 — System1AgentTracker (ticks since last completed cycle)', () => {
  it('records drives + tick at cycle completion and counts ticks since', () => {
    const tracker = new System1AgentTracker();
    expect(tracker.getTicksSinceLastCycle('a1')).toBe(Number.POSITIVE_INFINITY);
    tracker.recordCycleCompleted(
      'a1',
      { energy: 10, hunger: 20, social: 30, comfort: 40, curiosity: 50 },
      100,
      0,
    );
    expect(tracker.getTicksSinceLastCycle('a1')).toBe(0);
    expect(tracker.noteTick('a1', 101)).toBe(1);
    expect(tracker.noteTick('a1', 105)).toBe(5);
    expect(tracker.getDrivesAtLastCycle('a1')).toEqual({
      energy: 10,
      hunger: 20,
      social: 30,
      comfort: 40,
      curiosity: 50,
    });
  });

  it('per-agent counters are independent', () => {
    const tracker = new System1AgentTracker();
    tracker.recordCycleCompleted(
      'a1',
      { energy: 1, hunger: 1, social: 1, comfort: 1, curiosity: 1 },
      5,
      0,
    );
    tracker.noteTick('a1', 6);
    tracker.noteTick('a2', 6);
    expect(tracker.getTicksSinceLastCycle('a1')).toBe(1);
    expect(tracker.getTicksSinceLastCycle('a2')).toBe(Number.POSITIVE_INFINITY);
    expect(tracker.getLastMutationSeq('a1')).toBe(0);
  });
});

describe('Spec 035 — shared threshold-crossing contract (Req 2)', () => {
  it('the shared pure function matches the hand-computed cases', () => {
    expect(
      detectThresholdCrossings(
        { energy: 50, hunger: 25, social: 50, comfort: 50, curiosity: 50 },
        { energy: 50, hunger: 18, social: 50, comfort: 50, curiosity: 50 },
      ),
    ).toBe(true);
    expect(
      detectThresholdCrossings(
        { energy: 50, hunger: 30, social: 50, comfort: 50, curiosity: 50 },
        { energy: 50, hunger: 22, social: 50, comfort: 50, curiosity: 50 },
      ),
    ).toBe(false);
  });
});