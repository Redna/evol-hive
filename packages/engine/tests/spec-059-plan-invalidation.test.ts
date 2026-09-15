/**
 * Spec 059 — Plan-Retention Re-Validation (issue #210) — engine layer.
 *
 * AC-5 (R3): `PlanManagerImpl.invalidatePlan` stamps the in-flight plan's
 * `lastPlanOutcome` with `superseded: true`, `success: false`, the plan's
 * `stepsCompleted`/`stepsTotal`, and `reflected: false`, then clears
 * `currentPlan`; a subsequent `createPlan` does not stamp a second superseded
 * outcome for the same plan; the `[plan-superseded]` line is emitted once.
 *
 * The `ExecuteDataProviderImpl.invalidatePlan` bridge delegates to the
 * `PlanManager` (R3, engine side).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { AgentPlan, FormulatePlanResult } from '@evol-hive/shared';
import { AgentManagerImpl } from '../src/agents/state/index.js';
import { PlanManagerImpl } from '../src/agents/plans/index.js';
import { SmartObjectRegistryImpl } from '../src/world/objects/index.js';
import { AffordanceRegistryImpl } from '../src/world/affordances/index.js';
import { PhysicsSystemImpl } from '../src/physics/index.js';
import { DriveSystemImpl } from '../src/agents/drives/index.js';
import { SystemFeedbackStore } from '../src/agents/feedback/index.js';
import { ExecuteDataProviderImpl } from '../src/agents/execute/index.js';

const AGENT_ID = 'iris-1';

/** A 3-step in-flight plan: steps 0 and 1 done, currentStepIndex = 2. */
function inFlightPlan(): AgentPlan {
  return {
    id: 'plan_iris-1_150.6_40',
    description: 'Water the greenhouse',
    steps: [
      { description: 'Walk', completed: true, targetAffordance: 'go_to_greenhouse' },
      { description: 'Prepare', completed: true, targetAffordance: 'prepare' },
      { description: 'Water', completed: false, targetAffordance: 'water_plants' },
    ],
    currentStepIndex: 2,
    createdAt: 150.6,
  };
}

function newFormulation(): FormulatePlanResult {
  return {
    description: 'Fresh garden round',
    steps: [{ description: 'Rest', targetAffordance: 'rest' }],
  };
}

describe('PlanManagerImpl.invalidatePlan (spec 059, R3 — AC-5)', () => {
  let agentManager: AgentManagerImpl;
  let planManager: PlanManagerImpl;

  beforeEach(() => {
    agentManager = new AgentManagerImpl();
    planManager = new PlanManagerImpl(agentManager, () => 150.6);
    agentManager.spawn({
      id: AGENT_ID,
      name: 'Iris',
      description: '',
      traits: [],
      initialDrives: { energy: 10 },
    });
    agentManager.updateState(AGENT_ID, { location: 'garden' });
  });

  it('stamps the honest superseded outcome then clears currentPlan', () => {
    agentManager.updateState(AGENT_ID, { currentPlan: inFlightPlan() });

    planManager.invalidatePlan(AGENT_ID);

    const state = agentManager.getState(AGENT_ID);
    expect(state?.lastPlanOutcome).toEqual({
      planDescription: 'Water the greenhouse',
      steps: ['go_to_greenhouse', 'prepare', 'water_plants'],
      success: false,
      superseded: true,
      stepsCompleted: 2,
      stepsTotal: 3,
      reflected: false,
    });
    expect(state?.currentPlan).toBeNull();
  });

  it('a subsequent createPlan does not stamp a second superseded outcome for the same plan', () => {
    agentManager.updateState(AGENT_ID, { currentPlan: inFlightPlan() });

    planManager.invalidatePlan(AGENT_ID);
    const stamped = agentManager.getState(AGENT_ID)?.lastPlanOutcome;

    planManager.createPlan(AGENT_ID, newFormulation());

    const after = agentManager.getState(AGENT_ID);
    expect(after?.lastPlanOutcome).toBe(stamped);
    expect(after?.currentPlan?.description).toBe('Fresh garden round');
  });

  it('emits exactly one [plan-superseded] line per invalidation', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    agentManager.updateState(AGENT_ID, { currentPlan: inFlightPlan() });

    planManager.invalidatePlan(AGENT_ID);
    planManager.createPlan(AGENT_ID, newFormulation());

    const lines = spy.mock.calls
      .map((call) => call.map(String).join(' '))
      .filter((line) => line.includes('[plan-superseded]'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(`agent=${AGENT_ID}`);
    expect(lines[0]).toContain('superseded after 2 of 3 steps');
  });

  it('invalidation with no in-flight plan is a no-op (never fabricates an outcome)', () => {
    planManager.invalidatePlan(AGENT_ID);
    expect(agentManager.getState(AGENT_ID)?.lastPlanOutcome).toBeUndefined();
    expect(agentManager.getState(AGENT_ID)?.currentPlan).toBeNull();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });
});

describe('ExecuteDataProviderImpl.invalidatePlan delegates to the PlanManager (spec 059, R3)', () => {
  it('clears the agent plan and stamps superseded', () => {
    const agentManager = new AgentManagerImpl();
    agentManager.spawn({
      id: AGENT_ID,
      name: 'Iris',
      description: '',
      traits: [],
      initialDrives: { energy: 10 },
    });
    agentManager.updateState(AGENT_ID, {
      location: 'garden',
      currentPlan: inFlightPlan(),
    });

    const planManager = new PlanManagerImpl(agentManager, () => 150.6);
    const smartRegistry = new SmartObjectRegistryImpl();
    const affordanceRegistry = new AffordanceRegistryImpl(smartRegistry);
    const physics = new PhysicsSystemImpl(smartRegistry, affordanceRegistry);
    const bridge = new ExecuteDataProviderImpl({
      agentManager,
      planManager,
      driveSystem: new DriveSystemImpl(agentManager, 0.1),
      smartRegistry,
      affordanceRegistry,
      physics,
      feedbackStore: new SystemFeedbackStore(),
    });

    bridge.invalidatePlan(AGENT_ID);

    expect(agentManager.getState(AGENT_ID)?.currentPlan).toBeNull();
    expect(agentManager.getState(AGENT_ID)?.lastPlanOutcome?.superseded).toBe(true);
  });
});
