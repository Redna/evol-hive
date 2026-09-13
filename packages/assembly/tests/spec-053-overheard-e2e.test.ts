/**
 * Spec 053 — Room-Perceivable Conversation Content (issue #192): E2E through
 * the production assembly (QA coverage pass — PR #194).
 * ────────────────────────────────────────────────────────────────────────────
 * The PR's three unit suites cover the pieces in isolation: the engine suite
 * drives `ConversationManagerImpl.getOverheardConversations` directly, and the
 * cognition suite renders fake-provider data. Neither exercised the
 * production path END to END:
 *
 *   real `ConversationManagerImpl` (opened via the production `talk_to`
 *   executor) → real `SocialManager` → real `core.bridges.perception`
 *   (PerceptionDataProviderImpl pass-through) → real `PerceptionServiceImpl`
 *   → real `PerceptionBuilderImpl`.
 *
 * These tests close that gap, mirroring the spec-043/050 assembly pattern
 * (`core.bridges.perception` + a real perceive/build render):
 *
 * - AC-1 (R1): a co-located non-participant's RENDERED perception contains
 *   `INFORMATION: Overheard — …` (dynamic section only, spec 021).
 * - AC-5 (R5): participants' rendered perception contains no overheard lines
 *   for their own conversation — thread context stays on the pending-address
 *   channel (spec 044 R4a).
 * - AC-2 (R3): `observe` through the production manager returns the full
 *   window without adding the observer to participants.
 * - AC-9: zero LLM calls across the entire deterministic path (talk_to with
 *   explicit sentiment + perception render) — asserted with spies on every
 *   LLMClient method.
 *
 * Deterministic throughout — no network (the real-LLM path only constructs
 * the client; every method call is spied and counted).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Affordance, AgentProfile, EngineConfig } from '@evol-hive/shared';
import type { AffordanceClassifier, LLMClient } from '@evol-hive/cognition';
import { PerceptionServiceImpl, PerceptionBuilderImpl } from '@evol-hive/cognition';
import type { EngineCore } from '@evol-hive/engine';
import { assembleWorld } from '@evol-hive/assembly';
import type { AssembledWorld } from '@evol-hive/assembly';

// ── Env hygiene ──────────────────────────────────────────────────────────────

const ENV_KEYS = ['USE_REAL_LLM', 'USE_REAL_EMBEDDINGS', 'ENGINE_MAX_CONCURRENT_LLM'] as const;

beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  vi.restoreAllMocks();
});

// ── Fixtures (mirroring the spec 050 assembly suite) ─────────────────────────

const ROOM = 'garden';

function makeConfig(): EngineConfig {
  return {
    fps: 30,
    spatialDebounceSeconds: 2,
    maxConcurrentLLM: 8,
    guardrailsEnabled: true,
    guardrails: { affordanceMasking: true, contextualForcing: true, planValidation: true },
  };
}

function makeProfile(id: string): AgentProfile {
  return { id, name: id, description: `agent ${id}`, traits: [], initialDrives: {} };
}

/** Spawn the talk pair + the co-located bystander (scene data — in `sceneSetup`). */
function spawnTrio(core: EngineCore): void {
  for (const id of ['agent-a', 'agent-b', 'agent-c']) {
    core.agentManager.spawn(makeProfile(id));
    core.agentManager.updateState(id, { location: ROOM, lastPerceptionTick: 0 });
  }
}

/** A pass-through classifier (no embeddings, no network). */
function stubClassifier(): AffordanceClassifier {
  return { prune: async (_driveLabel: string, affordances: Affordance[]) => affordances };
}

/**
 * The real Perceive phase over the production-assembled provider — the exact
 * components the PPER orchestrator builds internally (spec 045 QA pattern).
 */
async function renderPerception(core: EngineCore, agentId: string): Promise<string> {
  const service = new PerceptionServiceImpl({
    provider: core.bridges.perception,
    classifier: stubClassifier(),
  });
  const builder = new PerceptionBuilderImpl();
  const perception = await service.perceive(agentId);
  return builder.build(perception).perceptionContext;
}

function splitAtSeparator(context: string): { above: string; below: string } {
  const lines = context.split('\n');
  const separator = lines.indexOf('---');
  expect(separator, 'perceptionContext must contain a --- separator').toBeGreaterThan(0);
  return {
    above: lines.slice(0, separator).join('\n'),
    below: lines.slice(separator + 1).join('\n'),
  };
}

/** Build the fully-assembled world with the trio spawned (executor = real path). */
function buildWorld(): AssembledWorld {
  process.env['USE_REAL_LLM'] = 'true'; // the executor is built on the real-LLM path
  return assembleWorld({
    config: makeConfig(),
    sceneSetup: spawnTrio,
    wireMemoryMaintenance: false,
  });
}

// ── AC-1 (R1): the bystander overheard path through production wiring ────────

describe('spec 053 E2E — overheard perception through the production assembly', () => {
  it('a co-located bystander’s rendered perception carries the overheard turn (AC-1, R1 production path)', async () => {
    const { core, stack } = buildWorld();
    const opened = await stack!.cognitiveToolExecutor!.executeTalkTo(
      'agent-a',
      'agent-b',
      'Where do you get good beans?',
      'neutral',
    );
    expect(opened.success).toBe(true);

    // The provider bridge pass-through surfaces the scan (the assembly-level
    // seam — the exact analog of the spec-043 `core.bridges.perception` test).
    const viaBridge = core.bridges.perception.getOverheardConversations('agent-c');
    expect(viaBridge).toHaveLength(1);
    expect(viaBridge[0]!.lines[0]!.content).toBe('Where do you get good beans?');

    // …and the REAL perceive→build chain renders it.
    const payload = await renderPerception(core, 'agent-c');
    expect(payload).toContain(
      'INFORMATION: Overheard — agent-a to agent-b: "Where do you get good beans?"',
    );
  });

  it('overheard lines render in the dynamic section only — nothing above --- changes (spec 021)', async () => {
    const { core, stack } = buildWorld();
    await stack!.cognitiveToolExecutor!.executeTalkTo(
      'agent-a',
      'agent-b',
      'the pump is clogged again',
      'negative',
    );
    const payload = await renderPerception(core, 'agent-c');
    const { above, below } = splitAtSeparator(payload);
    expect(below).toContain('INFORMATION: Overheard');
    expect(above).not.toContain('Overheard');
  });

  it('participants get NO overheard lines for their own conversation (AC-5, R5)', async () => {
    const { core, stack } = buildWorld();
    await stack!.cognitiveToolExecutor!.executeTalkTo(
      'agent-a',
      'agent-b',
      'Where do you get good beans?',
      'neutral',
    );
    // The addressee keeps the thread context on the pending-address channel.
    const payloadB = await renderPerception(core, 'agent-b');
    expect(payloadB).toContain('agent-a addressed you, awaiting response');
    expect(payloadB).not.toContain('INFORMATION: Overheard');
    // The initiator owes nothing and receives neither channel for the thread.
    const payloadA = await renderPerception(core, 'agent-a');
    expect(payloadA).not.toContain('INFORMATION: Overheard');
    expect(payloadA).not.toContain('awaiting response');
  });

  it('a closed conversation overheard nothing: lines vanish for the bystander', async () => {
    const { core, stack } = buildWorld();
    await stack!.cognitiveToolExecutor!.executeTalkTo(
      'agent-a',
      'agent-b',
      'hello there',
      'neutral',
    );
    const conversation = core.conversationManager.listConversationsInRoom(ROOM)[0]!;
    core.conversationManager.leave('agent-a', conversation.id, 100);
    core.conversationManager.leave('agent-b', conversation.id, 101); // last → closed
    const payload = await renderPerception(core, 'agent-c');
    expect(payload).not.toContain('INFORMATION: Overheard');
  });
});

// ── AC-2 (R3): observe through the production manager ────────────────────────

describe('spec 053 E2E — observe through the production manager', () => {
  it('observe returns the full window and never makes the observer a participant (AC-2, R3)', async () => {
    const { core, stack } = buildWorld();
    await stack!.cognitiveToolExecutor!.executeTalkTo(
      'agent-a',
      'agent-b',
      'Where do you get good beans?',
      'neutral',
    );
    await stack!.cognitiveToolExecutor!.executeTalkTo(
      'agent-b',
      'agent-a',
      'from the beans cart',
      'positive',
    );
    const conversation = core.conversationManager.listConversationsInRoom(ROOM)[0]!;
    const observed = core.conversationManager.observe('agent-c', conversation.id);
    expect(observed.success).toBe(true);
    expect(observed.turns).toHaveLength(2);
    expect(observed.turns!.map((t) => t.content)).toEqual([
      'Where do you get good beans?',
      'from the beans cart',
    ]);
    expect(observed.turns![0]!.tick).toBeLessThanOrEqual(observed.turns![1]!.tick); // oldest first

    // Observation is not participation: participants unchanged, eligibility
    // stays join/observe only (no contribute).
    const after = core.conversationManager
      .getConversation(conversation.id)!
      .participants.map((p) => p.agentId);
    expect(after).toEqual(['agent-a', 'agent-b']);
    const eligible = core.conversationManager.getEligibleAffordances(conversation.id, 'agent-c');
    expect(eligible).toEqual(['join', 'observe']);
  });
});

// ── AC-9: zero LLM calls across the deterministic path ───────────────────────

describe('spec 053 E2E — the overheard path is pure TypeScript (AC-9)', () => {
  it('talk_to + bystander perceive + render make ZERO LLM calls', async () => {
    const world = buildWorld();
    const { core, stack } = world;
    const llm = stack!.llmClient as LLMClient;
    const spies = [
      vi.spyOn(llm, 'completeStructured'),
      vi.spyOn(llm, 'completeReflection'),
      vi.spyOn(llm, 'completePlan'),
      vi.spyOn(llm, 'completeReflect'),
    ];

    await stack!.cognitiveToolExecutor!.executeTalkTo(
      'agent-a',
      'agent-b',
      'Where do you get good beans?',
      'neutral',
    );
    const payload = await renderPerception(core, 'agent-c');
    expect(payload).toContain('INFORMATION: Overheard');
    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled();
    }
  });
});
