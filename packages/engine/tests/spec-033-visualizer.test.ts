/**
 * Tests for spec 033 — Visualizer conversation rendering (issue #128) —
 * engine data-adapter layer.
 *
 * Covers:
 * - AC-10 (R9): the visualizer state carries live conversation objects
 *   (topic + participants) with a sentiment-derived tint.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { PPEROrchestratorPort, PPERPhase } from '@evol-hive/shared';
import { GameLoopImpl } from '../src/loop/index.js';
import { AgentManagerImpl } from '../src/agents/state/index.js';
import { SmartObjectRegistryImpl } from '../src/world/objects/index.js';
import { SceneManagerImpl } from '../src/world/scenes/index.js';
import { VisualizerDataAdapter } from '../src/visualizer/data-adapter.js';
import {
  ConversationManagerImpl,
  defaultConversationManagerConfig,
} from '../src/social/conversation-manager.js';

const GARDEN = 'garden';

function makeConfig() {
  return {
    fps: 60,
    spatialDebounceSeconds: 5,
    maxConcurrentLLM: 8,
    guardrailsEnabled: true,
    guardrails: { affordanceMasking: true, contextualForcing: true, planValidation: true },
  };
}

class FakeOrchestrator implements PPEROrchestratorPort {
  async runCycle(_agentId: string): Promise<void> {}
  getPhase(_agentId: string): PPERPhase {
    return 'perceive';
  }
}

function buildAdapter(): {
  adapter: VisualizerDataAdapter;
  conversations: ConversationManagerImpl;
  agentManager: AgentManagerImpl;
} {
  const gameLoop = new GameLoopImpl(makeConfig());
  const agentManager = new AgentManagerImpl();
  const registry = new SmartObjectRegistryImpl();
  const sceneManager = new SceneManagerImpl(
    agentManager,
    new Map([[GARDEN, { id: GARDEN, name: GARDEN, description: '', connections: [], objectIds: [] }]]),
  );
  const conversations = new ConversationManagerImpl({
    agentManager,
    registry,
    sceneManager,
    config: defaultConversationManagerConfig(),
  });
  const adapter = new VisualizerDataAdapter({
    gameLoop,
    agentManager,
    smartObjectRegistry: registry,
    sceneManager,
    orchestrator: new FakeOrchestrator(),
    conversationManager: conversations,
  });
  for (const id of ['agent-a', 'agent-b']) {
    agentManager.spawn({
      id,
      name: id,
      description: '',
      traits: [],
      initialDrives: {},
      startRoomId: GARDEN,
    });
    agentManager.updateState(id, { location: GARDEN });
  }
  return { adapter, conversations, agentManager };
}

describe('visualizer conversation projection (AC-10, R9)', () => {
  let ctx: ReturnType<typeof buildAdapter>;
  beforeEach(() => {
    ctx = buildAdapter();
  });

  it('renders live conversation objects with topic, participants, and tint', () => {
    const opened = ctx.conversations.openOrContribute(
      'agent-a',
      'agent-b',
      'hi',
      'positive',
      11,
      'compost',
    );
    ctx.conversations.openOrContribute('agent-b', 'agent-a', 'hello!', 'positive', 12);

    const snapshot = ctx.adapter.getSnapshot();
    const garden = snapshot.rooms.find((r) => r.id === GARDEN)!;
    const convObj = garden.objects.find((o) => o.id === opened.conversation!.id);
    expect(convObj).toBeDefined();
    expect(convObj!.conversation).toBeDefined();
    expect(convObj!.conversation!.topic).toBe('compost');
    expect(convObj!.conversation!.participants.sort()).toEqual(['agent-a', 'agent-b']);
    expect(convObj!.conversation!.sentimentTint).toBeTruthy();
  });

  it('the tint follows the dominant sentiment (negative ≠ positive)', () => {
    const opened = ctx.conversations.openOrContribute('agent-a', 'agent-b', 'hi', 'positive', 11);
    const positiveSnapshot = ctx.adapter.getSnapshot();
    const positiveTint = positiveSnapshot.rooms
      .find((r) => r.id === GARDEN)!
      .objects.find((o) => o.id === opened.conversation!.id)!.conversation!.sentimentTint;

    ctx.conversations.openOrContribute('agent-b', 'agent-a', 'terrible', 'negative', 12);
    ctx.conversations.openOrContribute('agent-a', 'agent-b', 'worst', 'negative', 13);
    const negativeSnapshot = ctx.adapter.getSnapshot();
    const negativeTint = negativeSnapshot.rooms
      .find((r) => r.id === GARDEN)!
      .objects.find((o) => o.id === opened.conversation!.id)!.conversation!.sentimentTint;

    expect(negativeTint).not.toBe(positiveTint);
  });

  it('plain objects carry no conversation projection', () => {
    const snapshot = ctx.adapter.getSnapshot();
    const objects = snapshot.rooms.find((r) => r.id === GARDEN)!.objects;
    expect(objects.every((o) => o.conversation === undefined)).toBe(true);
  });
});