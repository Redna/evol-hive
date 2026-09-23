/**
 * Issue #229 — social intent must route to its own tools, never into a plan step.
 * ────────────────────────────────────────────────────────────────────────────
 * #226 made the social directives PLAN-shaped ("make it a plan step whose
 * targetAffordance is talk_to") to fix #212's contradiction. That pointed the
 * model at a value the plan enum rejects: talk_to/observe_agent/help/ignore are
 * COGNITIVE tools completePlan executes mid-loop, NOT affordances, and none of
 * them is a legal `targetAffordance`. With a maxed social drive the model obeyed
 * the directive, 3,993 steps were dropped at bind and plans degraded to
 * observe/wait filler (40-minute run, `/home/anima/224run.log`).
 *
 * The fix routes social action back to the tools: the directives now say "call
 * the talk_to/observe_agent/help tool directly", and formulate_plan keeps its
 * existing "MUST use the affordance enum / wait" rule. This file pins the
 * invariant so the two instructions can never drift back into contradiction:
 * no social tool name may appear inside a `targetAffordance` instruction.
 */
import { describe, it, expect } from 'vitest';
import type { PassivePerception, PerceptionResult } from '@evol-hive/shared';
import { PlanBuilderImpl } from '../src/pper/plan-builder.js';

const builder = new PlanBuilderImpl();

/** The four social tools — tools, not affordances, and never a targetAffordance. */
const SOCIAL_TOOL_NAMES = ['talk_to', 'observe_agent', 'help', 'ignore'] as const;

function makeSocialPerception(): PerceptionResult {
  const passive: PassivePerception = {
    roomId: 'kitchen',
    objectsPresent: [],
    drives: { energy: 80, hunger: 80, social: 10, comfort: 80, curiosity: 80 },
    agentsPresent: [{ agentId: 'bob-1', name: 'Bob', currentActivity: 'idle', isThinking: false }],
  };
  return {
    passive,
    prunedAffordances: [],
    primaryDriveLabel: 'low social, need social interaction',
  };
}

describe('issue #229 — the plan context never points a social tool at targetAffordance', () => {
  it('routes social action to the tools, never into a plan step', () => {
    const payload = builder.build(makeSocialPerception());
    const all = `${payload.systemPrompt}\n${payload.perceptionContext}`;

    // Social action is phrased as a direct tool call.
    expect(payload.perceptionContext).toContain(
      'call the talk_to, observe_agent, or help tool directly',
    );
    expect(payload.systemPrompt).toContain('calling a social tool directly');

    // And no social tool is ever named as a targetAffordance value.
    for (const name of SOCIAL_TOOL_NAMES) {
      expect(all).not.toContain(`targetAffordance: ${name}`);
      expect(all).not.toContain(`targetAffordance is ${name}`);
    }
  });

  it('still requires formulate_plan steps to use the affordance enum (wait fallback)', () => {
    const payload = builder.build(makeSocialPerception());
    expect(payload.systemPrompt).toContain(
      'MUST set targetAffordance to one of the enum values in the formulate_plan tool schema',
    );
    expect(payload.systemPrompt).toContain('Use "wait" when no affordance is relevant');
  });
});
