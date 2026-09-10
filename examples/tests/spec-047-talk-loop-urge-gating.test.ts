/**
 * QA coverage for spec 047 — Talk Loop Fix: Urge-Gated Social Urgency &
 * Asymmetric Social Reward (issue #176) — production-stack integration/E2E.
 *
 * Mirrors the spec 045/046 QA suite structure: every wire under test comes
 * from the PRODUCTION assembly (`createEngineCore` + `assembleCognitionStack`,
 * no manual wiring). Deterministic throughout — no LLM anywhere.
 *
 * 1. AC-2 (E2E) — a real exchange restores social as today: the sender ends
 *    at +10 total across the two events (+2 on send through the production
 *    executor's R5 split, +8 when the target contributes to the SAME thread
 *    through the engine-side R6 deferred restore wired in `createEngineCore`).
 * 2. AC-1 (integration) — the spam bound: an "obedient LLM" simulation (talks
 *    whenever the 024 urgency directive renders, does something else when it
 *    does not) against a non-responsive target yields ≤ 10 talk events per
 *    pair for the whole run — vs 443 in the issue's evidence run. The gate
 *    (R1) plus the cap (R4) plus the asymmetric reward (R5) break the loop.
 * 3. AC-8 (prompt snapshot) — with the urge decayed toward all present, the
 *    rendered perception contains the no-outlet line and NO dynamic-section
 *    directive or hint instructing the agent to call talk_to; the stable
 *    prefix (Agents-present capability line) is unchanged (KV-cache, spec 021).
 * 4. AC-7 (backward compat) — with no reciprocity history (fresh relationship,
 *    urges healthy), the directive and hint render exactly as today.
 *
 * The cognition-side +2 precision and the engine-side idempotency are covered
 * unit-level in packages/cognition and packages/engine suites.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Affordance, AgentProfile, EngineConfig } from '@evol-hive/shared';
import { SOCIAL_MONOLOGUE_REWARD, SOCIAL_EXCHANGE_BONUS } from '@evol-hive/shared';
import { createEngineCore } from '@evol-hive/engine';
import type { EngineCore } from '@evol-hive/engine';
import {
  CognitiveToolExecutorImpl,
  PerceptionBuilderImpl,
  PerceptionServiceImpl,
} from '@evol-hive/cognition';
import type { AffordanceClassifier } from '@evol-hive/cognition';
import { assembleCognitionStack, buildMemorySubsystem } from '../assembly.ts';
import type { CognitionStack } from '../assembly.ts';

const ROOM = 'garden';

const DIRECTIVE = 'IMPORTANT: Other agents are present.';
const SOCIAL_HINT = 'You feel a strong need for social interaction.';
const NO_OUTLET = 'No one in the room is responsive — consider another activity or help.';

function makeProfile(id: string, name: string): AgentProfile {
  return { id, name, description: `agent ${id}`, traits: [], initialDrives: {} };
}

function makeEngineConfig(): EngineConfig {
  return {
    fps: 30,
    spatialDebounceSeconds: 2,
    maxConcurrentLLM: 2,
    guardrailsEnabled: false,
    guardrails: { affordanceMasking: true, contextualForcing: true, planValidation: true },
  };
}

function spawnCoLocatedPair(core: EngineCore, room = ROOM): void {
  core.agentManager.spawn(makeProfile('agent-alice', 'Alice'));
  core.agentManager.spawn(makeProfile('agent-bob', 'Bob'));
  core.agentManager.updateState('agent-alice', { location: room });
  core.agentManager.updateState('agent-bob', { location: room });
}

/** Split a perceptionContext at the `---` separator into [stable, dynamic]. */
function splitSections(context: string): { stable: string; dynamic: string } {
  const lines = context.split('\n');
  const sep = lines.indexOf('---');
  expect(sep, 'perceptionContext must contain a --- separator line').toBeGreaterThan(-1);
  return { stable: lines.slice(0, sep).join('\n'), dynamic: lines.slice(sep + 1).join('\n') };
}

describe('spec 047 — production stack: urge-gated urgency, asymmetric reward', () => {
  let core: EngineCore;
  let stack: CognitionStack;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    delete process.env['USE_REAL_EMBEDDINGS'];
    process.env['USE_REAL_LLM'] = 'true'; // the executor is only constructed on the real-LLM path
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const memory = buildMemorySubsystem();
    core = createEngineCore(makeEngineConfig(), memory.memoryStore, memory.vectorStore);
    stack = assembleCognitionStack(core, undefined, { memory, wireMemoryMaintenance: false });
    spawnCoLocatedPair(core);
    expect(stack.cognitiveToolExecutor).toBeDefined();
  });

  afterEach(() => {
    delete process.env['USE_REAL_LLM'];
    logSpy.mockRestore();
    vi.restoreAllMocks();
  });

  /** The real Perceive phase over the production-assembled provider. */
  async function renderPerception(agentId: string): Promise<string> {
    const stubClassifier: AffordanceClassifier = {
      prune: async (_driveLabel: string, affordances: Affordance[]) => affordances,
    };
    const service = new PerceptionServiceImpl({
      provider: core.bridges.perception,
      classifier: stubClassifier,
    });
    const builder = new PerceptionBuilderImpl();
    const perception = await service.perceive(agentId);
    return builder.build(perception).perceptionContext;
  }

  // ── AC-2 — a real exchange restores social as today (+10 across two events) ─

  it('AC-2: sender +2 on send, +8 when the target contributes to the SAME thread — total +10', async () => {
    // Start below the clamp so both grants are visible.
    core.agentManager.getState('agent-alice')!.drives.social = 40;

    const send = await stack.cognitiveToolExecutor!.executeTalkTo(
      'agent-alice',
      'Bob',
      'Morning, Bob. Need a hand?',
      'neutral',
    );
    expect(send.success).toBe(true);

    const afterSend = core.agentManager.getState('agent-alice')!.drives.social;
    expect(afterSend).toBe(40 + SOCIAL_MONOLOGUE_REWARD); // +2 — the monologue token

    // The target replies into the SAME thread (display name — spec 046 path).
    const reply = await stack.cognitiveToolExecutor!.executeTalkTo(
      'agent-bob',
      'Alice',
      'Sure, what do you need?',
      'positive',
    );
    expect(reply.success).toBe(true);

    // The engine-side deferred restore tops the sender up to the full +10.
    const afterReply = core.agentManager.getState('agent-alice')!.drives.social;
    expect(afterReply - 40).toBe(SOCIAL_MONOLOGUE_REWARD + SOCIAL_EXCHANGE_BONUS); // +10
    expect(afterReply).toBe(50);

    // Bob's own reply granted the monologue token only (his exchange
    // completion would be Alice's reply — none in this trace; and the engine
    // grant is per-(sender, conversation), never self-granted on send).
    core.agentManager.getState('agent-bob')!.drives.social = 80;
    await stack.cognitiveToolExecutor!.executeTalkTo('agent-bob', 'Alice', 'once more', 'neutral');
    expect(core.agentManager.getState('agent-bob')!.drives.social).toBe(
      80 + SOCIAL_MONOLOGUE_REWARD,
    );
  });

  it('AC-2b: the deferred restore is idempotent through the production stack (1..N contributions)', async () => {
    core.agentManager.getState('agent-alice')!.drives.social = 40;
    await stack.cognitiveToolExecutor!.executeTalkTo('agent-alice', 'Bob', 'hello', 'neutral');
    expect(core.agentManager.getState('agent-alice')!.drives.social).toBe(42);

    // Bob contributes 1..N turns to the same thread.
    for (let i = 0; i < 3; i++) {
      await stack.cognitiveToolExecutor!.executeTalkTo(
        'agent-bob',
        'Alice',
        `reply ${i}`,
        'neutral',
      );
    }
    // Exactly one +8 for (Alice, conversation): 42 + 8 = 50, never more.
    expect(core.agentManager.getState('agent-alice')!.drives.social).toBe(50);
  });

  // ── AC-1 — the spam bound: urge-gated urgency + cap + asymmetric reward ─────

  it('AC-1: an obedient-LLM run against a non-responsive target yields ≤ 10 talk events per pair', async () => {
    let talkEvents = 0;
    const ITERATIONS = 30;

    for (let i = 0; i < ITERATIONS; i++) {
      const context = await renderPerception('agent-alice');
      const { dynamic } = splitSections(context);
      // The "obedient LLM" models the issue's mechanism: one imperative line
      // (the 024 directive) beats one informational hint — talk while the
      // directive renders, do something else when it does not. Bob never
      // replies (non-responsive target).
      if (dynamic.includes(DIRECTIVE)) {
        const result = await stack.cognitiveToolExecutor!.executeTalkTo(
          'agent-alice',
          'Bob',
          `Morning, Bob. Need a hand? (${i})`,
          'neutral',
        );
        if (result.success) talkEvents++;
      }
      // (else: the agent picks another affordance — modeled as a no-op wait)
    }

    // The issue's run produced 443 monologues per pair; the gated loop is
    // bounded by the urge gate + cap + reward asymmetry.
    expect(talkEvents).toBeLessThanOrEqual(10);
    expect(talkEvents).toBeGreaterThan(0); // the sim actually exercised the path
  });

  // ── AC-8 — prompt snapshot: no-outlet guidance replaces the talk_to push ────

  it('AC-8: decayed urge toward all present → no-outlet line, no talk_to directive or hint', async () => {
    // Low social drive so the 018 hint would render pre-gate (meaningful
    // suppression assertion); the urge decay dominates regardless.
    core.agentManager.getState('agent-alice')!.drives.social = 30;
    // Drive the reciprocity counters down: three unanswered monologues.
    for (let i = 0; i < 3; i++) {
      await stack.cognitiveToolExecutor!.executeTalkTo(
        'agent-alice',
        'Bob',
        `Morning, Bob. Need a hand? (${i})`,
        'neutral',
      );
    }

    const context = await renderPerception('agent-alice');
    const { stable, dynamic } = splitSections(context);

    // The no-outlet guidance is present (dynamic section — KV-cache safe).
    expect(dynamic).toContain(NO_OUTLET);
    // No directive or hint instructing the agent to call talk_to remains.
    expect(dynamic).not.toContain(DIRECTIVE);
    expect(dynamic).not.toContain(SOCIAL_HINT);
    // The spec 044 per-target decay hint renders (R2 keeps it).
    expect(dynamic).toContain('Bob rarely answers');

    // KV-cache: the stable prefix is unchanged — the capability line stays.
    expect(stable).toContain('Agents present: Bob (agent-bob)');
    expect(stable).toContain('You can call talk_to, observe_agent, help, or ignore directly');
    expect(stable).not.toContain(NO_OUTLET);

    // Influence, not force: talk_to is still in the tool list.
    const payload = await (async () => {
      const stubClassifier: AffordanceClassifier = {
        prune: async (_driveLabel: string, affordances: Affordance[]) => affordances,
      };
      const service = new PerceptionServiceImpl({
        provider: core.bridges.perception,
        classifier: stubClassifier,
      });
      return new PerceptionBuilderImpl().build(await service.perceive('agent-alice'));
    })();
    expect(payload.tools.map((t) => t.function.name)).toContain('talk_to');
  });

  // ── AC-7 — backward compat: fresh relationships keep today's behavior ───────

  it('AC-7: fresh relationship (no reciprocity history) → directive and hint render as today', async () => {
    core.agentManager.getState('agent-alice')!.drives.social = 30; // primary drive: social
    const context = await renderPerception('agent-alice');
    expect(context).toContain(DIRECTIVE);
    expect(context).toContain(SOCIAL_HINT);
    expect(context).not.toContain(NO_OUTLET);
  });
});