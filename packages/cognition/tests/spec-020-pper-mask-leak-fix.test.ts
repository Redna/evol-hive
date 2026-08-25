/**
 * Tests for spec 020 — PPER Mask Leak Fix (Issue #83).
 *
 * Regression tests for the bug where `PerceptionServiceImpl.perceive()`
 * stored the **masked** affordances in `prunedAffordances`, starving the
 * Plan builder of affordance tools and causing an infinite hallucination
 * loop. The fix separates the unmasked classifier output (`prunedAffordances`)
 * from the masked output (`maskedAffordances`).
 *
 * Acceptance criteria covered:
 *   - AC-7:  PerceptionBuilderImpl reads `maskedAffordances ?? prunedAffordances`.
 *   - AC-8:  PerceptionBuilder hides affordance tools when no plan + masking enabled.
 *   - AC-9:  PerceptionBuilder includes affordance tools when plan exists / masking disabled.
 *   - AC-10: PlanBuilder uses `prunedAffordances` (unmasked) regardless of masking state.
 *   - AC-11: PlanBuilder sees `brew_coffee` tool when no plan + masking enabled (critical regression).
 */
import { describe, it, expect } from 'vitest';
import type { Affordance, PerceptionResult } from '@evol-hive/shared';
import { PerceptionBuilderImpl } from '../src/pper/perception-builder.js';
import { PlanBuilderImpl } from '../src/pper/plan-builder.js';
import { defaultCognitiveTools } from '../src/tools/index.js';

// ─── Test Data ────────────────────────────────────────────────────────────────

const ROOM_ID = 'kitchen';

const affordances: Affordance[] = [
  {
    id: 'brew_coffee',
    label: 'Brew coffee',
    engineEffect: 'brew_coffee',
    preconditions: [],
    effects: { energy: 20 },
  },
  {
    id: 'sleep',
    label: 'Sleep',
    engineEffect: 'sleep',
    preconditions: [],
    effects: { energy: 30 },
  },
  {
    id: 'chat',
    label: 'Chat',
    engineEffect: 'chat',
    preconditions: [],
    effects: { social: 10 },
  },
];

/**
 * Build a `PerceptionResult` that mirrors what the fixed
 * `PerceptionServiceImpl.perceive()` produces: `prunedAffordances` holds the
 * unmasked classifier output and `maskedAffordances` holds the masked result.
 */
function makePerceptionResult(opts: {
  prunedAffordances?: Affordance[];
  maskedAffordances?: Affordance[];
}): PerceptionResult {
  const result: PerceptionResult = {
    passive: {
      roomId: ROOM_ID,
      objectsPresent: [{ objectId: 'coffee-1', name: 'Coffee Machine', type: 'appliance' }],
      drives: { energy: 10, hunger: 50, social: 80, comfort: 60, curiosity: 40 },
    },
    prunedAffordances: opts.prunedAffordances ?? affordances,
    primaryDriveLabel: 'low energy',
  };
  if (opts.maskedAffordances !== undefined) {
    result.maskedAffordances = opts.maskedAffordances;
  }
  return result;
}

/** The set of cognitive tool names that are always present (never masked). */
const COGNITIVE_TOOL_NAMES = defaultCognitiveTools.map((t) => t.name);

const AFFORDANCE_TOOL_NAMES = affordances.map((a) => a.id);

// ─── AC-11: PlanBuilder sees affordance tools when no plan + masking enabled ─

describe('Spec 020 — PlanBuilderImpl always sees unmasked affordances (AC-10, AC-11)', () => {
  it('AC-11: when no plan and masking is active (maskedAffordances=[]), PlanBuilder tools include the brew_coffee affordance tool', () => {
    // The critical regression scenario: the agent has no plan, masking is
    // enabled, so maskedAffordances is []. The plan builder must still see
    // affordance tools built from the UNMASKED prunedAffordances so the LLM
    // can reference exact affordance IDs in plan steps.
    const perceptionResult = makePerceptionResult({
      prunedAffordances: affordances,
      maskedAffordances: [],
    });
    const builder = new PlanBuilderImpl();
    const payload = builder.build(perceptionResult);

    const toolNames = payload.tools.map((t) => t.function.name);
    expect(toolNames).toContain('formulate_plan');
    expect(toolNames).toContain('brew_coffee');
    expect(AFFORDANCE_TOOL_NAMES.every((name) => toolNames.includes(name))).toBe(true);
    // The LLM context availableAffordances must be the unmasked set.
    expect(payload.availableAffordances).toEqual(affordances);
  });

  it('AC-10: when masking is disabled (no maskedAffordances field), PlanBuilder tools include all affordance tools', () => {
    const perceptionResult = makePerceptionResult({ prunedAffordances: affordances });
    const builder = new PlanBuilderImpl();
    const payload = builder.build(perceptionResult);

    const toolNames = payload.tools.map((t) => t.function.name);
    expect(toolNames).toContain('formulate_plan');
    expect(AFFORDANCE_TOOL_NAMES.every((name) => toolNames.includes(name))).toBe(true);
    expect(payload.availableAffordances).toEqual(affordances);
  });

  it('AC-10: when agent has a plan (masking is a no-op), PlanBuilder tools include all affordance tools', () => {
    const perceptionResult = makePerceptionResult({
      prunedAffordances: affordances,
      maskedAffordances: affordances,
    });
    const builder = new PlanBuilderImpl();
    const payload = builder.build(perceptionResult);

    const toolNames = payload.tools.map((t) => t.function.name);
    expect(AFFORDANCE_TOOL_NAMES.every((name) => toolNames.includes(name))).toBe(true);
    expect(payload.availableAffordances).toEqual(affordances);
  });

  it('AC-10: PlanBuilder does not read maskedAffordances — uses prunedAffordances exclusively', () => {
    // Even if maskedAffordances is [], the plan builder must use prunedAffordances.
    // If it (incorrectly) used maskedAffordances, availableAffordances would be [].
    const perceptionResult = makePerceptionResult({
      prunedAffordances: affordances,
      maskedAffordances: [],
    });
    const builder = new PlanBuilderImpl();
    const payload = builder.build(perceptionResult);

    expect(payload.availableAffordances).toEqual(affordances);
    expect(payload.availableAffordances.length).toBeGreaterThan(0);
  });
});

// ─── AC-8, AC-9: PerceptionBuilder uses maskedAffordances ?? prunedAffordances ─

describe('Spec 020 — PerceptionBuilderImpl uses maskedAffordances (AC-7, AC-8, AC-9)', () => {
  it('AC-8: when no plan + masking enabled (maskedAffordances=[]), tools contain only cognitive tool definitions (no affordance tools)', () => {
    const perceptionResult = makePerceptionResult({
      prunedAffordances: affordances,
      maskedAffordances: [],
    });
    const builder = new PerceptionBuilderImpl();
    const payload = builder.build(perceptionResult, {
      hasPlan: false,
      maskingEnabled: true,
    });

    const toolNames = payload.tools.map((t) => t.function.name);
    // No affordance tools.
    expect(AFFORDANCE_TOOL_NAMES.every((name) => !toolNames.includes(name))).toBe(true);
    // Cognitive tools present (formulate_plan, query_memory, update_internal_state).
    expect(COGNITIVE_TOOL_NAMES.every((name) => toolNames.includes(name))).toBe(true);
    expect(payload.availableAffordances).toEqual([]);
  });

  it('AC-9: when agent has a plan (maskedAffordances=affordances), tools include affordance tools', () => {
    const perceptionResult = makePerceptionResult({
      prunedAffordances: affordances,
      maskedAffordances: affordances,
    });
    const builder = new PerceptionBuilderImpl();
    const payload = builder.build(perceptionResult, {
      hasPlan: true,
      maskingEnabled: true,
    });

    const toolNames = payload.tools.map((t) => t.function.name);
    expect(toolNames).toContain('brew_coffee');
    expect(AFFORDANCE_TOOL_NAMES.every((name) => toolNames.includes(name))).toBe(true);
    expect(payload.availableAffordances).toEqual(affordances);
  });

  it('AC-9: when masking disabled (no maskedAffordances field), builder falls back to prunedAffordances and includes affordance tools', () => {
    const perceptionResult = makePerceptionResult({ prunedAffordances: affordances });
    const builder = new PerceptionBuilderImpl();
    const payload = builder.build(perceptionResult, {
      hasPlan: false,
      maskingEnabled: false,
    });

    const toolNames = payload.tools.map((t) => t.function.name);
    expect(toolNames).toContain('brew_coffee');
    expect(payload.availableAffordances).toEqual(affordances);
  });

  it('AC-7: when maskedAffordances is undefined (no guardrail) but maskingEnabled=true + no plan, builder hides affordance tools (defense-in-depth)', () => {
    // Backward-compat scenario: a PerceptionResult produced without a guardrail
    // (no maskedAffordances field) is passed to a builder with maskingEnabled=true.
    // The builder must still hide affordance tools via the noPlan && maskingEnabled check.
    const perceptionResult = makePerceptionResult({ prunedAffordances: affordances });
    const builder = new PerceptionBuilderImpl();
    const payload = builder.build(perceptionResult, {
      hasPlan: false,
      maskingEnabled: true,
    });

    const toolNames = payload.tools.map((t) => t.function.name);
    expect(AFFORDANCE_TOOL_NAMES.every((name) => !toolNames.includes(name))).toBe(true);
    expect(payload.availableAffordances).toEqual([]);
  });

  it('AC-7: when maskedAffordances is defined and no plan + maskingEnabled, builder uses masked field (empty) — not prunedAffordances', () => {
    // This is the core fix: the builder reads maskedAffordances, not prunedAffordances.
    // If it (incorrectly) read prunedAffordances, availableAffordances would be the full list.
    const perceptionResult = makePerceptionResult({
      prunedAffordances: affordances,
      maskedAffordances: [],
    });
    const builder = new PerceptionBuilderImpl();
    const payload = builder.build(perceptionResult, {
      hasPlan: false,
      maskingEnabled: true,
    });

    expect(payload.availableAffordances).toEqual([]);
    const toolNames = payload.tools.map((t) => t.function.name);
    expect(toolNames).not.toContain('brew_coffee');
  });
});
