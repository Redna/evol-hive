/**
 * Spec 055 — Plan memory + hours-horizon in the plan prompt
 * (Req 4 + Req 5 — issue #198, AC-4 + AC-5)
 * ────────────────────────────────────────────────────────────────────────────
 * Three connected renderings, all dynamic-section or persona-stable:
 *
 * - AC-4 (Req 4): with a stamped `lastPlanOutcome`, the plan payload's
 *   `perceptionContext` carries the last-plan line (steps, outcome, drive
 *   deltas) plus the reflection follow-up — rendered in the dynamic
 *   (post-`---`) section ONLY. With no record the payload is byte-identical
 *   to the pre-change builder for the same perception (additive-optional
 *   discipline, spec 039/052 pattern).
 * - AC-5 (Req 5): `Aspirations:` renders in the system prompt immediately
 *   after the persona text (persona-keyed, so the KV prefix still hits per
 *   persona — spec 021); a persona WITHOUT goals renders a system prompt
 *   byte-identical to pre-change. The horizon directive renders in the
 *   dynamic section.
 * - The `PerceptionServiceImpl` population seam: `getLastPlanOutcome?` is an
 *   OPTIONAL provider method — absent → `PerceptionResult.lastPlanOutcome`
 *   stays `undefined` (legacy byte-identity).
 */
import { describe, it, expect } from 'vitest';
import type {
  Affordance,
  AgentProfile,
  LastPlanOutcome,
  PerceptionDataProvider,
  PerceptionResult,
} from '@evol-hive/shared';
import { PlanBuilderImpl } from '../src/pper/plan-builder.js';
import { PerceptionServiceImpl } from '../src/pper/index.js';
import type { AffordanceClassifier } from '../src/classifier/index.js';

const drives = { energy: 45, hunger: 50, social: 50, comfort: 50, curiosity: 60 };

const prunedAffordances: Affordance[] = [
  {
    id: 'water_plants',
    label: 'Water the plants',
    engineEffect: 'water_plants',
    preconditions: [],
    effects: { curiosity: 10, comfort: 5 },
  },
];

function makePerception(overrides: Partial<PerceptionResult> = {}): PerceptionResult {
  return {
    passive: {
      roomId: 'garden',
      objectsPresent: [{ objectId: 'planter-1', name: 'Planter', type: 'furniture' }],
      drives,
    },
    prunedAffordances,
    primaryDriveLabel: 'low curiosity, need to restore curiosity',
    ...overrides,
  };
}

const SUCCESS_OUTCOME: LastPlanOutcome = {
  planDescription: 'Water the greenhouse plants',
  steps: ['go_to_greenhouse', 'water_plants'],
  success: true,
  driveChanges: { curiosity: 10 },
  reflected: true,
};

// ── Goldens: the pre-change builder output for this fixture (no persona, no
//    agents, no hints — energy 45 / curiosity 60 are above the urgency
//    threshold, so no drive-hint lines render). The additive change must not
//    move a byte of these when no lastPlanOutcome is stamped. ────────────────

const GOLDEN_SYSTEM_PROMPT_NO_PERSONA =
  'You are an autonomous NPC in a deterministic simulation. ' +
  'You must formulate a plan to satisfy your most urgent drive. ' +
  'Use the formulate_plan cognitive tool to break your goal into a sequence of actionable steps. ' +
  'EVERY step in your plan MUST set targetAffordance to one of the enum values in the formulate_plan tool schema (the affordances available to you right now). ' +
  'Use "wait" when no affordance is relevant. Steps without a valid targetAffordance are rejected — you cannot act by describing intentions alone. ' +
  'Each step should map to an available affordance when possible.';

const GOLDEN_CONTEXT_NO_RECORD =
  'Room: garden\n' +
  'Objects: Planter\n' +
  '---\n' +
  'Primary drive: low curiosity, need to restore curiosity\n' +
  'Drives: energy=45, hunger=50, social=50, comfort=50, curiosity=60\n' +
  'Horizon: your plan may chain several steps toward what you intend over the coming hours — e.g. a morning of watering, harvesting and trading, an afternoon of rest and talk. This is framing, not a schedule: the choice stays yours.';

const builder = new PlanBuilderImpl();

describe('spec 055 Req 4 / AC-4: last plan + outcome in the plan context', () => {
  it('renders the last-plan line with steps, outcome, and drive deltas', () => {
    const payload = builder.build(makePerception({ lastPlanOutcome: SUCCESS_OUTCOME }));
    expect(payload.perceptionContext).toContain(
      'Your last plan was "go_to_greenhouse, water_plants" — it succeeded (curiosity +10).',
    );
  });

  it('renders multiple drive deltas with explicit signs', () => {
    const payload = builder.build(
      makePerception({
        lastPlanOutcome: { ...SUCCESS_OUTCOME, driveChanges: { curiosity: 10, comfort: 5 } },
      }),
    );
    expect(payload.perceptionContext).toContain(
      'Your last plan was "go_to_greenhouse, water_plants" — it succeeded (curiosity +10, comfort +5).',
    );
  });

  it('renders failures without fabricating success', () => {
    const payload = builder.build(
      makePerception({
        lastPlanOutcome: {
          planDescription: 'Water the greenhouse plants',
          steps: ['water_plants'],
          success: false,
          reflected: false,
        },
      }),
    );
    expect(payload.perceptionContext).toContain('Your last plan was "water_plants" — it failed.');
  });

  it('renders the reflection follow-up line only when the outcome was reflected', () => {
    const withReflection = builder.build(makePerception({ lastPlanOutcome: SUCCESS_OUTCOME }));
    expect(withReflection.perceptionContext).toContain(
      'You already reflected on that plan — what you learned is in your memory.',
    );
    const withoutReflection = builder.build(
      makePerception({ lastPlanOutcome: { ...SUCCESS_OUTCOME, reflected: false } }),
    );
    expect(withoutReflection.perceptionContext).not.toContain('reflected on that plan');
  });

  it('renders the lines in the DYNAMIC (post-`---`) section only (spec 021 discipline)', () => {
    const payload = builder.build(makePerception({ lastPlanOutcome: SUCCESS_OUTCOME }));
    const [stable, dynamic] = payload.perceptionContext.split('\n---\n');
    expect(dynamic).toContain('Your last plan was');
    expect(stable).not.toContain('Your last plan was');
    expect(dynamic).toContain('reflected on that plan');
    expect(stable).not.toContain('reflected on that plan');
    // The stable prefix stays byte-identical to the no-record golden.
    expect(stable).toBe(GOLDEN_CONTEXT_NO_RECORD.split('\n---\n')[0]);
  });

  it('with no record the payload carries NO last-plan lines (additive-optional discipline)', () => {
    const payload = builder.build(makePerception());
    // AC-4's byte-identity claim applies to the lastPlanOutcome FEATURE: with
    // no record, no last-plan/reflection lines render — the payload is
    // otherwise exactly the golden (which includes the always-on Req-5
    // horizon directive, a separate dynamic-section feature whose presence
    // every cycle is KV-cache-safe by construction — identical line every
    // tick, stable prefix untouched). The system prompt (no persona) IS
    // byte-identical to pre-change.
    expect(payload.perceptionContext).toBe(GOLDEN_CONTEXT_NO_RECORD);
    expect(payload.perceptionContext).not.toContain('Your last plan was');
    expect(payload.perceptionContext).not.toContain('reflected on that plan');
    expect(payload.systemPrompt).toBe(GOLDEN_SYSTEM_PROMPT_NO_PERSONA);
  });

  it('an outcome with empty driveChanges omits the delta parenthetical', () => {
    const payload = builder.build(
      makePerception({
        lastPlanOutcome: { ...SUCCESS_OUTCOME, driveChanges: undefined },
      }),
    );
    expect(payload.perceptionContext).toContain(
      'Your last plan was "go_to_greenhouse, water_plants" — it succeeded.',
    );
  });
});

describe('spec 055 Req 4: PerceptionServiceImpl populates lastPlanOutcome from the provider', () => {
  const classifier = {
    prune: async (_q: string, affordances: Affordance[]) => affordances,
  } as unknown as AffordanceClassifier;

  it('calls the optional getLastPlanOutcome method and carries the record', async () => {
    const provider = {
      getAgentLocation: () => 'garden',
      getObjectsInRoom: () => [{ id: 'planter-1', name: 'Planter', type: 'furniture' }],
      getAffordancesInRoom: () => prunedAffordances,
      getAgentDrives: () => ({ ...drives }),
      getPrimaryDriveLabel: () => 'low curiosity, need to restore curiosity',
      getSystemFeedback: () => undefined,
      getLastPlanOutcome: () => SUCCESS_OUTCOME,
    } satisfies PerceptionDataProvider;
    const service = new PerceptionServiceImpl({ provider, classifier });
    const result = await service.perceive('a1');
    expect(result.lastPlanOutcome).toEqual(SUCCESS_OUTCOME);
  });

  it('legacy providers without the method keep lastPlanOutcome undefined', async () => {
    const provider = {
      getAgentLocation: () => 'garden',
      getObjectsInRoom: () => [{ id: 'planter-1', name: 'Planter', type: 'furniture' }],
      getAffordancesInRoom: () => prunedAffordances,
      getAgentDrives: () => ({ ...drives }),
      getPrimaryDriveLabel: () => 'low curiosity, need to restore curiosity',
      getSystemFeedback: () => undefined,
    } satisfies PerceptionDataProvider;
    const service = new PerceptionServiceImpl({ provider, classifier });
    const result = await service.perceive('a1');
    expect(result.lastPlanOutcome).toBeUndefined();
  });

  it('a throwing provider read never breaks perception (graceful degradation)', async () => {
    const provider = {
      getAgentLocation: () => 'garden',
      getObjectsInRoom: () => [{ id: 'planter-1', name: 'Planter', type: 'furniture' }],
      getAffordancesInRoom: () => prunedAffordances,
      getAgentDrives: () => ({ ...drives }),
      getPrimaryDriveLabel: () => 'low curiosity, need to restore curiosity',
      getSystemFeedback: () => undefined,
      getLastPlanOutcome: () => {
        throw new Error('provider blew up');
      },
    } satisfies PerceptionDataProvider;
    const service = new PerceptionServiceImpl({ provider, classifier });
    const result = await service.perceive('a1');
    expect(result.lastPlanOutcome).toBeUndefined();
  });
});

// ── Req 5 / AC-5: Aspirations in the system prompt + horizon directive ──────

const PERSONA_WITH_GOALS: AgentProfile = {
  id: 'iris-1',
  name: 'Iris Voss',
  description: 'Herbalist',
  traits: ['observant', 'reserved'],
  backstory: 'Iris studied botany for two years.',
  longTermGoals: [
    'Keep every seedling in the greenhouse alive through the season',
    'Learn the names of the people she trades with',
  ],
};

const PERSONA_WITHOUT_GOALS: AgentProfile = {
  id: 'maren-1',
  name: 'Maren Holt',
  description: 'Community gardener',
  traits: ['patient', 'methodical'],
  backstory: 'Maren spent twelve years as a florist.',
};

describe('spec 055 Req 5 / AC-5: Aspirations line + horizon directive', () => {
  it('renders Aspirations immediately after the persona text', () => {
    const payload = builder.build(makePerception({ persona: PERSONA_WITH_GOALS }));
    const prompt = payload.systemPrompt;
    // The DEDICATED Aspirations sentence rides immediately after the persona
    // text (`. ` closes the formatPersona blob) and before the directive.
    // formatPersona may ALSO embed the goals inside the blob — the dedicated
    // line is the requirement (Req 5), keyed to the persona like the rest of
    // the stable prefix (spec 021).
    expect(prompt).toContain(
      '. Aspirations: Keep every seedling in the greenhouse alive through the season; ' +
        'Learn the names of the people she trades with. You must formulate a plan',
    );
    const personaStart = prompt.indexOf('You are Iris Voss,');
    const directive = prompt.indexOf('You must formulate a plan');
    const dedicated = prompt.indexOf('. Aspirations: Keep every seedling');
    expect(personaStart).toBeGreaterThanOrEqual(0);
    expect(dedicated).toBeGreaterThan(personaStart);
    expect(directive).toBeGreaterThan(dedicated);
  });

  it('a persona WITHOUT goals renders a system prompt byte-identical to pre-change', () => {
    const payload = builder.build(makePerception({ persona: PERSONA_WITHOUT_GOALS }));
    // The pre-change persona branch (spec 021 stable template) — the change
    // must not move a byte when longTermGoals is absent. formatPersona joins
    // its lines with \n (backstory line + traits line; the description field
    // is superseded when new persona fields exist).
    expect(payload.systemPrompt).toBe(
      'You are Maren Holt, Maren Holt: Maren spent twelve years as a florist.\n' +
        'Traits: patient, methodical. ' +
        'You must formulate a plan to satisfy your most urgent drive. ' +
        'Use the formulate_plan cognitive tool to break your goal into a sequence of actionable steps. ' +
        'EVERY step in your plan MUST set targetAffordance to one of the enum values in the formulate_plan tool schema (the affordances available to you right now). ' +
        'Use "wait" when no affordance is relevant. Steps without a valid targetAffordance are rejected — you cannot act by describing intentions alone. ' +
        'Each step should map to an available affordance when possible.',
    );
  });

  it('the horizon directive renders in the dynamic section only (not the stable prefix)', () => {
    const payload = builder.build(makePerception({ persona: PERSONA_WITH_GOALS }));
    const [stable, dynamic] = payload.perceptionContext.split('\n---\n');
    expect(dynamic).toContain('Horizon:');
    expect(dynamic).toContain('coming hours');
    expect(stable).not.toContain('Horizon');
  });

  it('the horizon directive frames rather than schedules (the LLM keeps the decision)', () => {
    const payload = builder.build(makePerception());
    const dynamic = payload.perceptionContext.split('\n---\n')[1];
    expect(dynamic).toContain('framing, not a schedule');
  });
});
