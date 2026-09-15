/**
 * Spec 058 — Eligibility-Bound Plan Affordances (cognition side, issue #206)
 * ═══════════════════════════════════════════════════════════════════════
 * R3 — the drive→affordance matcher and the rendered hints consume the same
 *      eligibility-filtered affordance set (no ineligible conversation
 *      affordance enters a hint).
 * R4 — one zero-LLM `[plan-enum]` line per plan formulation at the
 *      perceive→plan seam, carrying agent, room, the offered enum ids, and
 *      the chosen step targets.
 *
 * Deterministic throughout — no network.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  Affordance,
  AgentInternalState,
  ExecuteDataProvider,
  PerceptionDataProvider,
  PerceptionResult,
  PlanDataProvider,
  ReflectDataProvider,
} from '@evol-hive/shared';
import type { AffordanceClassifier, LLMClient } from '../src/index.js';
import { PlanBuilderImpl } from '../src/pper/plan-builder.js';
import { matchDrivesToAffordances } from '../src/pper/drive-affordance-matcher.js';
import { logPlanEnumDiagnostic } from '../src/pper/plan-enum-diagnostic.js';
import { PPEROrchestratorImpl } from '../src/pper/orchestrator.js';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const AGENT_ID = 'iris-1';
const ROOM_ID = 'greenhouse';
const CONVERSATION_IDS = ['join', 'contribute', 'leave', 'observe'];

function makeAffordance(id: string, effects: Record<string, number> = {}): Affordance {
  return { id, label: id, engineEffect: id, preconditions: [], effects };
}

function makePerception(overrides: Partial<PerceptionResult> = {}): PerceptionResult {
  return {
    passive: {
      roomId: ROOM_ID,
      objectsPresent: [],
      drives: { energy: 20, hunger: 50, social: 10, comfort: 50, curiosity: 50 },
    },
    prunedAffordances: [makeAffordance('rest_among_seedlings', { energy: 12 })],
    primaryDriveLabel: 'low energy, need to restore energy',
    ...overrides,
  };
}

// ── AC-5 (R3) — matcher/hints consume the filtered set ───────────────────────

describe('spec 058 AC-5 — drive/chain hints never reference ineligible conversation affordances', () => {
  it('matchDrivesToAffordances over the filtered set returns no join/contribute/leave', () => {
    const filtered = [makeAffordance('rest_among_seedlings', { energy: 12 }), makeAffordance('sit')];
    const matches = matchDrivesToAffordances({ energy: 20, social: 5 }, filtered);
    const referenced = matches.flatMap((m) => [
      ...m.affordances.map((a) => a.affordanceId),
      ...(m.chainProgress ?? []).map((a) => a.affordanceId),
    ]);
    for (const id of ['join', 'contribute', 'leave', 'observe']) {
      expect(referenced).not.toContain(id);
    }
    expect(referenced).toContain('rest_among_seedlings');
  });

  it('conversation affordances are never surfaced even if they declare a social effect (social is excluded)', () => {
    const unfiltered = [
      makeAffordance('join', { social: 20 }),
      makeAffordance('contribute', { social: 20 }),
      makeAffordance('rest_among_seedlings', { energy: 12 }),
    ];
    const matches = matchDrivesToAffordances({ energy: 20, social: 5 }, unfiltered);
    const referenced = matches.flatMap((m) => m.affordances.map((a) => a.affordanceId));
    for (const id of ['join', 'contribute', 'leave', 'observe']) {
      expect(referenced).not.toContain(id);
    }
  });

  it('the plan builder renders no ineligible conversation affordance from the filtered pruned set', () => {
    const payload = new PlanBuilderImpl().build(makePerception());
    expect(payload.perceptionContext).toContain('rest_among_seedlings');
    for (const id of ['join', 'contribute', 'leave']) {
      expect(payload.perceptionContext).not.toContain(id);
    }
  });
});

// ── AC-6 (R4) — the [plan-enum] diagnostic ───────────────────────────────────

describe('spec 058 AC-6 — [plan-enum] formulation diagnostic', () => {
  function captureLogs(): { logs: string[]; spy: ReturnType<typeof vi.spyOn> } {
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });
    return { logs, spy };
  }

  it('renders agent, room, the offered enum ids, and the chosen targetAffordance values', () => {
    const { logs, spy } = captureLogs();
    try {
      logPlanEnumDiagnostic(AGENT_ID, makePerception(), {
        id: 'plan-1',
        description: 'rest',
        steps: [
          { description: 'rest', targetAffordance: 'rest_among_seedlings', completed: false },
          { description: 'wait', targetAffordance: 'wait', completed: false },
        ],
        currentStepIndex: 0,
        createdAt: 0,
      });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(logs[0]).toBe(
        `[plan-enum] agent=${AGENT_ID} room=${ROOM_ID} ` +
          'enum=[rest_among_seedlings] chosen=[rest_among_seedlings,wait]',
      );
    } finally {
      spy.mockRestore();
    }
  });

  it('renders chosen=[none] when the plan phase made no choice', () => {
    const { logs, spy } = captureLogs();
    try {
      logPlanEnumDiagnostic(AGENT_ID, makePerception(), undefined);
      expect(logs[0]).toContain('chosen=[none]');
    } finally {
      spy.mockRestore();
    }
  });

  it('renders enum=[] when the eligible set is empty', () => {
    const { logs, spy } = captureLogs();
    try {
      logPlanEnumDiagnostic(
        AGENT_ID,
        makePerception({ prunedAffordances: [] }),
        {
          id: 'plan-1',
          description: 'wait',
          steps: [{ description: 'wait', targetAffordance: 'wait', completed: false }],
          currentStepIndex: 0,
          createdAt: 0,
        },
      );
      expect(logs[0]).toContain('enum=[]');
    } finally {
      spy.mockRestore();
    }
  });

  it('the orchestrator emits exactly one [plan-enum] line per formulation', async () => {
    const { logs, spy } = captureLogs();
    try {
      const orch = makeOrchestrator();
      await orch.runCycle(AGENT_ID);
      const planEnum = logs.filter((l) => l.includes('[plan-enum]'));
      expect(planEnum).toHaveLength(1);
      expect(planEnum[0]).toContain(`agent=${AGENT_ID}`);
      expect(planEnum[0]).toContain(`room=${ROOM_ID}`);
      expect(planEnum[0]).toContain('chosen=[rest_among_seedlings]');
    } finally {
      spy.mockRestore();
    }
  });

  it('a thrown diagnostic never propagates out of the cycle', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      if (String(args[0]).includes('[plan-enum]')) throw new Error('log exploded');
    });
    try {
      const orch = makeOrchestrator();
      await expect(orch.runCycle(AGENT_ID)).resolves.toBeDefined();
    } finally {
      spy.mockRestore();
    }
  });

  it('the orchestrator wires the [plan-enum] diagnostic at the plan seam (wiring pin)', () => {
    const source = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), '../src/pper/orchestrator.ts'),
      'utf8',
    );
    expect(source).toContain('logPlanEnumDiagnostic');
  });
});

// ── Orchestrator fixtures (mirroring the spec 052 pattern) ───────────────────

function makeState(agentId: string): AgentInternalState {
  return {
    agentId,
    drives: { energy: 20, hunger: 50, social: 50, comfort: 50, curiosity: 50 },
    currentGoal: '',
    currentPlan: null,
    isThinking: false,
    location: ROOM_ID,
    lastPerceptionTick: 0,
  };
}

function makePerceptionProvider(state: AgentInternalState): PerceptionDataProvider {
  return {
    getAgentLocation: () => ROOM_ID,
    getObjectsInRoom: () => [],
    getAffordancesInRoom: () => [makeAffordance('rest_among_seedlings', { energy: 12 })],
    getAgentDrives: () => state.drives,
    getPrimaryDriveLabel: () => 'low energy, need to restore energy',
    getSystemFeedback: () => undefined,
    getAgentState: () => state,
  };
}

function makePlanProvider(state: AgentInternalState): PlanDataProvider {
  return {
    getAgentState: () => state,
    storePlan: (_id, result) => ({
      id: 'plan-1',
      description: result.description,
      steps: result.steps.map((s) => ({
        description: s.description,
        completed: false,
        ...(s.targetAffordance !== undefined ? { targetAffordance: s.targetAffordance } : {}),
      })),
      currentStepIndex: 0,
      createdAt: 0,
    }),
    setThinking: () => {},
  };
}

function makeExecuteProvider(state: AgentInternalState): ExecuteDataProvider {
  return {
    getAgentState: () => state,
    getCurrentStep: () => undefined,
    isPlanComplete: () => true,
    resolveAffordance: () => null,
    checkPreconditions: () => ({ satisfied: true, failed: [] }),
    executeAffordance: async () => ({ success: true }),
    advanceStep: () => {},
    applyDriveChanges: () => {},
    setSystemFeedback: () => {},
    setThinking: () => {},
  };
}

function makeReflectProvider(state: AgentInternalState): ReflectDataProvider {
  return {
    getAgentState: () => state,
    applyDriveChanges: () => {},
    updateGoal: () => {},
    storeMemory: async () => {},
    clearPlanIfComplete: () => true,
    setThinking: () => {},
  };
}

function makeClassifier(): AffordanceClassifier {
  return { prune: async (_drive, affordances) => affordances };
}

function makeLLM(): LLMClient {
  return {
    async completeStructured() {
      return { reasoning: 'r', action: 'idle' };
    },
    async completeReflection() {
      return { agentId: AGENT_ID, newMemories: [], consolidatedNodeIds: [] };
    },
    async completePlan() {
      return {
        description: 'rest',
        steps: [{ description: 'rest', targetAffordance: 'rest_among_seedlings' }],
      };
    },
    async completeReflect() {
      return { memoryEntry: { content: 'x', importance: 5, type: 'action' } };
    },
  };
}

function makeOrchestrator(): PPEROrchestratorImpl {
  const state = makeState(AGENT_ID);
  return new PPEROrchestratorImpl({
    perceptionProvider: makePerceptionProvider(state),
    planProvider: makePlanProvider(state),
    executeProvider: makeExecuteProvider(state),
    reflectProvider: makeReflectProvider(state),
    classifier: makeClassifier(),
    llmClient: makeLLM(),
  });
}
