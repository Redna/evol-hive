/**
 * Spec 215, item 4 (issue #215) — engine-side legacy `PlanManager` fall-through.
 * ═══════════════════════════════════════════════════════════════════════════
 * Item 4 made `PlanManager.invalidatePlan` optional and wrapped the bridge
 * delegate in `planManager.invalidatePlan?.(agentId)` so a legacy/lightweight
 * manager stays assignable instead of failing the typecheck that motivated the
 * issue (`RecordingPlanManager` latent TS2420).
 *
 * The compile-checked guard `PlanManagerInvalidating` covers the *production*
 * implementation (it must still provide the method). What no test covered is
 * the runtime contract of the optionality itself: a real
 * `ExecuteDataProviderImpl` constructed with a manager that does **not**
 * implement `invalidatePlan` must treat invalidation as a no-op — clear
 * nothing, stamp nothing, never throw. That is the engine-layer twin of spec
 * 059 AC-6 ("with `invalidatePlan` unwired ... falls through to R4"), which is
 * only pinned for an unwired *provider*, not a wired provider with a legacy
 * manager.
 *
 * The second test is the runtime mirror of the item-4 compile gate: the
 * production `PlanManagerImpl` still exposes `invalidatePlan` as a function.
 * (The compile gate is stronger — this only catches removal at test time — but
 * it documents the guarded capability next to its fall-through contract.)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { AgentPlan, FormulatePlanResult, PlanStep } from '@evol-hive/shared';
import { AgentManagerImpl } from '../src/agents/state/index.js';
import { PlanManagerImpl } from '../src/agents/plans/index.js';
import type { PlanManager } from '../src/agents/index.js';
import { SmartObjectRegistryImpl } from '../src/world/objects/index.js';
import { AffordanceRegistryImpl } from '../src/world/affordances/index.js';
import { PhysicsSystemImpl } from '../src/physics/index.js';
import { DriveSystemImpl } from '../src/agents/drives/index.js';
import { SystemFeedbackStore } from '../src/agents/feedback/index.js';
import { ExecuteDataProviderImpl } from '../src/agents/execute/index.js';

const AGENT_ID = 'iris-1';

/** An in-flight 2-step plan, step 0 done. */
function inFlightPlan(): AgentPlan {
  return {
    id: 'plan_iris-1_150.6_40',
    description: 'Water the greenhouse',
    steps: [
      { description: 'Walk', completed: true, targetAffordance: 'go_to_greenhouse' },
      { description: 'Water', completed: false, targetAffordance: 'water_plants' },
    ],
    currentStepIndex: 1,
    createdAt: 150.6,
  };
}

/**
 * A legacy `PlanManager` that predates spec 059 — every original method, and
 * deliberately no `invalidatePlan`. Assignable because the method is optional
 * (issue #215, item 4); the bridge must fall through, not call/throw.
 */
class LegacyPlanManager implements PlanManager {
  calls: string[] = [];

  createPlan(_agentId: string, _result: FormulatePlanResult): AgentPlan {
    throw new Error('createPlan not exercised by this test');
  }
  advanceStep(_agentId: string): void {
    this.calls.push('advanceStep');
  }
  getCurrentStep(_agentId: string): PlanStep | null {
    this.calls.push('getCurrentStep');
    return null;
  }
  isComplete(_agentId: string): boolean {
    this.calls.push('isComplete');
    return false;
  }
  clearPlan(_agentId: string): void {
    this.calls.push('clearPlan');
  }
}

function buildBridge(
  agentManager: AgentManagerImpl,
  planManager: PlanManager,
): ExecuteDataProviderImpl {
  const smartRegistry = new SmartObjectRegistryImpl();
  const affordanceRegistry = new AffordanceRegistryImpl(smartRegistry);
  const physics = new PhysicsSystemImpl(smartRegistry, affordanceRegistry);
  return new ExecuteDataProviderImpl({
    agentManager,
    planManager,
    driveSystem: new DriveSystemImpl(agentManager, 0.1),
    smartRegistry,
    affordanceRegistry,
    physics,
    feedbackStore: new SystemFeedbackStore(),
  });
}

describe('spec 215 item 4: legacy PlanManager is a no-op through the real Execute bridge', () => {
  let agentManager: AgentManagerImpl;

  beforeEach(() => {
    agentManager = new AgentManagerImpl();
    agentManager.spawn({
      id: AGENT_ID,
      name: 'Iris',
      description: '',
      traits: [],
      initialDrives: { energy: 10 },
    });
    agentManager.updateState(AGENT_ID, { location: 'garden' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('a manager without invalidatePlan: the bridge clears nothing, stamps nothing, never throws', () => {
    const legacy = new LegacyPlanManager();
    // Guard the test's own premise: the capability is genuinely absent.
    expect('invalidatePlan' in legacy).toBe(false);

    agentManager.updateState(AGENT_ID, { currentPlan: inFlightPlan() });
    const bridge = buildBridge(agentManager, legacy);

    // The delegate is present on the bridge (spec 059 R3) but must no-op.
    expect(() => bridge.invalidatePlan(AGENT_ID)).not.toThrow();

    const state = agentManager.getState(AGENT_ID);
    // Plan retained → cognition falls through to the R4 step-skip net.
    expect(state?.currentPlan).toEqual(inFlightPlan());
    expect(state?.lastPlanOutcome).toBeUndefined();
    // No legacy method was invented or called to compensate.
    expect(legacy.calls).toEqual([]);
  });

  it('the production PlanManagerImpl still provides invalidatePlan (runtime mirror of the compile gate)', () => {
    // The compile-checked guard `PlanManagerInvalidating` is the real gate;
    // this catches an accidental removal at test time as well.
    expect(typeof PlanManagerImpl.prototype.invalidatePlan).toBe('function');

    agentManager.updateState(AGENT_ID, { currentPlan: inFlightPlan() });
    const bridge = buildBridge(agentManager, new PlanManagerImpl(agentManager, () => 150.6));

    bridge.invalidatePlan(AGENT_ID);

    const state = agentManager.getState(AGENT_ID);
    expect(state?.currentPlan).toBeNull();
    expect(state?.lastPlanOutcome).toMatchObject({
      superseded: true,
      stepsCompleted: 1,
      stepsTotal: 2,
    });
  });
});
