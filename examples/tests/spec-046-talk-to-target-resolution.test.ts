/**
 * QA coverage for spec 046 — talk_to Target Resolution & Sentiment Passthrough
 * (issue #173, PR #174) — production-stack integration/E2E.
 *
 * Spec 046's PR (#174) is a spec-only draft; this suite is the coverage audit
 * that closes its deterministic ACs against the PRODUCTION-constructed stack
 * (`createEngineCore` + `assembleCognitionStack`, no manual wiring — the exact
 * components live runs use), mirroring the spec 045 QA suite's structure:
 *
 * 1. Spec-doc integrity (active) — the draft is well-formed: R1–R6 and
 *    AC-1..AC-10 present, issue #173 referenced.
 * 2. AC-1 (integration) — `talk_to` with a display-name target ('Bob') through
 *    the PRODUCTION executor yields participants ['agent-alice','agent-bob']
 *    (never a phantom 'Bob'), and the thread SURVIVES the R7 co-location sweep
 *    while both agents remain in the room.
 * 3. AC-2 (E2E) — the target's queueMessage key is the real ID
 *    (`getConversationsAwaitingAgentReply('agent-bob')` returns the thread) and
 *    the target's next RENDERED perception quotes the spec 043 pending-address
 *    line with the actual message; the phantom key gets nothing.
 * 4. AC-3 (E2E) — a reply from the resolved target via display name extends
 *    the SAME thread (turnCount ≥ 2, open → active per spec 033 lifecycle).
 * 5. AC-4 (E2E) — the real target's `receivedCount` increments on their
 *    contribution (spec 044 reciprocity observable with resolved keys).
 * 6. AC-6 (E2E) — the perception payload renders
 *    `Agents present: Bob (agent-bob) (idle)`-style lines (ID included), the
 *    line stays in the stable section above the `---` cache boundary (spec 021
 *    rules), and its structure is unchanged apart from the ID token.
 * 7. AC-8 (integration) — an unresolvable target ('Zed') yields a structured
 *    failure whose message lists the present agents, and NO conversation,
 *    relationship, or queued message is written under any key.
 * 8. AC-10 (regression) — exact-ID targeting (`targetAgentId: 'agent-bob'`)
 *    behaves exactly as before through the production executor.
 *
 * Deterministic throughout — no LLM anywhere (spec 033 AC-14 discipline).
 * The live-run re-validation of spec 045's open ACs is a manual follow-up
 * tracked on issue #173.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Affordance, AgentProfile, EngineConfig } from '@evol-hive/shared';
import { createEngineCore } from '@evol-hive/engine';
import type { EngineCore } from '@evol-hive/engine';
import {
  CognitiveToolExecutorImpl,
  PerceptionBuilderImpl,
  PerceptionServiceImpl,
} from '@evol-hive/cognition';
import type { AffordanceClassifier } from '@evol-hive/cognition';
import { assembleCognitionStack, buildMemorySubsystem } from '@evol-hive/assembly';
import type { CognitionStack } from '@evol-hive/assembly';

const HERE = dirname(fileURLToPath(import.meta.url));
const SPEC_PATH = resolve(
  HERE,
  '../../docs/specs/046-talk-to-target-resolution-sentiment-passthrough.md',
);

const ROOM = 'garden';

/** Display names differ from IDs — the exact spec 046 hazard. */
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

// ── 1. Spec-doc integrity ────────────────────────────────────────────────────

describe('spec 046 draft integrity (PR #174)', () => {
  const spec = readFileSync(SPEC_PATH, 'utf8');

  it('exists and targets issue #173 with the target-resolution title', () => {
    expect(existsSync(SPEC_PATH)).toBe(true);
    expect(spec).toContain('#173');
    expect(spec).toContain('Target Resolution');
    expect(spec).toContain('phantom');
  });

  it('defines R1–R6 and acceptance criteria AC-1..AC-10', () => {
    for (const r of ['R1 —', 'R2 —', 'R3 —', 'R4 —', 'R5 —', 'R6 —']) {
      expect(spec).toContain(r);
    }
    for (let i = 1; i <= 10; i++) {
      expect(spec).toContain(`**AC-${i}**`);
    }
  });
});

// ── 2–5, 7, 8. Production-stack integration/E2E ──────────────────────────────

describe('spec 046 production stack — display-name targeting resolves to real IDs', () => {
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
    // No manual wiring — every wire under test comes from the assembly.
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

  it('AC-1: display-name talk_to through the PRODUCTION executor yields REAL participant IDs and survives the R7 sweep', async () => {
    const result = await stack.cognitiveToolExecutor!.executeTalkTo(
      'agent-alice',
      'Bob', // display name — the spec 046 hazard
      'Hey Bob!',
      'neutral',
    );
    expect(result.success).toBe(true);
    expect(result.conversationUpdated).toBe(true);

    // Exactly ONE thread, participants are the REAL agent IDs.
    const convs = core.conversationManager.listConversationsInRoom(ROOM);
    expect(convs).toHaveLength(1);
    const conv = convs[0]!;
    expect(conv.participants.map((p) => p.agentId)).toEqual(['agent-alice', 'agent-bob']);
    expect(conv.participants.map((p) => p.agentId)).not.toContain('Bob');

    // The thread survives the R7 co-location sweep while both agents remain
    // in the room (the phantom-key thread used to die within one tick).
    core.conversationManager.tick(conv.openedAt + 1);
    const swept = core.conversationManager.getConversation(conv.id);
    expect(swept).not.toBeNull();
    expect(swept!.status).toBe('open');
    expect(swept!.participants.map((p) => p.agentId)).toEqual(['agent-alice', 'agent-bob']);
  });

  it('AC-2: the queue key is the real ID — the target owes a reply and their next perception quotes the message', async () => {
    const result = await stack.cognitiveToolExecutor!.executeTalkTo(
      'agent-alice',
      'Bob',
      'Where do you get good beans?',
      'neutral',
    );
    expect(result.success).toBe(true);

    // The REAL target owes the reply (the phantom key never would have).
    const awaiting = core.bridges.perception.getConversationsAwaitingAgentReply('agent-bob');
    expect(awaiting).toHaveLength(1);
    expect(awaiting[0]!.turns[awaiting[0]!.turns.length - 1]!.content).toBe(
      'Where do you get good beans?',
    );
    // The phantom display name is not a participant — it gets nothing.
    expect(core.bridges.perception.getConversationsAwaitingAgentReply('Bob')).toHaveLength(0);

    // The queued message itself is keyed by the real ID.
    const queued = stack.socialManager.dequeueSocialMessages('agent-bob');
    expect(queued).toHaveLength(1);
    expect(queued[0]!.content).toBe('Where do you get good beans?');
    expect(stack.socialManager.dequeueSocialMessages('Bob')).toHaveLength(0);

    // The target's NEXT perception renders the spec 043 pending-address line
    // (display-name rendering — spec 043; the AC-2 clause is that the line
    // renders at all and quotes the actual message).
    const payloadB = await renderPerception('agent-bob');
    expect(payloadB).toContain(
      'Alice addressed you, awaiting response: "Where do you get good beans?"',
    );
  });

  it('AC-3: a reply from the resolved target via display name extends the SAME thread (open → active)', async () => {
    const first = await stack.cognitiveToolExecutor!.executeTalkTo(
      'agent-alice',
      'Bob',
      'hello there',
      'neutral',
    );
    expect(first.conversationUpdated).toBe(true);
    const convId = core.conversationManager.listConversationsInRoom(ROOM)[0]!.id;

    const reply = await stack.cognitiveToolExecutor!.executeTalkTo(
      'agent-bob',
      'Alice', // display name — resolves to agent-alice
      'hello back',
      'positive',
    );
    expect(reply.success).toBe(true);
    expect(reply.conversationUpdated).toBe(true);

    // SAME thread — not a second phantom-keyed conversation.
    expect(core.conversationManager.listConversationsInRoom(ROOM)).toHaveLength(1);
    const conv = stack.socialManager.getOpenConversationBetween('agent-alice', 'agent-bob');
    expect(conv).not.toBeNull();
    expect(conv!.id).toBe(convId);
    expect(conv!.turns).toHaveLength(2);
    expect(conv!.status).toBe('active'); // spec 033 lifecycle: open → active on the reply
    const a = conv!.participants.find((p) => p.agentId === 'agent-alice');
    const b = conv!.participants.find((p) => p.agentId === 'agent-bob');
    expect(a!.turnCount).toBe(1);
    expect(b!.turnCount).toBe(1);
  });

  it('AC-4: the real target receivedCount increments on their display-name contribution', async () => {
    await stack.cognitiveToolExecutor!.executeTalkTo(
      'agent-alice',
      'Bob',
      'hello there',
      'neutral',
    );
    await stack.cognitiveToolExecutor!.executeTalkTo(
      'agent-bob',
      'Alice',
      'hello back',
      'positive',
    );

    const relB = stack.socialManager.getRelationships('agent-bob')['agent-alice'];
    expect(relB).toBeDefined();
    expect(relB!.receivedCount).toBe(1); // received Alice's opening turn
    expect(relB!.sentCount).toBe(1); // sent the reply
    const relA = stack.socialManager.getRelationships('agent-alice')['agent-bob'];
    expect(relA!.sentCount).toBe(1);
    expect(relA!.receivedCount).toBe(1);
  });

  it('AC-6: the perception payload renders "Bob (agent-bob) (idle)" above the --- cache boundary', async () => {
    const payload = await renderPerception('agent-alice');
    expect(payload).toContain('Agents present: Bob (agent-bob) (idle)');
    // The line stays in the STABLE section (above the `---` boundary, spec 021).
    const lines = payload.split('\n');
    const separator = lines.indexOf('---');
    expect(separator).toBeGreaterThan(0);
    const stable = lines.slice(0, separator).join('\n');
    const dynamic = lines.slice(separator + 1).join('\n');
    expect(stable).toContain('Agents present: Bob (agent-bob) (idle)');
    expect(dynamic).not.toContain('Agents present:');
    // Structure unchanged (R4): the social directive line still follows.
    const agentsLine = lines.findIndex((l) => l.startsWith('Agents present:'));
    expect(lines[agentsLine + 1]).toBe(
      'You can call talk_to, observe_agent, help, or ignore directly to interact with other agents.',
    );
  });

  it('AC-8: an unresolvable target fails loudly, lists the present agents, and writes NOTHING under any key', async () => {
    const result = await stack.cognitiveToolExecutor!.executeTalkTo(
      'agent-alice',
      'Zed',
      'anyone there?',
      'neutral',
    );
    expect(result.success).toBe(false);
    expect(result.relationshipUpdated).toBe(false);
    // Req 17 self-correction: the refusal names the present agents with IDs.
    expect(result.message).toContain('Zed');
    expect(result.message).toContain('Present agents:');
    expect(result.message).toContain('Bob (agent-bob)');

    // NO conversation was created.
    expect(core.conversationManager.listConversationsInRoom(ROOM)).toHaveLength(0);
    // NO relationship entries under ANY key on either side.
    expect(stack.socialManager.getRelationships('agent-alice')['Zed']).toBeUndefined();
    expect(stack.socialManager.getRelationships('agent-alice')['agent-bob']).toBeUndefined();
    expect(stack.socialManager.getRelationships('agent-bob')['Zed']).toBeUndefined();
    // NO queued message under any key.
    expect(stack.socialManager.dequeueSocialMessages('agent-bob')).toHaveLength(0);
    expect(stack.socialManager.dequeueSocialMessages('Zed')).toHaveLength(0);
    // The real target owes nothing.
    expect(core.bridges.perception.getConversationsAwaitingAgentReply('agent-bob')).toHaveLength(0);
  });

  it('AC-10: exact-ID targeting through the production executor behaves exactly as before', async () => {
    const result = await stack.cognitiveToolExecutor!.executeTalkTo(
      'agent-alice',
      'agent-bob', // well-behaved LLM passing the real ID
      'hello there',
      'neutral',
    );
    expect(result.success).toBe(true);
    expect(result.conversationUpdated).toBe(true);
    const convs = core.conversationManager.listConversationsInRoom(ROOM);
    expect(convs).toHaveLength(1);
    expect(convs[0]!.participants.map((p) => p.agentId)).toEqual(['agent-alice', 'agent-bob']);
    // The [social] telemetry line shows the raw (already-real) ID.
    const socialLine = logSpy.mock.calls
      .map((c) => String(c[0]))
      .find((l) => l.includes('[social]'));
    expect(socialLine).toContain('agent-alice talk_to→agent-bob');
  });

  it('the production executor is the spec 046-aware CognitiveToolExecutorImpl wired to the resolving SocialManager', () => {
    expect(stack.cognitiveToolExecutor).toBeInstanceOf(CognitiveToolExecutorImpl);
    expect(stack.socialManager.resolveAgentId('agent-alice', 'Bob')).toBe('agent-bob');
  });
});
