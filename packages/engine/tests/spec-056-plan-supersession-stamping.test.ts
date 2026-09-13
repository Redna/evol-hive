/**
 * Spec 056 — Plan supersession stamping (issue #201)
 * ────────────────────────────────────────────────────────────────────────────
 * Plans are replaced every cycle by the dominant batch plan path before
 * completing, so the spec-055 Reflect-phase stamp (`stampPlanOutcome`) almost
 * never fires and the plan prompt renders no last-plan lines. The fix stamps
 * the outcome at the moment the plan is REPLACED (PlanManagerImpl.createPlan).
 *
 * - AC-1 (Req 1): an in-flight 3-step plan (currentStepIndex = 1) replaced by
 *   a new createPlan stamps lastPlanOutcome { planDescription, steps (the
 *   rendered identities: targetAffordance when bound, else description),
 *   success: false, superseded: true, stepsCompleted: 1, stepsTotal: 3,
 *   reflected: false }.
 * - AC-2 (Req 1): a 0-completed-step replacement still stamps
 *   (stepsCompleted === 0); the new plan's state is exactly the new
 *   formulation; a throwing stamp write never prevents plan creation.
 * - AC-3 (Req 1+6): replacing a COMPLETE plan (currentStepIndex >=
 *   steps.length) does NOT stamp superseded — the existing lastPlanOutcome
 *   (or undefined) survives untouched (the Reflect stamp owns that outcome).
 * - AC-6 (Req 4): plan ids use the injected clock
 *   (plan_${agentId}_${fakeTime}_${counter}) — no Date.now() reference
 *   remains in PlanManagerImpl.
 * - AC-7 (Req 5): a superseding createPlan emits exactly one
 *   [plan-superseded] stderr line (agent id, N of M, truncated description);
 *   a first-plan creation emits none.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentInternalState, AgentPlan, FormulatePlanResult } from '@evol-hive/shared';
import { AgentManagerImpl } from '../src/agents/state/index.js';
import { PlanManagerImpl } from '../src/agents/plans/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const readSource = (rel: string): string => readFileSync(join(__dirname, '..', 'src', rel), 'utf8');

const AGENT_ID = 'a1';

function makeAgentState(overrides: Partial<AgentInternalState> = {}): AgentInternalState {
  return {
    agentId: AGENT_ID,
    drives: { energy: 10, hunger: 50, social: 80, comfort: 60, curiosity: 40 },
    currentGoal: 'stay alive',
    currentPlan: null,
    isThinking: false,
    location: 'kitchen',
    lastPerceptionTick: 0,
    ...overrides,
  };
}

/** A 3-step plan abandoned mid-flight: step 0 executed, currentStepIndex = 1. */
function inFlightPlan(): AgentPlan {
  return {
    id: 'plan_a1_old_0',
    description: 'Morning greenhouse round',
    steps: [
      {
        description: 'Walk to the greenhouse',
        targetAffordance: 'go_to_greenhouse',
        completed: true,
      },
      { description: 'water the plants carefully', completed: false },
      {
        description: 'Repot the seedlings',
        targetAffordance: 'repot_seedlings',
        completed: false,
      },
    ],
    currentStepIndex: 1,
    createdAt: 5,
  };
}

/** The NEXT cycle's formulation that replaces the abandoned plan. */
function newFormulation(): FormulatePlanResult {
  return {
    description: 'Afternoon herb trade',
    steps: [
      { description: 'Go to the market', targetAffordance: 'go_to_market' },
      { description: 'Trade herbs' },
    ],
  };
}

describe('PlanManagerImpl supersession (spec 056 — issue #201)', () => {
  let agentManager: AgentManagerImpl;
  let planManager: PlanManagerImpl;

  beforeEach(() => {
    agentManager = new AgentManagerImpl();
    planManager = new PlanManagerImpl(agentManager, () => 100);
    agentManager.spawn({
      id: AGENT_ID,
      name: 'Test Agent',
      description: '',
      traits: [],
      initialDrives: { energy: 10 },
    });
  });

  describe('supersession stamp on plan replacement (AC-1, Req 1)', () => {
    it('stamps the old plan as superseded before the new plan replaces it', () => {
      agentManager.updateState(AGENT_ID, { currentPlan: inFlightPlan() });

      const newPlan = planManager.createPlan(AGENT_ID, newFormulation());

      const state = agentManager.getState(AGENT_ID);
      expect(state?.lastPlanOutcome).toEqual({
        planDescription: 'Morning greenhouse round',
        // Rendered identities in plan order: targetAffordance when bound,
        // else the description (same rendering stampPlanOutcome uses).
        steps: ['go_to_greenhouse', 'water the plants carefully', 'repot_seedlings'],
        success: false,
        superseded: true,
        stepsCompleted: 1,
        stepsTotal: 3,
        reflected: false,
      });
      // The new plan is still produced.
      expect(newPlan.description).toBe('Afternoon herb trade');
      expect(state?.currentPlan?.description).toBe('Afternoon herb trade');
    });
  });

  describe('zero-progress replacement and stamping robustness (AC-2, Req 1)', () => {
    it('stamps a 0-completed-step replacement; the new plan state is exactly the new formulation', () => {
      const untouched = inFlightPlan();
      untouched.steps[0]!.completed = false;
      untouched.currentStepIndex = 0;
      agentManager.updateState(AGENT_ID, { currentPlan: untouched });

      const newPlan = planManager.createPlan(AGENT_ID, newFormulation());

      const state = agentManager.getState(AGENT_ID);
      expect(state?.lastPlanOutcome?.stepsCompleted).toBe(0);
      expect(state?.lastPlanOutcome?.stepsTotal).toBe(3);
      expect(state?.lastPlanOutcome?.superseded).toBe(true);
      expect(state?.currentPlan?.id).toBe(newPlan.id);
      expect(state?.currentPlan?.steps).toEqual(newPlan.steps);
      expect(state?.currentPlan?.currentStepIndex).toBe(0);
      expect(state?.currentPlan?.description).toBe('Afternoon herb trade');
    });

    it('a deliberately-throwing state write does not prevent plan creation', () => {
      agentManager.updateState(AGENT_ID, { currentPlan: inFlightPlan() });
      const original = agentManager.updateState.bind(agentManager);
      vi.spyOn(agentManager, 'updateState').mockImplementation((id, updates) => {
        if ('lastPlanOutcome' in updates) throw new Error('stamp write failed');
        original(id, updates);
      });

      expect(() => planManager.createPlan(AGENT_ID, newFormulation())).not.toThrow();

      const state = agentManager.getState(AGENT_ID);
      expect(state?.currentPlan?.description).toBe('Afternoon herb trade');
      expect(state?.currentPlan?.currentStepIndex).toBe(0);
      expect(state?.currentPlan?.steps).toHaveLength(2);
    });
  });

  describe('complete plans are not stamped superseded (AC-3, Req 1+6)', () => {
    it('replacing a complete plan leaves lastPlanOutcome undefined', () => {
      const complete = inFlightPlan();
      complete.currentStepIndex = 3; // >= steps.length — the plan completed
      agentManager.updateState(AGENT_ID, { currentPlan: complete });

      planManager.createPlan(AGENT_ID, newFormulation());

      expect(agentManager.getState(AGENT_ID)?.lastPlanOutcome).toBeUndefined();
    });

    it('replacing a complete plan keeps a previously stamped outcome untouched', () => {
      const complete = inFlightPlan();
      complete.currentStepIndex = 3;
      const realOutcome = {
        planDescription: 'Morning greenhouse round',
        steps: ['go_to_greenhouse'],
        success: true,
        reflected: true,
      };
      agentManager.updateState(AGENT_ID, {
        currentPlan: complete,
        lastPlanOutcome: realOutcome,
      });

      planManager.createPlan(AGENT_ID, newFormulation());

      expect(agentManager.getState(AGENT_ID)?.lastPlanOutcome).toEqual(realOutcome);
    });
  });

  describe('plan ids use the injected clock (AC-6, Req 4)', () => {
    it('builds ids as plan_${agentId}_${fakeTime}_${counter}', () => {
      const fixed = new PlanManagerImpl(agentManager, () => 12345);

      const p1 = fixed.createPlan(AGENT_ID, newFormulation());
      const p2 = fixed.createPlan(AGENT_ID, newFormulation());

      const counterOf = (id: string): number => Number(id.split('_')[3]);
      expect(p1.id).toMatch(/^plan_a1_12345_\d+$/);
      expect(p2.id).toMatch(/^plan_a1_12345_\d+$/);
      expect(counterOf(p2.id)).toBe(counterOf(p1.id) + 1);
      expect(p1.createdAt).toBe(12345);
    });

    it('no Date.now() reference remains in PlanManagerImpl', () => {
      expect(readSource('agents/plans/index.ts')).not.toContain('Date.now');
    });
  });

  describe('[plan-superseded] diagnostic (AC-7, Req 5)', () => {
    function supersededLines(): string[] {
      return vi
        .mocked(console.error)
        .mock.calls.map((call) => call.map(String).join(' '))
        .filter((line) => line.includes('[plan-superseded]'));
    }

    beforeEach(() => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('emits exactly one line with agent id, N of M, and the description', () => {
      agentManager.updateState(AGENT_ID, { currentPlan: inFlightPlan() });

      planManager.createPlan(AGENT_ID, newFormulation());

      const lines = supersededLines();
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain(`agent=${AGENT_ID}`);
      expect(lines[0]).toContain('superseded after 1 of 3 steps');
      expect(lines[0]).toContain('"Morning greenhouse round"');
    });

    it('truncates the description to 40 characters', () => {
      const long = inFlightPlan();
      long.description = 'x'.repeat(80);
      agentManager.updateState(AGENT_ID, { currentPlan: long });

      planManager.createPlan(AGENT_ID, newFormulation());

      const lines = supersededLines();
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain(`"${'x'.repeat(40)}"`);
      expect(lines[0]).not.toContain('x'.repeat(41));
    });

    it('a first-plan creation (no prior plan) emits none', () => {
      planManager.createPlan(AGENT_ID, newFormulation());

      expect(supersededLines()).toHaveLength(0);
    });
  });
});

export {};
