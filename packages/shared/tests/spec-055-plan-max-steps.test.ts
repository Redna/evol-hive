/**
 * Spec 055 — Plan step cap: `PLAN_MAX_STEPS` in the shared schema factory
 * (Req 6 — issue #198, AC-6 schema half)
 * ────────────────────────────────────────────────────────────────────────────
 * The 2–3-step plan shape was prompt-shaped; the schema had no bound. Req 6
 * adds `steps.maxItems = PLAN_MAX_STEPS` to `formulatePlanSchemaFor` — a new
 * shared config constant (env-configurable, default 6) — so the value space
 * itself bounds plan length. The plan-service validation half lives in
 * `packages/cognition/tests/spec-055-plan-cap-validation.test.ts`.
 *
 * Pins:
 * - the emitted schema carries `steps.maxItems = defaultPlanMaxSteps()` (6);
 * - `PLAN_MAX_STEPS` env override is honored at factory-call time;
 * - an explicit `maxSteps` argument overrides both;
 * - with the legacy default the schema is otherwise byte-identical to the
 *   pre-change shape (enum binding, targetArea, required, additionalProperties
 *   all untouched);
 * - non-numeric / non-positive env values fall back to the default (fail-open
 *   to the documented cap, never to an illegal schema).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  formulatePlanSchemaFor,
  formulatePlanToolFor,
  defaultPlanMaxSteps,
  DEFAULT_PLAN_MAX_STEPS,
  WAIT_AFFORDANCE,
} from '../src/index.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

/** The pre-change (spec 037/039) schema shape for the given enum inputs. */
function legacySchema(availableAffordanceIds: string[], knownAreas?: string[]) {
  const enumValues =
    availableAffordanceIds.length > 0
      ? [...availableAffordanceIds, WAIT_AFFORDANCE]
      : [WAIT_AFFORDANCE];
  const areaEnum = knownAreas !== undefined && knownAreas.length > 0 ? [...knownAreas] : null;
  return {
    type: 'object',
    properties: {
      description: { type: 'string', description: 'High-level description of the plan.' },
      steps: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            description: { type: 'string' },
            targetAffordance: {
              type: 'string',
              description:
                "The affordance ID to execute for this step. MUST be one of the enum values. Use 'wait' when no affordance is relevant.",
              enum: enumValues,
            },
            ...(areaEnum !== null
              ? {
                  targetArea: {
                    type: 'string',
                    description:
                      'The KNOWN area (room or object anchor) this step navigates to first. MUST be one of the enum values. Omit for same-room steps — the engine walks the agent there before the affordance executes.',
                    enum: areaEnum,
                  },
                }
              : {}),
          },
          required: ['description'],
          additionalProperties: false,
        },
      },
    },
    required: ['description', 'steps'],
    additionalProperties: false,
  };
}

describe('spec 055 Req 6: formulatePlanSchemaFor emits steps.maxItems = PLAN_MAX_STEPS', () => {
  it('the default cap constant is 6 (the documented default)', () => {
    expect(DEFAULT_PLAN_MAX_STEPS).toBe(6);
  });

  it('the factory emits steps.maxItems = 6 with no arguments beyond the enum', () => {
    const schema = formulatePlanSchemaFor(['water_plants', 'harvest']) as Record<string, unknown>;
    const steps = (schema as { properties: { steps: Record<string, unknown> } }).properties
      .steps;
    expect(steps['maxItems']).toBe(6);
  });

  it('defaultPlanMaxSteps() reads the PLAN_MAX_STEPS env var at call time', () => {
    vi.stubEnv('PLAN_MAX_STEPS', '3');
    expect(defaultPlanMaxSteps()).toBe(3);
    const schema = formulatePlanSchemaFor(['water_plants']) as {
      properties: { steps: { maxItems?: number } };
    };
    expect(schema.properties.steps.maxItems).toBe(3);
  });

  it('an explicit maxSteps argument overrides the env default', () => {
    vi.stubEnv('PLAN_MAX_STEPS', '3');
    const schema = formulatePlanSchemaFor(['water_plants'], undefined, 8) as {
      properties: { steps: { maxItems?: number } };
    };
    expect(schema.properties.steps.maxItems).toBe(8);
  });

  it('the tool factory passes the cap through to the tool parameters', () => {
    const tool = formulatePlanToolFor(['water_plants'], undefined, 5);
    const params = tool.function.parameters as {
      properties: { steps: { maxItems?: number } };
    };
    expect(params.properties.steps.maxItems).toBe(5);
  });

  it('non-numeric and non-positive env values fall back to the default', () => {
    vi.stubEnv('PLAN_MAX_STEPS', 'not-a-number');
    expect(defaultPlanMaxSteps()).toBe(6);
    vi.stubEnv('PLAN_MAX_STEPS', '0');
    expect(defaultPlanMaxSteps()).toBe(6);
    vi.stubEnv('PLAN_MAX_STEPS', '-2');
    expect(defaultPlanMaxSteps()).toBe(6);
    vi.stubEnv('PLAN_MAX_STEPS', '2.9');
    expect(defaultPlanMaxSteps()).toBe(2); // floored to a legal integer cap
  });
});

describe('spec 055 Req 6: with the legacy default the schema is otherwise unchanged', () => {
  it('affordance-enum-bound schema matches the pre-change shape plus maxItems only', () => {
    const schema = formulatePlanSchemaFor(['water_plants', 'harvest']) as Record<string, unknown>;
    const clone = structuredClone(schema) as {
      properties: { steps: { maxItems?: number } };
    };
    delete clone.properties.steps.maxItems;
    expect(clone).toEqual(legacySchema(['water_plants', 'harvest']));
  });

  it('knownAreas-bound schema matches the pre-change shape plus maxItems only', () => {
    const schema = formulatePlanSchemaFor(['water_plants'], ['garden', 'greenhouse']) as Record<
      string,
      unknown
    >;
    const clone = structuredClone(schema) as {
      properties: { steps: { maxItems?: number } };
    };
    delete clone.properties.steps.maxItems;
    expect(clone).toEqual(legacySchema(['water_plants'], ['garden', 'greenhouse']));
  });

  it('the empty-enum escape (masking) keeps the wait-only enum and gains maxItems only', () => {
    const schema = formulatePlanSchemaFor([]) as {
      properties: { steps: { maxItems?: number; items: { properties: Record<string, unknown> } } };
    };
    expect(schema.properties.steps.maxItems).toBe(6);
    expect(schema.properties.steps.items.properties.targetAffordance).toMatchObject({
      enum: ['wait'],
    });
  });
});