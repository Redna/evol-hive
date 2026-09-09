/**
 * Spec 044 — Social Urge Model: cross-package E2E for the pending-address
 * line (issue #160, AC-3, R4a).
 * ────────────────────────────────────────────────────────────────────────────
 * The engine suite proves `ConversationManagerImpl.getConversationsAwaitingAgentReply`
 * reports the owed reply (data layer); the cognition suite proves the builder
 * renders the line from `pendingAddresses` (render layer). This test closes
 * the seam at full fidelity, using the only workspace package that may depend
 * on both cognition and engine (`@evol-hive/cli`), following the spec-040/041
 * E2E pattern:
 *
 *   real ConversationManagerImpl (engine) ← A talks to co-located B
 *   real PerceptionDataProviderImpl (engine) → awaiting-reply query
 *   real PerceptionServiceImpl (cognition) → pendingAddresses + socialUrges
 *   real PerceptionBuilderImpl (cognition) → INFORMATION line quoting the
 *     actual message text, in the dynamic section only
 *
 * Zero LLM calls — the whole path is deterministic (spec 044 Constraints).
 */
import { describe, it, expect } from 'vitest';
import type { Affordance } from '@evol-hive/shared';
import type { AffordanceClassifier } from '@evol-hive/cognition';
import { PerceptionBuilderImpl, PerceptionServiceImpl } from '@evol-hive/cognition';
import {
  AgentManagerImpl,
  ConversationManagerImpl,
  PerceptionDataProviderImpl,
  SmartObjectRegistryImpl,
  SocialManager,
  SystemFeedbackStore,
  SceneManagerImpl,
  DriveSystemImpl,
  defaultConversationManagerConfig,
} from '@evol-hive/engine';
import type { AgentProfile } from '@evol-hive/shared';

const GARDEN = 'garden';
const KITCHEN = 'kitchen';

function makeProfile(id: string, traits: string[] = []): AgentProfile {
  return {
    id,
    name: id,
    description: '',
    traits,
    initialDrives: {},
    startRoomId: GARDEN,
  };
}

/** Stub System 0 classifier — no pruning for this test. */
const stubClassifier: AffordanceClassifier = {
  prune: async (_driveLabel: string, affordances: Affordance[]) => affordances,
};

function buildWiredWorld() {
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
  const driveSystem = new DriveSystemImpl(agentManager, 0.1);
  const feedbackStore = new SystemFeedbackStore();
  const conversationManager = new ConversationManagerImpl({
    agentManager,
    registry,
    sceneManager,
    config: defaultConversationManagerConfig(),
  });
  const socialManager = new SocialManager(agentManager);
  socialManager.setConversationManager(conversationManager);

  const provider = new PerceptionDataProviderImpl(
    agentManager,
    registry,
    driveSystem,
    feedbackStore,
  );
  provider.setSocialManager(socialManager);
  provider.setConversationManager(conversationManager);
  provider.setTickSource(() => 100);

  for (const [id, traits] of [
    ['agent-a', ['reserved']] as const,
    ['agent-b', ['energetic']] as const,
  ]) {
    agentManager.spawn({ ...makeProfile(id), traits: [...traits] }, 0);
    agentManager.updateState(id, { location: GARDEN });
  }

  const service = new PerceptionServiceImpl({ provider, classifier: stubClassifier });
  const builder = new PerceptionBuilderImpl();
  return { agentManager, conversationManager, socialManager, provider, service, builder };
}

describe('spec 044 E2E — pending-address line through the real stack (AC-3, R4a)', () => {
  it("after A talks to co-located B, B's built perception quotes A's actual message", async () => {
    const world = buildWiredWorld();
    const open = world.conversationManager.openOrContribute(
      'agent-a',
      'agent-b',
      'Where do you get good beans?',
      'neutral',
      10,
    );
    expect(open.success).toBe(true);

    const perception = await world.service.perceive('agent-b');
    expect(perception.pendingAddresses).toHaveLength(1);
    expect(perception.pendingAddresses![0]!.content).toBe('Where do you get good beans?');

    const payload = world.builder.build(perception);
    expect(payload.perceptionContext).toContain(
      'agent-a addressed you, awaiting response: "Where do you get good beans?"',
    );
    // Dynamic section only (spec 021): never in the stable prefix.
    const lines = payload.perceptionContext.split('\n');
    const separator = lines.indexOf('---');
    const stable = lines.slice(0, separator).join('\n');
    const dynamic = lines.slice(separator + 1).join('\n');
    expect(dynamic).toContain('awaiting response');
    expect(stable).not.toContain('awaiting response');
  });

  it("the initiator's own payload owes nobody a reply (no pending-address line)", async () => {
    const world = buildWiredWorld();
    world.conversationManager.openOrContribute('agent-a', 'agent-b', 'hi', 'neutral', 10);

    const perception = await world.service.perceive('agent-a');
    expect(perception.pendingAddresses).toBeUndefined();
    const payload = world.builder.build(perception);
    expect(payload.perceptionContext).not.toContain('awaiting response');
  });

  it('urge assessments are populated per present agent (seed + reciprocity differentiate)', async () => {
    const world = buildWiredWorld();
    // A greets B three times with no reply — B's side of the pair decays for A.
    world.conversationManager.openOrContribute('agent-a', 'agent-b', 'hi', 'neutral', 10);
    world.socialManager.updateRelationship('agent-a', 'agent-b', { sentCount: 2 });

    const perceptionA = await world.service.perceive('agent-a');
    expect(perceptionA.socialUrges).toHaveLength(1);
    const urgeA = perceptionA.socialUrges![0]!;
    expect(urgeA.sentCount).toBe(2);
    expect(urgeA.result.factors.reciprocityFactor).toBeLessThan(0.7);
    // Decay hint rendered (urge below threshold, factor decayed).
    const payloadA = world.builder.build(perceptionA);
    expect(payloadA.perceptionContext).toContain('agent-b rarely answers');
  });
});
