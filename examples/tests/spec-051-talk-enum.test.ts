/**
 * QA coverage for spec 051 — Enum-Bound Conversation Targeting (issue #186,
 * PR #188) — production-stack integration/E2E.
 *
 * The spec-051 unit suites (packages/shared, packages/cognition,
 * packages/engine) pin each layer against synthetic fixtures. This suite
 * closes the cross-layer gap against the PRODUCTION-constructed stack
 * (`createEngineCore` + `assembleCognitionStack`, no manual wiring — the
 * exact components live runs use), mirroring the spec 046/047 QA suites:
 *
 * 1. Spec-doc integrity — R1–R5 and AC-1..AC-10 present, issue #186
 *    referenced.
 * 2. AC-2 (E2E) — the production perceive path renders `talk_to` whose
 *    `targetAgentId` enum EQUALS the engine's `enumerateTalkTargets` output
 *    (the engine is the source of truth; cognition renders the same value
 *    space); no free-form target description remains; the plan-builder
 *    payload (fed the SAME real PerceptionResult) carries the same enum; the
 *    enum never leaks into the stable system prompt (KV-cache, spec 021).
 * 3. AC-3 (integration) — cap bob via the real additive write path
 *    (`updateRelationship` `{sentCount: 3}`): the engine enumeration drops
 *    bob and keeps carol (per-target), and the perception + plan enums agree.
 * 4. AC-4 (E2E) — every present agent capped → `talk_to` absent from BOTH
 *    the perceive/action-choice tool list AND the plan tool list while
 *    observe_agent/help/ignore render; an agent alone in a room → no
 *    talk_to, no crash.
 * 5. AC-6 (integration) — a resolved-but-capped target is refused by the
 *    PRODUCTION executor (display-name AND exact-ID path): the structured
 *    failure names the target and the give-space/reply policy, and NOTHING
 *    is written (no queue message, no conversation, no relationship delta,
 *    no reciprocity counter, no +2 monologue drive grant). A fresh sibling
 *    target is still accepted (per-target enforcement).
 * 6. AC-5 (E2E) — mechanical recovery: the target's REAL reply through the
 *    executor raises `receivedCount`, the gap drops below the cap, and the
 *    target re-enters the enum on the next perception AND the executor
 *    accepts the send again (Decision 2 — the gap IS the clock).
 * 7. AC-8 (integration, real data) — the `[talk-enum]` diagnostic renders
 *    present/valid/excluded over the REAL perception (fresh pair; after
 *    capping; no agents present → no line). The orchestrator-seam wiring is
 *    source-pinned in packages/cognition/tests/spec-051-talk-enum.test.ts.
 *
 * Deterministic throughout — no LLM anywhere (spec 033 AC-14 discipline).
 * AC-1/AC-9 are shared-layer unit pins; AC-7's pre-051 bridge typeof guard is
 * unit-pinned in cognition/engine/shared; AC-10 (live 30-min run) is
 * live-environment-owned and remains open — outside deterministic scope.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  Affordance,
  AgentProfile,
  EngineConfig,
  PerceptionResult,
  ToolDefinition,
} from '@evol-hive/shared';
import { createEngineCore } from '@evol-hive/engine';
import type { EngineCore } from '@evol-hive/engine';
import {
  PerceptionBuilderImpl,
  PerceptionServiceImpl,
  PlanBuilderImpl,
  logTalkEnumDiagnostic,
} from '@evol-hive/cognition';
import type { AffordanceClassifier } from '@evol-hive/cognition';
import { assembleCognitionStack, buildMemorySubsystem } from '@evol-hive/assembly';
import type { CognitionStack } from '@evol-hive/assembly';

const HERE = dirname(fileURLToPath(import.meta.url));
const SPEC_PATH = resolve(HERE, '../../docs/specs/051-enum-bound-talk-targets.md');

const ROOM = 'garden';
const KITCHEN = 'kitchen';
const TALK_TARGET_DESCRIPTION =
  'an agent ID from the enum (agents present right now, not past the unanswered cap)';

/** Display names differ from IDs — the exact spec 046 resolution hazard. */
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

/** alice + bob + carol co-located in the garden; dave alone in the kitchen. */
function spawnWorld(core: EngineCore): void {
  core.agentManager.spawn(makeProfile('agent-alice', 'Alice'));
  core.agentManager.spawn(makeProfile('agent-bob', 'Bob'));
  core.agentManager.spawn(makeProfile('agent-carol', 'Carol'));
  core.agentManager.spawn(makeProfile('agent-dave', 'Dave'));
  core.agentManager.updateState('agent-alice', { location: ROOM });
  core.agentManager.updateState('agent-bob', { location: ROOM });
  core.agentManager.updateState('agent-carol', { location: ROOM });
  core.agentManager.updateState('agent-dave', { location: KITCHEN });
}

// ── 1. Spec-doc integrity ────────────────────────────────────────────────────

describe('spec 051 draft integrity (PR #188)', () => {
  const spec = readFileSync(SPEC_PATH, 'utf8');

  it('exists and targets issue #186 with the enum-bound talk loop title', () => {
    expect(existsSync(SPEC_PATH)).toBe(true);
    expect(spec).toContain('#186');
    expect(spec).toContain('Enum-Bound Conversation Targeting');
  });

  it('defines R1–R5 and acceptance criteria AC-1..AC-10', () => {
    for (const r of ['R1 —', 'R2 —', 'R3 —', 'R4 —', 'R5 —']) {
      expect(spec).toContain(r);
    }
    for (let i = 1; i <= 10; i++) {
      expect(spec).toContain(`**AC-${i}**`);
    }
  });
});

// ── 2–7. Production-stack integration/E2E ────────────────────────────────────

describe('spec 051 production stack — the talk_to value space closes mechanically', () => {
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
    spawnWorld(core);
    // No manual wiring — every wire under test comes from the assembly.
    expect(stack.cognitiveToolExecutor).toBeDefined();
  });

  afterEach(() => {
    delete process.env['USE_REAL_LLM'];
    logSpy.mockRestore();
    vi.restoreAllMocks();
  });

  /** The REAL Perceive phase over the production-assembled provider, plus both builders. */
  async function perceiveWithBuilders(agentId: string): Promise<{
    perception: PerceptionResult;
    perceptionTools: ToolDefinition[];
    planTools: ToolDefinition[];
    perceptionSystemPrompt: string;
  }> {
    const stubClassifier: AffordanceClassifier = {
      prune: async (_driveLabel: string, affordances: Affordance[]) => affordances,
    };
    const service = new PerceptionServiceImpl({
      provider: core.bridges.perception,
      classifier: stubClassifier,
    });
    const perception = await service.perceive(agentId);
    const perceptionPayload = new PerceptionBuilderImpl().build(perception);
    const planPayload = new PlanBuilderImpl().build(perception);
    return {
      perception,
      perceptionTools: perceptionPayload.tools,
      planTools: planPayload.tools,
      perceptionSystemPrompt: perceptionPayload.systemPrompt,
    };
  }

  function toolByName(tools: ToolDefinition[], name: string): ToolDefinition | undefined {
    return tools.find((t) => t.function.name === name);
  }

  /** The shared `ToolDefinition.parameters` is deliberately loose — narrow it for schema pins. */
  interface TalkToParametersShape {
    properties: {
      targetAgentId: { type: string; description?: string; enum?: string[] };
      message: { type: string; description?: string };
      sentiment: { type: string; enum?: string[]; description?: string };
    };
    required: string[];
    additionalProperties: boolean;
  }

  function talkToParams(tools: ToolDefinition[]): TalkToParametersShape | undefined {
    const tool = toolByName(tools, 'talk_to');
    return tool === undefined
      ? undefined
      : (tool.function.parameters as unknown as TalkToParametersShape);
  }

  function talkToTargetEnum(tools: ToolDefinition[]): string[] | undefined {
    return talkToParams(tools)?.properties.targetAgentId.enum;
  }

  it('AC-2: the perceive path renders talk_to enum-bound to the ENGINE enumeration; plan-builder agrees', async () => {
    const { perceptionTools, planTools, perceptionSystemPrompt } =
      await perceiveWithBuilders('agent-alice');

    // The engine is the source of truth — and cognition renders exactly that
    // value space (fresh pair: every present agent is valid).
    const engineValid = stack.socialManager.enumerateTalkTargets('agent-alice');
    expect(engineValid).toEqual(['agent-bob', 'agent-carol']);
    expect(talkToTargetEnum(perceptionTools)).toEqual(engineValid);
    // No free-form target description remains (R1 schema description).
    const talkTo = talkToParams(perceptionTools)!;
    expect(talkTo.properties.targetAgentId.description).toBe(TALK_TARGET_DESCRIPTION);
    // KV-cache (spec 021): the enum lives in the per-cycle tool definition,
    // never in the stable system prompt.
    expect(perceptionSystemPrompt).not.toContain('agent-bob');
    expect(perceptionSystemPrompt).not.toContain('agent-carol');

    // The plan-builder (fed the SAME real PerceptionResult) carries the same
    // per-cycle enum.
    expect(talkToTargetEnum(planTools)).toEqual(engineValid);
  });

  it('AC-3: the cap participates in the production enum — capped bob out, fresh carol in, per-target', async () => {
    // The real additive write path (the engine suite's own capping route):
    // alice has sent 3 unanswered monologues to bob.
    stack.socialManager.updateRelationship('agent-alice', 'agent-bob', { sentCount: 3 });

    // The engine enumeration is per-target: bob out, carol unaffected.
    const engineValid = stack.socialManager.enumerateTalkTargets('agent-alice');
    expect(engineValid).toEqual(['agent-carol']);

    // The perception AND plan enums consume the same cap arithmetic — they
    // agree with the engine (the LLM sees exactly the engine's value space).
    const { perceptionTools, planTools } = await perceiveWithBuilders('agent-alice');
    expect(talkToTargetEnum(perceptionTools)).toEqual(engineValid);
    expect(talkToTargetEnum(planTools)).toEqual(engineValid);
    // Sibling social tools are unaffected (only talk_to is enum-bound).
    const names = perceptionTools.map((t) => t.function.name);
    expect(names).toEqual(expect.arrayContaining(['observe_agent', 'help', 'ignore', 'talk_to']));
  });

  it('AC-4: every present agent capped → talk_to omitted from BOTH tool arrays; siblings render', async () => {
    stack.socialManager.updateRelationship('agent-alice', 'agent-bob', { sentCount: 3 });
    stack.socialManager.updateRelationship('agent-alice', 'agent-carol', { sentCount: 3 });
    expect(stack.socialManager.enumerateTalkTargets('agent-alice')).toEqual([]);

    const { perceptionTools, planTools } = await perceiveWithBuilders('agent-alice');
    const perceptionNames = perceptionTools.map((t) => t.function.name);
    expect(perceptionNames).not.toContain('talk_to');
    expect(perceptionNames).toEqual(expect.arrayContaining(['observe_agent', 'help', 'ignore']));

    const planNames = planTools.map((t) => t.function.name);
    expect(planNames).not.toContain('talk_to');
    expect(planNames).toEqual(expect.arrayContaining(['formulate_plan']));
  });

  it('AC-4: an agent alone in a room → no talk_to, no crash (production perceive path)', async () => {
    const { perceptionTools } = await perceiveWithBuilders('agent-dave');
    expect(perceptionTools.map((t) => t.function.name)).not.toContain('talk_to');
  });

  it('AC-6: the production executor refuses a capped target and writes NOTHING under any key', async () => {
    stack.socialManager.updateRelationship('agent-alice', 'agent-bob', { sentCount: 3 });
    const socialBefore = core.agentManager.getState('agent-alice')!.drives.social;

    const refused = await stack.cognitiveToolExecutor!.executeTalkTo(
      'agent-alice',
      'Bob', // display name — resolves to agent-bob, THEN the exclusion applies
      'still there?',
      'neutral',
    );
    expect(refused.success).toBe(false);
    expect(refused.relationshipUpdated).toBe(false);
    // Req 17 self-correction: the refusal names the target and the policy.
    expect(refused.message).toContain('Bob');
    expect(refused.message).toContain('agent-bob');
    expect(refused.message).toContain('give them space');
    expect(refused.message).toContain('reply');

    // NOTHING is written — no queue message, no conversation, no relationship
    // delta, no reciprocity counter, no +2 monologue drive grant.
    expect(core.conversationManager.listConversationsInRoom(ROOM)).toHaveLength(0);
    expect(stack.socialManager.dequeueSocialMessages('agent-bob')).toHaveLength(0);
    const rel = stack.socialManager.getRelationships('agent-alice')['agent-bob']!;
    expect(rel.sentCount).toBe(3); // the capping write, untouched
    expect(rel.receivedCount ?? 0).toBe(0);
    expect(rel.trust).toBe(50); // no trust delta on the refused send
    expect(rel.familiarity).toBe(0);
    expect(stack.socialManager.getRelationships('agent-alice')['Bob']).toBeUndefined(); // no phantom key
    expect(core.agentManager.getState('agent-alice')!.drives.social).toBe(socialBefore);

    // The engine is the source of truth at CALL time: even the exact-ID path
    // a stale LLM-side enum might have carried is refused.
    const refusedExact = await stack.cognitiveToolExecutor!.executeTalkTo(
      'agent-alice',
      'agent-bob',
      'anyone?',
      'neutral',
    );
    expect(refusedExact.success).toBe(false);
    expect(refusedExact.message).toContain('agent-bob');
    expect(core.conversationManager.listConversationsInRoom(ROOM)).toHaveLength(0);

    // Per-target enforcement: the fresh sibling target is still accepted.
    const ok = await stack.cognitiveToolExecutor!.executeTalkTo(
      'agent-alice',
      'Carol',
      'hi carol',
      'neutral',
    );
    expect(ok.success).toBe(true);
    expect(ok.conversationUpdated).toBe(true);
    expect(core.conversationManager.listConversationsInRoom(ROOM)).toHaveLength(1);
    expect(stack.socialManager.dequeueSocialMessages('agent-carol')).toHaveLength(1);
  });

  it("AC-5: the target's REAL reply re-opens the enum mechanically — no cooldown timer", async () => {
    // Cap bob (3 unanswered), then have bob reply through the REAL executor.
    stack.socialManager.updateRelationship('agent-alice', 'agent-bob', { sentCount: 3 });
    expect(stack.socialManager.enumerateTalkTargets('agent-alice')).toEqual(['agent-carol']);

    const reply = await stack.cognitiveToolExecutor!.executeTalkTo(
      'agent-bob',
      'Alice',
      'hi alice',
      'positive',
    );
    expect(reply.success).toBe(true);
    // The reply raised alice's receivedCount: gap 3 − 1 = 2 < cap.
    expect(stack.socialManager.getRelationships('agent-alice')['agent-bob']!.receivedCount).toBe(1);

    // Next cycle: bob re-enters — engine, perception, and plan all agree.
    const engineValid = stack.socialManager.enumerateTalkTargets('agent-alice');
    expect(engineValid).toEqual(['agent-bob', 'agent-carol']);
    const { perceptionTools, planTools } = await perceiveWithBuilders('agent-alice');
    expect(talkToTargetEnum(perceptionTools)).toEqual(engineValid);
    expect(talkToTargetEnum(planTools)).toEqual(engineValid);

    // And the executor accepts the send again — the SAME thread extends.
    const resend = await stack.cognitiveToolExecutor!.executeTalkTo(
      'agent-alice',
      'Bob',
      'thanks for the reply',
      'neutral',
    );
    expect(resend.success).toBe(true);
    expect(resend.conversationUpdated).toBe(true);
    const conv = stack.socialManager.getOpenConversationBetween('agent-alice', 'agent-bob');
    expect(conv).not.toBeNull();
    expect(conv!.turns.length).toBeGreaterThanOrEqual(2);
    // ONE thread over the REAL IDs — the reply opened it (bob first), the
    // resend joined it; order follows the initiator.
    expect(conv!.participants.map((p) => p.agentId).sort()).toEqual(['agent-alice', 'agent-bob']);
  });

  it('AC-8: the [talk-enum] diagnostic renders the real perceive outcome (fresh, capped, and silent cases)', async () => {
    const talkEnumLines = (): string[] =>
      logSpy.mock.calls
        .map((c) => c.map(String).join(' '))
        .filter((l) => l.includes('[talk-enum]'));

    // Real perception, fresh pair — everything present is valid.
    let { perception } = await perceiveWithBuilders('agent-alice');
    logTalkEnumDiagnostic('agent-alice', perception);
    let lines = talkEnumLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('agent=agent-alice');
    expect(lines[0]).toContain('present=2');
    expect(lines[0]).toContain('valid=2');
    expect(lines[0]).toContain('excluded=[]');

    // Cap bob → the next real perception excludes exactly bob.
    stack.socialManager.updateRelationship('agent-alice', 'agent-bob', { sentCount: 3 });
    ({ perception } = await perceiveWithBuilders('agent-alice'));
    logTalkEnumDiagnostic('agent-alice', perception);
    lines = talkEnumLines();
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('present=2');
    expect(lines[1]).toContain('valid=1');
    expect(lines[1]).toContain('excluded=[agent-bob]');

    // No agents present → no line (nothing to enumerate).
    ({ perception } = await perceiveWithBuilders('agent-dave'));
    logTalkEnumDiagnostic('agent-dave', perception);
    expect(talkEnumLines()).toHaveLength(2);
  });
});
