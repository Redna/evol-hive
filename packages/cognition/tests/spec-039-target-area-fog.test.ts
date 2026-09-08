/**
 * Spec 039 — Spatial Phase 2: `targetArea` LLM intents, cell-level fog,
 * social fog-lifting, determinism & QA (issue #144).
 *
 * Phase 2 of spec 038: plan steps gain an enum-bound `targetArea` (known
 * areas only), Execute navigates before executing on arrival, perception is
 * fog-filtered at the provider choke point, unexplored-but-known areas
 * render as unknown markers, and plan validation accepts area-bound steps.
 *
 * AC coverage (engine-side integration lives in the engine package tests):
 * - AC-1 (R1/R2): targetArea schema binding + navigation-then-execution in
 *   the Execute service; same-cell targetAffordance-only steps unchanged
 * - AC-3 (R4): unexplored-but-known areas render as unknown markers, never
 *   as full perception of the unknown side
 * - AC-7 (R1): targetArea enum values are limited to the agent's known
 *   areas at schema-build time
 * - AC-8: spec-037 targetAffordance-only plans keep working (no regression)
 */

import { describe, it, expect, vi } from 'vitest';
import type {
  Affordance,
  AffordanceResult,
  FormulatePlanResult,
  PerceptionResult,
  ExecuteResult,
  ExecuteDataProvider,
  PlanStep,
} from '@evol-hive/shared';
import { formulatePlanSchemaFor, formulatePlanToolFor, WAIT_AFFORDANCE } from '@evol-hive/shared';
import { PlanBuilderImpl } from '../src/pper/plan-builder.js';
import { checkPlanBinding } from '../src/pper/plan-service.js';
import { ExecuteServiceImpl } from '../src/pper/execute-service.js';
import type { NavigationStepStatus } from '../src/index.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const prunedAffordances: Affordance[] = [
  {
    id: 'water_plants',
    label: 'Water the plants',
    engineEffect: 'water_plants',
    preconditions: [],
    effects: { comfort: 5 },
  },
];

const KNOWN_AREAS = ['garden', 'workshop', 'planter-1'];

function makePerception(overrides?: Partial<PerceptionResult>): PerceptionResult {
  return {
    passive: {
      roomId: 'garden',
      objectsPresent: [{ objectId: 'planter-1', name: 'Planter', type: 'nature' }],
      drives: { energy: 50, hunger: 50, social: 50, comfort: 40, curiosity: 60 },
    },
    prunedAffordances,
    primaryDriveLabel: 'low comfort',
    knownAreas: KNOWN_AREAS,
    unexploredAreas: ['workshop'],
    ...overrides,
  } as PerceptionResult;
}

// ─── AC-7 / R1 — targetArea enum bound at schema-build time ─────────────────

describe('formulatePlanSchemaFor with knownAreas (spec 039, AC-7)', () => {
  it('adds an enum-bound optional targetArea to plan steps', () => {
    const schema = formulatePlanSchemaFor(['water_plants'], KNOWN_AREAS);
    const step = (
      schema as unknown as {
        properties: { steps: { items: { properties: Record<string, unknown> } } };
      }
    ).properties.steps.items;
    const targetArea = step.properties.targetArea as { enum: string[] } | undefined;
    expect(targetArea).toBeDefined();
    // Known areas ONLY — an unvisited room or unobserved object never appears.
    expect(targetArea!.enum).toEqual(KNOWN_AREAS);
    // Optional — a same-cell step carries no targetArea.
    expect(
      (
        schema as unknown as {
          properties: { steps: { items: { required: string[] } } };
        }
      ).properties.steps.items.required,
    ).toEqual(['description']);
  });

  it('stays byte-compatible with spec 037 when knownAreas is absent', () => {
    const legacy = formulatePlanSchemaFor(['water_plants']);
    const step = (
      legacy as unknown as {
        properties: { steps: { items: { properties: Record<string, unknown> } } };
      }
    ).properties.steps.items;
    expect(step.properties.targetArea).toBeUndefined();
  });

  it('omits targetArea when the agent knows no areas (empty value space)', () => {
    const schema = formulatePlanSchemaFor(['water_plants'], []);
    const step = (
      schema as unknown as {
        properties: { steps: { items: { properties: Record<string, unknown> } } };
      }
    ).properties.steps.items;
    expect(step.properties.targetArea).toBeUndefined();
  });

  it('the plan tool definition carries the targetArea enum', () => {
    const tool = formulatePlanToolFor(['water_plants'], KNOWN_AREAS);
    expect(tool.function.name).toBe('formulate_plan');
    const schema = tool.function.parameters as unknown as {
      properties: { steps: { items: { properties: { targetArea: { enum: string[] } } } } };
    };
    expect(schema.properties.steps.items.properties.targetArea.enum).toEqual(KNOWN_AREAS);
  });
});

// ─── AC-1 / R1 — plan validation accepts area-bound steps ───────────────────

describe('checkPlanBinding with knownAreas (spec 039, AC-1)', () => {
  const ids = ['water_plants'];

  it('accepts a step bound only by targetArea (navigation-only step)', () => {
    const plan: FormulatePlanResult = {
      description: 'Go to the workshop',
      steps: [{ description: 'Walk to the workshop', targetArea: 'workshop' }],
    };
    const v = checkPlanBinding(plan, ids, KNOWN_AREAS);
    expect(v.valid).toBe(true);
    expect(v.bound).toBe(1);
  });

  it('accepts a cross-room step whose targetAffordance lives at the destination', () => {
    const plan: FormulatePlanResult = {
      description: 'Craft at the workbench',
      steps: [
        {
          description: 'Go to the workshop and craft',
          targetArea: 'workshop',
          targetAffordance: 'craft',
        },
      ],
    };
    // 'craft' is not in the CURRENT room's affordance enum — the step binds
    // via targetArea; the affordance resolves on arrival.
    const v = checkPlanBinding(plan, ids, KNOWN_AREAS);
    expect(v.valid).toBe(true);
  });

  it('rejects an unknown targetArea (fog — the agent cannot emit unseen areas)', () => {
    const plan: FormulatePlanResult = {
      description: 'Teleport',
      steps: [{ description: 'Go to the cellar', targetArea: 'cellar' }],
    };
    const v = checkPlanBinding(plan, ids, KNOWN_AREAS);
    expect(v.valid).toBe(false);
    expect(v.violations[0]).toContain("'cellar'");
  });

  it('keeps spec-037 behavior when knownAreas is undefined (no regression)', () => {
    const narrative: FormulatePlanResult = {
      description: 'Narrative plan',
      steps: [{ description: 'Think about plants' }],
    };
    expect(checkPlanBinding(narrative, ids).valid).toBe(false);

    const bound: FormulatePlanResult = {
      description: 'Water',
      steps: [{ description: 'Water', targetAffordance: 'water_plants' }],
    };
    expect(checkPlanBinding(bound, ids).valid).toBe(true);
  });

  it('keeps the wait escape working alongside area steps', () => {
    const plan: FormulatePlanResult = {
      description: 'Mixed',
      steps: [
        { description: 'Idle', targetAffordance: WAIT_AFFORDANCE },
        { description: 'Go to the garden', targetArea: 'garden' },
      ],
    };
    const v = checkPlanBinding(plan, ids, KNOWN_AREAS);
    expect(v.valid).toBe(true);
    expect(v.bound).toBe(2);
  });
});

// ─── AC-3 / R4 — unknown markers + known-map in the dynamic context ─────────

describe('PlanBuilderImpl fog context (spec 039, AC-3)', () => {
  it('renders unexplored-but-known areas as unknown markers, never as perception', () => {
    const payload = new PlanBuilderImpl().build(makePerception());
    const ctx = payload.perceptionContext;
    // Unknown marker for the known-but-unexplored room.
    expect(ctx).toContain("a door to 'workshop' — unexplored");
    // The unknown side is NOT perceived: no workshop objects/affordances.
    expect(ctx).not.toContain('workbench');
    expect(ctx).not.toContain('craft');
  });

  it('renders the known-map summary in the dynamic section (KV-cache safe)', () => {
    const payload = new PlanBuilderImpl().build(makePerception());
    const ctx = payload.perceptionContext;
    const [stable, dynamic] = ctx.split('\n---\n');
    expect(stable).toBeDefined();
    expect(dynamic).toBeDefined();
    // Known areas live in the DYNAMIC section only (spec 021 stable prefix
    // must stay byte-identical).
    expect(dynamic).toContain('Known areas');
    expect(dynamic).toContain('garden');
    expect(stable).not.toContain('Known areas');
  });

  it('emits no markers when the agent has no unexplored areas', () => {
    const payload = new PlanBuilderImpl().build(makePerception({ unexploredAreas: undefined }));
    expect(payload.perceptionContext).not.toContain('unexplored');
  });

  it('the plan tool carries the targetArea enum when known areas exist', () => {
    const payload = new PlanBuilderImpl().build(makePerception());
    const planTool = payload.tools.find((t) => t.function.name === 'formulate_plan');
    expect(planTool).toBeDefined();
    const schema = planTool!.function.parameters as unknown as {
      properties: { steps: { items: { properties: { targetArea?: { enum: string[] } } } } };
    };
    expect(schema.properties.steps.items.properties.targetArea?.enum).toEqual(KNOWN_AREAS);
  });

  it('backward compat: no knownAreas → no targetArea in the plan schema', () => {
    const payload = new PlanBuilderImpl().build(
      makePerception({ knownAreas: undefined, unexploredAreas: undefined }),
    );
    const planTool = payload.tools.find((t) => t.function.name === 'formulate_plan');
    const schema = planTool!.function.parameters as unknown as {
      properties: { steps: { items: { properties: Record<string, unknown> } } };
    };
    expect(schema.properties.steps.items.properties.targetArea).toBeUndefined();
  });
});

// ─── AC-1 / R2 — navigation-then-execution in the Execute service ───────────

/** Scripted navigation statuses, in call order ('unavailable' = no port). */
type NavScript = NavigationStepStatus[];

/** Fake ExecuteDataProvider with a scripted navigation port. */
class FakeExecuteProvider implements ExecuteDataProvider {
  agentState: {
    agentId: string;
    drives: Record<string, number>;
    currentGoal: string;
    currentPlan: import('@evol-hive/shared').AgentPlan;
    isThinking: boolean;
    location: string;
    lastPerceptionTick: number;
  };
  feedback: string | undefined;
  executed: { objectId: string; affordanceId: string; agentId: string }[] = [];
  advanced = 0;
  navigationCalls: { agentId: string; targetArea: string }[] = [];
  private navScript: NavScriptMode;

  constructor(navScript: NavScriptMode) {
    this.navScript = navScript;
    this.agentState = {
      agentId: 'a1',
      drives: { energy: 50, hunger: 50, social: 50, comfort: 40, curiosity: 60 },
      currentGoal: '',
      currentPlan: {
        id: 'p1',
        description: 'cross-room plan',
        steps: [
          {
            description: 'Go to the workshop and craft',
            completed: false,
            targetArea: 'workshop',
            targetAffordance: 'craft',
          },
        ],
        currentStepIndex: 0,
        createdAt: 1,
      },
      isThinking: false,
      location: 'garden',
      lastPerceptionTick: 0,
    };
  }

  getAgentState() {
    return this.agentState as never;
  }
  getCurrentStep(): PlanStep | null {
    const plan = this.agentState.currentPlan;
    return plan.steps[plan.currentStepIndex] ?? null;
  }
  isPlanComplete(): boolean {
    const plan = this.agentState.currentPlan;
    return plan.currentStepIndex >= plan.steps.length;
  }
  resolveAffordance(_roomId: string, affordanceId: string) {
    // 'craft' lives in the workshop only; 'water_plants' in the garden.
    if (affordanceId === 'craft' && this.agentState.location === 'workshop') {
      return { objectId: 'workbench-1', affordance: { id: 'craft', label: 'Craft' } as never };
    }
    if (affordanceId === 'water_plants' && this.agentState.location === 'garden') {
      return { objectId: 'planter-1', affordance: { id: 'water_plants', label: 'Water' } as never };
    }
    return null;
  }
  checkPreconditions() {
    return { satisfied: true, failed: [] };
  }
  async executeAffordance(objectId: string, affordanceId: string, agentId: string) {
    this.executed.push({ objectId, affordanceId, agentId });
    const result: AffordanceResult = { success: true, driveChanges: { comfort: 10 } };
    return result;
  }
  advanceStep(): void {
    this.advanced += 1;
    this.agentState.currentPlan.currentStepIndex += 1;
  }
  applyDriveChanges(agentId: string, changes: Partial<Record<string, number>>): void {
    void agentId;
    for (const [k, v] of Object.entries(changes)) {
      this.agentState.drives[k] = (this.agentState.drives[k] ?? 0) + (v ?? 0);
    }
  }
  setSystemFeedback(_agentId: string, feedback: string): void {
    this.feedback = feedback;
  }
  setThinking(_agentId: string, isThinking: boolean): void {
    this.agentState.isThinking = isThinking;
  }
}

/** Navigation port modes. */
type NavScriptMode =
  | { mode: 'fixed'; status: NavigationStepStatus }
  | { mode: 'sequence'; statuses: NavScript }
  | { mode: 'absent' };

describe('ExecuteServiceImpl targetArea navigation (spec 039, AC-1)', () => {
  function makeProvider(nav: NavScriptMode): FakeExecuteProvider & {
    navigateToArea?: (agentId: string, targetArea: string) => NavigationStepStatus;
  } {
    const provider = new FakeExecuteProvider(nav);
    if (nav.mode !== 'absent') {
      const statuses = nav.mode === 'fixed' ? [nav.status] : nav.statuses;
      let i = 0;
      (provider as unknown as Record<string, unknown>).navigateToArea = (
        agentId: string,
        targetArea: string,
      ): NavigationStepStatus => {
        provider.navigationCalls.push({ agentId, targetArea });
        const status = statuses[Math.min(i, statuses.length - 1)];
        i += 1;
        return status;
      };
    }
    return provider as FakeExecuteProvider & {
      navigateToArea?: (agentId: string, targetArea: string) => NavigationStepStatus;
    };
  }

  it("status 'walking' → no execution, step not advanced, navigating result", async () => {
    const provider = makeProvider({ mode: 'fixed', status: 'walking' });
    const service = new ExecuteServiceImpl({ dataProvider: provider as ExecuteDataProvider });
    const result: ExecuteResult = await service.execute('a1');
    expect(result.success).toBe(true);
    expect(result.navigating).toBe(true);
    expect(result.planComplete).toBe(false);
    expect(provider.executed).toEqual([]);
    expect(provider.advanced).toBe(0);
    expect(provider.navigationCalls).toEqual([{ agentId: 'a1', targetArea: 'workshop' }]);
  });

  it("status 'arrived' → the affordance executes on arrival with drive changes", async () => {
    const provider = makeProvider({ mode: 'fixed', status: 'arrived' });
    provider.agentState.location = 'workshop'; // arrival moved the agent
    const service = new ExecuteServiceImpl({ dataProvider: provider as ExecuteDataProvider });
    const result = await service.execute('a1');
    expect(result.success).toBe(true);
    expect(result.navigating).toBeUndefined();
    expect(provider.executed).toEqual([
      { objectId: 'workbench-1', affordanceId: 'craft', agentId: 'a1' },
    ]);
    expect(provider.agentState.drives['comfort']).toBe(50);
    expect(provider.advanced).toBe(1);
  });

  it("status 'no-route' → graceful failure with feedback, step NOT advanced", async () => {
    const provider = makeProvider({ mode: 'fixed', status: 'no-route' });
    const service = new ExecuteServiceImpl({ dataProvider: provider as ExecuteDataProvider });
    const result = await service.execute('a1');
    expect(result.success).toBe(false);
    expect(provider.feedback).toContain('workshop');
    expect(provider.advanced).toBe(0);
    expect(provider.executed).toEqual([]);
  });

  it("status 'unknown-area' → graceful failure with feedback, step NOT advanced", async () => {
    const provider = makeProvider({ mode: 'fixed', status: 'unknown-area' });
    const service = new ExecuteServiceImpl({ dataProvider: provider as ExecuteDataProvider });
    const result = await service.execute('a1');
    expect(result.success).toBe(false);
    expect(provider.feedback).toContain('workshop');
    expect(provider.advanced).toBe(0);
  });

  it('a provider without the navigation port fails the area step gracefully (no throw)', async () => {
    const provider = makeProvider({ mode: 'absent' });
    const service = new ExecuteServiceImpl({ dataProvider: provider as ExecuteDataProvider });
    const result = await service.execute('a1');
    expect(result.success).toBe(false);
    expect(provider.advanced).toBe(0);
    expect(provider.executed).toEqual([]);
  });

  it('a navigation-only step (no targetAffordance) advances on arrival', async () => {
    const provider = makeProvider({ mode: 'fixed', status: 'arrived' });
    provider.agentState.currentPlan.steps = [
      { description: 'Walk to the workshop', completed: false, targetArea: 'workshop' },
    ];
    const service = new ExecuteServiceImpl({ dataProvider: provider as ExecuteDataProvider });
    const result = await service.execute('a1');
    expect(result.success).toBe(true);
    expect(result.planComplete).toBe(true);
    expect(provider.advanced).toBe(1);
    expect(provider.executed).toEqual([]);
  });

  it('same-cell targetAffordance-only steps keep the spec-037 contract (no regression)', async () => {
    // The plan step has NO targetArea — pure spec-037 same-cell execution.
    const provider = makeProvider({ mode: 'fixed', status: 'walking' });
    provider.agentState.currentPlan.steps = [
      { description: 'Water the plants', completed: false, targetAffordance: 'water_plants' },
    ];
    const service = new ExecuteServiceImpl({ dataProvider: provider as ExecuteDataProvider });
    const result = await service.execute('a1');
    expect(result.success).toBe(true);
    expect(provider.executed).toEqual([
      { objectId: 'planter-1', affordanceId: 'water_plants', agentId: 'a1' },
    ]);
    // The navigation port must NOT be consulted for same-cell steps.
    expect(provider.navigationCalls).toEqual([]);
  });

  it("a walk-then-execute sequence: 'walking' ticks, then 'arrived' executes once", async () => {
    const provider = makeProvider({
      mode: 'sequence',
      statuses: ['walking', 'walking', 'arrived'],
    });
    const service = new ExecuteServiceImpl({ dataProvider: provider as ExecuteDataProvider });
    const r1 = await service.execute('a1');
    expect(r1.navigating).toBe(true);
    const r2 = await service.execute('a1');
    expect(r2.navigating).toBe(true);
    // Arrival: the agent has crossed into the workshop — execution fires.
    provider.agentState.location = 'workshop';
    const r3 = await service.execute('a1');
    expect(r3.success).toBe(true);
    expect(provider.executed).toHaveLength(1);
    expect(provider.advanced).toBe(1);
  });
});