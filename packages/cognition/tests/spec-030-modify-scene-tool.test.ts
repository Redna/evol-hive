/**
 * Tests for the modify_scene cognitive tool & guardrails (spec 030, #117).
 *
 * Covers:
 * - AC-5 (tool side): modify_scene proposals are enqueued to the
 *   SceneMutationService via the SceneMutationPort bridge; on rejection the
 *   actionable validation error is returned as tool feedback.
 * - AC-9: guardrails — modify_scene is masked/treated exactly like other
 *   cognitive tools by affordance masking; per-cycle rate limiting with
 *   GuardrailConfig.maxSceneMutationsPerCycle honored; movement through closed
 *   doors is rejected by plan validation (§10 mechanism 3) and unblocked
 *   movement passes.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type {
  AgentInternalState,
  AgentPlan,
  ExecuteDataProvider,
  SceneMutationEvent,
  SceneMutationProposal,
  SceneMutationResult,
  SmartObject,
} from '@evol-hive/shared';
import { defaultCognitiveTools, CognitiveToolExecutorImpl } from '../src/tools/index.js';
import type { CognitiveToolExecutorOptions } from '../src/tools/cognitive-tool-executor.js';
import { GuardrailEngineImpl } from '../src/guardrails/index.js';
import { ExecuteServiceImpl } from '../src/pper/execute-service.js';
import type { TopologyGuard } from '@evol-hive/shared';

// ── Tool registration (Req 13) ───────────────────────────────────────────────

describe('modify_scene tool registration (spec 030, Req 13)', () => {
  it('is registered in the default cognitive tool catalog with a strict op enum schema', () => {
    const tool = defaultCognitiveTools.find((t) => t.name === 'modify_scene');
    expect(tool).toBeDefined();
    const opSchema = tool!.argsSchema['properties'] as Record<string, unknown>;
    expect(opSchema).toHaveProperty('op');
    const op = opSchema['op'] as { enum?: string[] };
    expect(op.enum).toEqual([
      'add_object',
      'remove_object',
      'move_object',
      'spawn_agent',
      'despawn_agent',
      'set_connection_state',
    ]);
  });
});

// ── Tool execution through the mutation port (Req 13) ───────────────────────

describe('modify_scene execution via SceneMutationPort (spec 030, AC-5 / Req 13)', () => {
  let proposals: SceneMutationProposal[];
  let results: Map<number, SceneMutationResult>;
  let executor: CognitiveToolExecutorImpl;
  let options: CognitiveToolExecutorOptions;

  const crate: SmartObject = {
    id: 'crate-1',
    name: 'Crate',
    type: 'furniture',
    state: {},
    affordances: [],
    roomId: 'room_a',
  };

  beforeEach(() => {
    proposals = [];
    results = new Map();
    const port = {
      propose(mutation: SceneMutationProposal): SceneMutationResult {
        proposals.push(mutation);
        return results.get(proposals.length) ?? { accepted: true, seq: proposals.length };
      },
      getMutations(): SceneMutationEvent[] {
        return [];
      },
    };
    options = { mutationPort: port };
    executor = new CognitiveToolExecutorImpl(options);
  });

  it('enqueues a proposal with source "llm" and reports acceptance', async () => {
    const result = await executor.executeModifyScene!('agent-1', {
      op: 'add_object',
      object: crate,
    });
    expect(result.success).toBe(true);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.type).toBe('add_object');
    expect(proposals[0]!.source).toBe('llm');
  });

  it('returns the actionable validation error as tool feedback on rejection', async () => {
    results.set(1, {
      accepted: false,
      error: "Cannot remove object 'ghost-1': no object with ID 'ghost-1' exists.",
    });
    const result = await executor.executeModifyScene!('agent-1', {
      op: 'remove_object',
      objectId: 'ghost-1',
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('ghost-1');
  });

  it('maps set_connection_state args to the connection payload', async () => {
    await executor.executeModifyScene!('agent-1', {
      op: 'set_connection_state',
      roomA: 'room_a',
      roomB: 'room_b',
      action: 'close',
    });
    expect(proposals[0]!.type).toBe('set_connection_state');
    expect(proposals[0]!.payload).toEqual({
      roomA: 'room_a',
      roomB: 'room_b',
      action: 'close',
    });
  });
});

// ── Guardrails (Req 14 / AC-9) ───────────────────────────────────────────────

describe('modify_scene guardrails (spec 030, AC-9 / Req 14)', () => {
  function makePort(): { propose: ReturnType<typeof vi.fn> } & { getMutations: () => [] } {
    return {
      propose: vi.fn(() => ({ accepted: true, seq: 1 }) as SceneMutationResult),
      getMutations: () => [],
    };
  }

  it('rate limits proposals to 1 per agent per PPER cycle by default', async () => {
    const port = makePort();
    const executor = new CognitiveToolExecutorImpl({ mutationPort: port });
    const args = { op: 'remove_object', objectId: 'crate-1' };

    const first = await executor.executeModifyScene!('a1', args);
    expect(first.success).toBe(true);
    const second = await executor.executeModifyScene!('a1', args);
    expect(second.success).toBe(false);
    expect(second.error).toMatch(/rate limit|per cycle/i);

    // A different agent still has its own budget.
    const other = await executor.executeModifyScene!('a2', args);
    expect(other.success).toBe(true);
  });

  it('resets the budget at cycle start via resetSceneMutationBudget', async () => {
    const port = makePort();
    const executor = new CognitiveToolExecutorImpl({ mutationPort: port });
    const args = { op: 'remove_object', objectId: 'crate-1' };

    expect((await executor.executeModifyScene!('a1', args)).success).toBe(true);
    expect((await executor.executeModifyScene!('a1', args)).success).toBe(false);

    executor.resetSceneMutationBudget('a1');
    expect((await executor.executeModifyScene!('a1', args)).success).toBe(true);
  });

  it('honors GuardrailConfig.maxSceneMutationsPerCycle when wired through', async () => {
    const guardrail = new GuardrailEngineImpl({
      affordanceMasking: false,
      contextualForcing: false,
      planValidation: false,
      maxSceneMutationsPerCycle: 3,
    });
    const port = makePort();
    const executor = new CognitiveToolExecutorImpl({
      mutationPort: port,
      maxSceneMutationsPerCycle: guardrail.config.maxSceneMutationsPerCycle,
    });
    const args = { op: 'remove_object', objectId: 'crate-1' };

    expect((await executor.executeModifyScene!('a1', args)).success).toBe(true);
    expect((await executor.executeModifyScene!('a1', args)).success).toBe(true);
    expect((await executor.executeModifyScene!('a1', args)).success).toBe(true);
    const fourth = await executor.executeModifyScene!('a1', args);
    expect(fourth.success).toBe(false);
    expect(fourth.error).toMatch(/rate limit|per cycle/i);
  });

  it('modify_scene is treated like other cognitive tools by plan validation (masking parity)', () => {
    const guardrail = new GuardrailEngineImpl({
      affordanceMasking: true,
      contextualForcing: true,
      planValidation: true,
    });
    // Cognitive tool names are always valid actions, exactly like
    // formulate_plan / query_memory / update_internal_state.
    expect(guardrail.validateAction('modify_scene', null).valid).toBe(true);
  });
});

// ── Topology-aware plan validation (Req 10 / AC-4) ──────────────────────────

describe('plan validation rejects movement through closed doors (spec 030, AC-4 / Req 10)', () => {
  const plan: AgentPlan = {
    id: 'p1',
    description: 'go to the lab',
    steps: [{ description: 'walk to lab', completed: false, targetAffordance: 'go_to_lab' }],
    currentStepIndex: 0,
    createdAt: 0,
  };

  const blockedGuard: TopologyGuard = {
    isMovementBlocked(_agentId: string, action: string, fromRoom: string): boolean {
      return action === 'go_to_lab' && fromRoom === 'office';
    },
  };

  it('rejects a blocked movement step with an actionable reason and reflection feedback', () => {
    const guardrail = new GuardrailEngineImpl(
      { affordanceMasking: true, contextualForcing: true, planValidation: true },
      blockedGuard,
    );
    const validation = guardrail.validateAction('go_to_lab', plan, {
      agentId: 'a1',
      fromRoom: 'office',
    });
    expect(validation.valid).toBe(false);
    expect(validation.reason).toContain('go_to_lab');
    expect(validation.reason).toContain('office');
  });

  it('allows the same movement when the door is open (guard reports unblocked)', () => {
    const openGuard: TopologyGuard = { isMovementBlocked: () => false };
    const guardrail = new GuardrailEngineImpl(
      { affordanceMasking: true, contextualForcing: true, planValidation: true },
      openGuard,
    );
    expect(guardrail.validateAction('go_to_lab', plan, { agentId: 'a1', fromRoom: 'office' }).valid).toBe(
      true,
    );
  });

  it('ExecuteServiceImpl surfaces the rejection as a deviation (reflection tick trigger)', async () => {
    const guardrail = new GuardrailEngineImpl(
      { affordanceMasking: true, contextualForcing: true, planValidation: true },
      blockedGuard,
    );

    const state: AgentInternalState = {
      agentId: 'a1',
      drives: { energy: 50, hunger: 50, social: 50, comfort: 50, curiosity: 50 },
      currentGoal: 'go to lab',
      currentPlan: plan,
      isThinking: true,
      location: 'office',
      lastPerceptionTick: 0,
    };
    const feedbacks: string[] = [];
    const provider: ExecuteDataProvider = {
      getAgentState: () => state,
      getCurrentStep: () => plan.steps[0]!,
      isPlanComplete: () => false,
      resolveAffordance: () => null,
      checkPreconditions: () => ({ satisfied: true, failed: [] }),
      executeAffordance: () => Promise.resolve({ success: true }),
      advanceStep: () => undefined,
      applyDriveChanges: () => undefined,
      setSystemFeedback: (_agentId: string, feedback: string) => {
        feedbacks.push(feedback);
      },
      setThinking: (_agentId: string, isThinking: boolean) => {
        state.isThinking = isThinking;
      },
    };

    const service = new ExecuteServiceImpl({ dataProvider: provider, guardrail });
    const result = await service.execute('a1');
    expect(result.deviationRejected).toBe(true);
    expect(result.success).toBe(false);
    expect(feedbacks).toHaveLength(1);
    expect(state.isThinking).toBe(false);
  });
});