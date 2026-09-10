/**
 * QA coverage for spec 045 — Assembly Conversation Wiring (issue #165, PR #171)
 * ────────────────────────────────────────────────────────────────────────────
 * Spec 045 is a spec-only draft: it documents the verified root cause that
 * `examples/assembly.ts` constructs `CognitiveToolExecutorImpl` with a
 * `socialBridge` but NO `conversationBridge`, and never calls
 * `social.setConversationManager(core.conversationManager)` on the sim's
 * SocialManager — so every spec 033/043/044 conversation capability is dormant
 * in live runs while component QA suites pass (they wire the bridge inside the
 * tests; the production assembly omits the wire).
 *
 * This suite is the QA audit of PR #171, split into:
 *
 * 1. Spec-doc integrity (active) — the draft is well-formed and its
 *    acceptance criteria / requirements are all present.
 * 2. AC-6 static invariants (active) — the grep assertion the spec defines:
 *    at most one `new SocialManager` path in `assembleCognitionStack`, zero
 *    `new ConversationManagerImpl` constructions, no duplicated
 *    perception-provider wiring. True today and must stay true after the fix.
 * 3. Scaffolding the fix leans on (active) — the spec 033/043/044 machinery
 *    exists, is exposed on `EngineCore`, and `createEngineCore` already wires
 *    its own `core.socialManager` (the exact precondition the fix assumes).
 * 4. Conversation machinery through the examples assembly (active) — the full
 *    chain (executor → core.conversationManager → sim SocialManager delegate →
 *    perception query) exercised with the spec 045 wiring applied MANUALLY.
 *    These tests document the post-fix contract and stay green after the fix
 *    lands (the manual wiring line is exactly what the fix adds).
 * 5. Production wiring (active) — the assembly-level assertions that only
 *    became true once the fix PR wired `conversationBridge` and the
 *    SocialManager delegate in `examples/assembly.ts` itself: talk_to through
 *    the PRODUCTION-constructed `stack.cognitiveToolExecutor` opens a real
 *    conversation in the core's manager with no manual wiring (R1 + instance
 *    identity), and the sim's SocialManager carries the conversation delegate
 *    with no manual wiring (R2).
 * 6. Live-run evidence (it.todo) — the real-LLM / events.jsonl clauses of
 *    AC-1/AC-3/AC-4 are manual live-run evidence (tracked on issue #165); the
 *    deterministic proxies for those clauses are the section-4 machinery tests
 *    plus the section-5 production-wiring tests.
 *
 * Deterministic throughout — no LLM anywhere (spec 033 AC-14). The live-run
 * evidence clauses of AC-1/AC-2/AC-3/AC-4 (real LLM, events.jsonl) are
 * tracked as todo scaffolds.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentProfile, EngineConfig } from '@evol-hive/shared';
import { createEngineCore } from '@evol-hive/engine';
import type { EngineCore } from '@evol-hive/engine';
import { SocialManager } from '@evol-hive/engine';
import { CognitiveToolExecutorImpl } from '@evol-hive/cognition';
import { assembleCognitionStack, buildMemorySubsystem } from '../assembly.ts';
import type { CognitionStack } from '../assembly.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const SPEC_PATH = resolve(HERE, '../../docs/specs/045-assembly-conversation-wiring.md');
const ASSEMBLY_PATH = resolve(HERE, '../assembly.ts');

const ROOM = 'garden';

function makeProfile(id: string): AgentProfile {
  return { id, name: id, description: `agent ${id}`, traits: [], initialDrives: {} };
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
  core.agentManager.spawn(makeProfile('agent-a'));
  core.agentManager.spawn(makeProfile('agent-b'));
  core.agentManager.updateState('agent-a', { location: room });
  core.agentManager.updateState('agent-b', { location: room });
}

// ── 1. Spec-doc integrity ────────────────────────────────────────────────────

describe('spec 045 draft integrity (PR #171)', () => {
  const spec = readFileSync(SPEC_PATH, 'utf8');

  it('exists and targets issue #165 with the assembly-wiring title', () => {
    expect(existsSync(SPEC_PATH)).toBe(true);
    expect(spec).toContain('examples/assembly.ts');
    expect(spec).toContain('#165');
    expect(spec).toContain('Assembly Conversation Wiring');
  });

  it('defines R1–R4 and acceptance criteria AC-1..AC-6', () => {
    for (const r of ['R1 —', 'R2 —', 'R3 —', 'R4 —']) {
      expect(spec).toContain(r);
    }
    for (let i = 1; i <= 6; i++) {
      expect(spec).toContain(`**AC-${i}**`);
    }
  });

  it('links the related specs 033/043/044, and those spec files exist', () => {
    for (const n of [
      '033-conversations-identity-evolution',
      '043-conversation-perception-bridge',
      '044-social-urge-model',
    ]) {
      expect(spec).toContain(n);
      expect(existsSync(resolve(HERE, '../../docs/specs', `${n}.md`))).toBe(true);
    }
  });

  it('scopes the change to examples/assembly.ts only (package-boundary constraint)', () => {
    expect(spec).toContain('`examples/assembly.ts` only');
    expect(spec).toContain('Do not modify `shared`, `engine`, `cognition`, or `memory`');
  });
});

// ── 2. AC-6 static invariants (grep assertion) ───────────────────────────────

describe('AC-6 (R3) — examples assembly static invariants', () => {
  const source = readFileSync(ASSEMBLY_PATH, 'utf8');

  it('constructs at most one SocialManager path and never a ConversationManagerImpl', () => {
    // The `socialManager ?? new SocialManager(...)` fallback is the one path;
    // the accepted alternative (reuse core.socialManager as socialBridge)
    // would legitimately reduce this to zero — both satisfy R2's
    // "exactly one instance holds both roles" invariant.
    const socialCount = (source.match(/new SocialManager/g) ?? []).length;
    expect(socialCount).toBeLessThanOrEqual(1);
    expect((source.match(/new ConversationManagerImpl/g) ?? []).length).toBe(0);
  });

  it('does not duplicate perception-provider wiring (inherited from createEngineCore)', () => {
    // The perception provider's setConversationManager/setTickSource come from
    // createEngineCore (engine assembly, spec 043/044). The examples assembly
    // must never re-wire them — and must never create a second
    // ConversationManagerImpl. The legit spec 019 wiring (setSocialManager)
    // stays exactly once.
    expect(source).not.toMatch(/perception\.setConversationManager/);
    expect(source).not.toMatch(/perception\.setTickSource/);
    expect((source.match(/bridges\.perception\.setSocialManager/g) ?? []).length).toBe(1);
  });

  it('wires the spec 045 bridges (R1: conversationBridge into the executor; R2: SocialManager delegate)', () => {
    // R1 — the executor receives the core's conversation manager (spec 033
    // openOrContribute path). R2 — the sim's SocialManager (the socialBridge
    // instance) delegates conversation queries to the SAME core manager.
    expect(source).toContain('conversationBridge: core.conversationManager');
    expect(source).toContain('social.setConversationManager(core.conversationManager)');
  });
});

// ── 3. Scaffolding the fix leans on ──────────────────────────────────────────

describe('scaffolding: spec 033/043/044 machinery exposed for the fix', () => {
  beforeEach(() => {
    delete process.env['USE_REAL_LLM'];
    delete process.env['USE_REAL_EMBEDDINGS'];
  });

  it('CognitiveToolExecutorImpl accepts the conversationBridge option (spec 033 port)', async () => {
    const memory = buildMemorySubsystem();
    const core = createEngineCore(makeEngineConfig(), memory.memoryStore, memory.vectorStore);
    spawnCoLocatedPair(core);
    const executor = new CognitiveToolExecutorImpl({
      socialBridge: new SocialManager(core.agentManager),
      conversationBridge: core.conversationManager,
      currentTick: 11,
    });
    const result = await executor.executeTalkTo('agent-a', 'agent-b', 'hi', 'neutral');
    expect(result.success).toBe(true);
    expect(result.conversationUpdated).toBe(true);
    expect(core.conversationManager.listConversationsInRoom(ROOM)).toHaveLength(1);
  });

  it('createEngineCore pre-wires core.socialManager to core.conversationManager (engine assembly)', () => {
    const memory = buildMemorySubsystem();
    const core = createEngineCore(makeEngineConfig(), memory.memoryStore, memory.vectorStore);
    spawnCoLocatedPair(core);
    const result = core.conversationManager.openOrContribute(
      'agent-a',
      'agent-b',
      'hi',
      'neutral',
      11,
    );
    expect(result.success).toBe(true);
    expect(core.socialManager.getConversationsAwaitingAgentReply('agent-b')).toHaveLength(1);
  });

  it('a SocialManager without the delegate reports nothing; wiring the delegate flips it (R2 contract)', () => {
    const memory = buildMemorySubsystem();
    const core = createEngineCore(makeEngineConfig(), memory.memoryStore, memory.vectorStore);
    spawnCoLocatedPair(core);
    const bare = new SocialManager(core.agentManager);
    core.conversationManager.openOrContribute('agent-a', 'agent-b', 'hi', 'neutral', 11);
    // Dormant — the exact live-run symptom from spec 045's root-cause audit.
    expect(bare.getConversationsAwaitingAgentReply('agent-b')).toHaveLength(0);
    // R2's fix line: one call on the sim's SocialManager flips the chain on.
    bare.setConversationManager(core.conversationManager);
    expect(bare.getConversationsAwaitingAgentReply('agent-b')).toHaveLength(1);
  });
});

// ── 4. Conversation machinery through the examples assembly ─────────────────
//
// `assembleCognitionStack` builds the executor ONLY under USE_REAL_LLM=true —
// and (the spec 045 root cause) WITHOUT a conversationBridge. These tests
// assemble the real examples stack, then apply spec 045's two missing wires
// MANUALLY: R1 (`conversationBridge: core.conversationManager` in the
// executor's constructor) and R2 (`social.setConversationManager(core
// .conversationManager)` on the sim's SocialManager). Every other piece is
// production-assembled (core, stack.socialManager as socialBridge, core
// bridges) — the tested components are real, only the wires are supplied, the
// same way existing component QA suites wire the bridge. The assertions
// document the post-fix contract and stay green after the fix lands.

describe('conversation machinery via assembleCognitionStack (manual R2 wiring = post-fix contract)', () => {
  let core: EngineCore;
  let stack: CognitionStack;
  let executor: CognitiveToolExecutorImpl;

  beforeEach(() => {
    delete process.env['USE_REAL_EMBEDDINGS'];
    process.env['USE_REAL_LLM'] = 'true'; // the executor is only constructed on the real-LLM path
    const memory = buildMemorySubsystem();
    core = createEngineCore(makeEngineConfig(), memory.memoryStore, memory.vectorStore);
    stack = assembleCognitionStack(core, undefined, { memory, wireMemoryMaintenance: false });
    spawnCoLocatedPair(core);

    // The production executor exists on this path but (spec 045 root cause)
    // carries no conversationBridge — asserting its absence here would flip
    // once the fix lands, so that stays a code-review/implementation concern.
    expect(stack.cognitiveToolExecutor).toBeDefined();

    // Spec 045 R1 — the exact constructor argument the implementation PR must
    // add in examples/assembly.ts: the same core.conversationManager instance.
    // Spec 045 R2 — the exact line the implementation PR must add: the sim's
    // SocialManager (= the socialBridge instance) also carries the delegate.
    stack.socialManager.setConversationManager(core.conversationManager);
    executor = new CognitiveToolExecutorImpl({
      stateDataProvider: core.bridges.reflect,
      socialBridge: stack.socialManager,
      mutationPort: core.mutationService,
      conversationBridge: core.conversationManager,
      maxSceneMutationsPerCycle: 1,
    });
  });

  afterEach(() => {
    delete process.env['USE_REAL_LLM'];
    vi.restoreAllMocks();
  });

  it('AC-1 machinery: talk_to opens a real conversation with sentiment-gated deltas (not legacy +2/+5)', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const before = core.socialManager.getRelationships('agent-a')['agent-b'];
    const result = await executor.executeTalkTo(
      'agent-a',
      'agent-b',
      'ugh, not this again',
      'negative',
    );
    expect(result.success).toBe(true);
    expect(result.conversationUpdated).toBe(true);
    // A real conversation object exists in the core's manager (count > 0).
    const convs = core.conversationManager.listConversationsInRoom(ROOM);
    expect(convs).toHaveLength(1);
    // R6: a negative exchange builds NO trust — a +0 trust delta (vs the legacy
    // blind +2) plus a minimal +1 familiarity bump. New relationship records
    // are created lazily on first update with the engine base (trust 50, fam 0).
    const relA = core.socialManager.getRelationships('agent-a')['agent-b'];
    expect(relA).toBeDefined();
    const baseTrust = before?.trust ?? 50;
    const baseFamiliarity = before?.familiarity ?? 0;
    expect(relA!.trust - baseTrust).toBe(0);
    expect(relA!.familiarity - baseFamiliarity).toBe(1);
    // AC-1's telemetry clause: the [social] line shows the non-legacy values.
    const socialLine = logSpy.mock.calls
      .map((c) => String(c[0]))
      .find((l) => l.includes('[social]'));
    expect(socialLine).toBeDefined();
    expect(socialLine).toContain('trust=+0');
    expect(socialLine).toContain('familiarity=+1');
  });

  it('AC-3 machinery: a reply extends the same thread — turns accumulate, status open → active', async () => {
    const first = await executor.executeTalkTo('agent-a', 'agent-b', 'hello there', 'neutral');
    expect(first.conversationUpdated).toBe(true);
    const convId = core.conversationManager.listConversationsInRoom(ROOM)[0]!.id;

    const reply = await executor.executeTalkTo('agent-b', 'agent-a', 'hello back', 'positive');
    expect(reply.conversationUpdated).toBe(true);

    const conv = stack.socialManager.getOpenConversationBetween('agent-a', 'agent-b');
    expect(conv).not.toBeNull();
    expect(conv!.id).toBe(convId); // same thread, not a second conversation
    expect(conv!.turns).toHaveLength(2);
    expect(conv!.status).toBe('active'); // spec 033 lifecycle: open → active on the reply
    const a = conv!.participants.find((p) => p.agentId === 'agent-a');
    const b = conv!.participants.find((p) => p.agentId === 'agent-b');
    expect(a!.turnCount).toBe(1);
    expect(b!.turnCount).toBe(1);
    // The pending-address marker alternates with the last turn (spec 044
    // Decision 4): B replied last → B no longer owes, and now A owes B.
    expect(core.bridges.perception.getConversationsAwaitingAgentReply('agent-b')).toHaveLength(0);
    const awaitingA = core.bridges.perception.getConversationsAwaitingAgentReply('agent-a');
    expect(awaitingA).toHaveLength(1);
    expect(awaitingA[0]!.turns[awaitingA[0]!.turns.length - 1]!.agentId).toBe('agent-b');
  });

  it('AC-2 machinery: the assembled perception provider reports the pending-address source line', async () => {
    await executor.executeTalkTo('agent-a', 'agent-b', 'hello there', 'neutral');
    // A made the last turn → B owes the reply. The delegate query through the
    // examples-assembled perception provider (spec 043's pending-address data
    // line) no longer returns [].
    const awaiting = core.bridges.perception.getConversationsAwaitingAgentReply('agent-b');
    expect(awaiting).toHaveLength(1);
    expect(awaiting[0]!.turns[awaiting[0]!.turns.length - 1]!.agentId).toBe('agent-a');
    expect(awaiting[0]!.turns[awaiting[0]!.turns.length - 1]!.content).toBe('hello there');
    // The speaker does not owe a reply to themselves.
    expect(core.bridges.perception.getConversationsAwaitingAgentReply('agent-a')).toHaveLength(0);
  });

  it('AC-4 machinery: reciprocity counters count real replies through the assembled stack', async () => {
    await executor.executeTalkTo('agent-a', 'agent-b', 'hello there', 'neutral');
    await executor.executeTalkTo('agent-b', 'agent-a', 'hello back', 'positive');
    // a's ledger toward b: one sent (a's turn), one received (b's reply).
    const relA = core.socialManager.getRelationships('agent-a')['agent-b'];
    expect(relA!.sentCount).toBe(1);
    expect(relA!.receivedCount).toBe(1);
    // b's ledger toward a: mirror image — exactly once per exchange.
    const relB = core.socialManager.getRelationships('agent-b')['agent-a'];
    expect(relB!.receivedCount).toBe(1);
    expect(relB!.sentCount).toBe(1);
  });
});

// ── 5. Production wiring (the fix PR's assertions) ──────────────────────
//
// The PRODUCTION-constructed executor (`stack.cognitiveToolExecutor`) and the
// sim's SocialManager, with NO manual wiring anywhere in the test — every wire
// under test comes from `assembleCognitionStack` itself. These are the
// assembly-level assertions that were it.todo scaffolds in the QA audit of the
// spec-only PR and became true when the fix wired R1/R2 in
// examples/assembly.ts.

describe('spec 045 production wiring — assembled stack needs no manual wiring', () => {
  let core: EngineCore;
  let stack: CognitionStack;

  beforeEach(() => {
    delete process.env['USE_REAL_EMBEDDINGS'];
    process.env['USE_REAL_LLM'] = 'true'; // the executor is only constructed on the real-LLM path
    const memory = buildMemorySubsystem();
    core = createEngineCore(makeEngineConfig(), memory.memoryStore, memory.vectorStore);
    stack = assembleCognitionStack(core, undefined, { memory, wireMemoryMaintenance: false });
    spawnCoLocatedPair(core);
    // No manual wiring here — that is the point. R1/R2 must come from the
    // assembly itself.
    expect(stack.cognitiveToolExecutor).toBeDefined();
  });

  afterEach(() => {
    delete process.env['USE_REAL_LLM'];
  });

  it(
    'AC-1 (R1): CognitiveToolExecutorImpl is constructed with conversationBridge === core.conversationManager ' +
      '(instance identity — no second manager) and talk_to via the assembled executor needs no manual wiring',
    async () => {
      const result = await stack.cognitiveToolExecutor!.executeTalkTo(
        'agent-a',
        'agent-b',
        'hello there',
        'neutral',
      );
      expect(result.success).toBe(true);
      // R1: the conversation path ran — a real thread was opened (this is
      // false when the executor carries no conversationBridge, the spec 045
      // root cause).
      expect(result.conversationUpdated).toBe(true);
      // Instance identity: the thread exists in the CORE's conversation
      // manager (the exact instance createEngineCore built) — a second
      // manager would leave this empty.
      const convs = core.conversationManager.listConversationsInRoom(ROOM);
      expect(convs).toHaveLength(1);
      expect(convs[0]!.turns[0]!.content).toBe('hello there');
      // The sim's SocialManager sees the same single thread (same graph of
      // state — no forked manager).
      const viaSocial = stack.socialManager.getOpenConversationBetween('agent-a', 'agent-b');
      expect(viaSocial).not.toBeNull();
      expect(viaSocial!.id).toBe(convs[0]!.id);
    },
  );

  it(
    'AC-2 (R2): stack.socialManager carries the conversation delegate WITHOUT manual wiring — ' +
      'assembleCognitionStack calls social.setConversationManager(core.conversationManager) on the socialBridge instance',
    () => {
      core.conversationManager.openOrContribute('agent-a', 'agent-b', 'hello there', 'neutral', 11);
      // The delegate query through the sim's SocialManager works (spec 045
      // root cause: this returned [] before the fix).
      expect(stack.socialManager.getConversationsAwaitingAgentReply('agent-b')).toHaveLength(1);
      // …and through the perception bridge, which consumes the SAME
      // socialBridge instance (spec 043's pending-address line source).
      const awaiting = core.bridges.perception.getConversationsAwaitingAgentReply('agent-b');
      expect(awaiting).toHaveLength(1);
      expect(awaiting[0]!.turns[awaiting[0]!.turns.length - 1]!.agentId).toBe('agent-a');
      expect(awaiting[0]!.turns[awaiting[0]!.turns.length - 1]!.content).toBe('hello there');
      // The speaker does not owe a reply to themselves.
      expect(core.bridges.perception.getConversationsAwaitingAgentReply('agent-a')).toHaveLength(0);
    },
  );
});

// ── 6. Live-run evidence (it.todo — manual real-LLM run, tracked on #165) ────
// The deterministic proxies for these clauses are the section-4 machinery
// tests and the section-5 production-wiring tests; the live artifacts (real
// LLM telemetry across a whole run, events.jsonl) require a live sim run and
// stay tracked here.

describe('spec 045 live-run evidence (todo — requires a real-LLM live run)', () => {
  it.todo(
    'AC-1 (R1): live-run evidence — [social] telemetry lines show non-legacy deltas on every talk_to ' +
      '(real-LLM run; deterministic proxy covered by the AC-1 machinery + production-wiring tests above)',
  );
  it.todo(
    'AC-3 (R1): live-run evidence — the exchange is visible in events.jsonl (live artifact; ' +
      'lifecycle/turn-count covered by spec-033 manager suites + the AC-3 machinery test)',
  );
  it.todo(
    'AC-4 (R2): live-run evidence — receivedCount increments observable in live events (spec 044 R2; ' +
      'exactly-once counters covered by spec-044 suites + the AC-4 machinery test)',
  );
});

// ── AC-5 note ────────────────────────────────────────────────────────────────
// AC-5 (full suite green; spec 044 exactly-once counter tests and spec 033
// lifecycle/bridge tests pass unmodified) is verified by running `pnpm test`
// — this file runs inside that suite. The exactly-once suites are
// packages/cognition/tests/spec-044-social-urge.test.ts and
// packages/engine/tests/spec-044-social-urge.test.ts; lifecycle/bridge suites
// are packages/engine/tests/spec-033-*.test.ts and
// packages/cognition/tests/spec-033-talk-to-conversations.test.ts.
