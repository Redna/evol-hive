/**
 * Issue #212 — the plan phase's context must not instruct actions the plan
 * phase rejects.
 * ────────────────────────────────────────────────────────────────────────────
 * The spec-061 R5 probe proved the "shape-invalid ramp" was a prompt/contract
 * contradiction: the plan phase's system prompt and context told the model to
 * call `talk_to` (*"…do not use formulate_plan for social actions"*, *"Call
 * talk_to or help NOW … Do not formulate a plan first"*, drive hints saying
 * *"Call such an affordance NOW — do not formulate a search plan"*), while
 * `completePlan` accepts only a `formulate_plan` call. The model obeyed and the
 * phase scored the obedient answer `missing-description` — 1,002/1,446 (69%) of
 * a run's invalids.
 *
 * The probe also showed the model emits `talk_to` even when the tool is REMOVED
 * from `tools` — the text drives it — so the wording must change; removing
 * tools is not sufficient. This file locks both halves: the instructions never
 * tell the model to bury a social action in a plan step, and a
 * non-`formulate_plan` call is named as `reason=wrong-tool` instead of being
 * hidden behind a "malformed plan" reason.
 *
 * Issue #229 corrected this fix's first form: making the wording PLAN-shaped
 * ("make it a plan step whose targetAffordance is talk_to") pointed the model at
 * a value the plan enum rejects, so it obeyed, the steps were dropped at bind
 * and plans degraded to observe/wait filler. talk_to/observe_agent/help are
 * COGNITIVE tools completePlan executes mid-loop — the wording now routes social
 * action to those tools and reserves formulate_plan for object affordances.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { PassivePerception, PerceptionResult } from '@evol-hive/shared';
import { PlanBuilderImpl } from '../src/pper/plan-builder.js';
import { OpenAICompatibleLLMClient } from '../src/llm/openai-client.js';

const builder = new PlanBuilderImpl();

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

describe('issue #212 — plan-phase instructions match the plan phase contract', () => {
  it('never tells the model to bypass formulate_plan', () => {
    const payload = builder.build(makeSocialPerception());
    const all = `${payload.systemPrompt}\n${payload.perceptionContext}`;
    for (const banned of [
      'do not use formulate_plan',
      'Do not formulate a plan first',
      'do not formulate a search plan',
    ]) {
      expect(all).not.toContain(banned);
    }
  });

  it('routes social actions to their tools, never into a plan step (#229)', () => {
    const payload = builder.build(makeSocialPerception());
    // Social action is a direct tool call, not a formulate_plan step.
    expect(payload.systemPrompt).toContain('calling the talk_to, observe_agent, or help tool directly');
    expect(payload.perceptionContext).toContain('call the talk_to, observe_agent, or help tool directly');
    expect(payload.perceptionContext).toContain('Interact with another agent in this room by calling the talk_to tool directly');
    // And no instruction points a social tool at the plan's targetAffordance.
    const all = `${payload.systemPrompt}\n${payload.perceptionContext}`;
    expect(all).not.toContain('targetAffordance: talk_to');
    expect(all).not.toContain('targetAffordance is talk_to');
  });
});

describe('issue #212 — a wrong tool call is named, not scored as a malformed plan', () => {
  const originalFetch = globalThis.fetch;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    errSpy.mockRestore();
    vi.restoreAllMocks();
  });

  function toolCallResponse(name: string, args: unknown): Response {
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call-1',
                  type: 'function',
                  function: { name, arguments: JSON.stringify(args) },
                },
              ],
            },
          },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }

  it('emits [plan-invalid] reason=wrong-tool tool=talk_to, never missing-description', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        toolCallResponse('talk_to', { targetAgentId: 'bob-1', message: 'hi' }),
      ) as unknown as typeof fetch;

    const client = new OpenAICompatibleLLMClient({ baseUrl: 'http://localhost:1', model: 'test' });
    // The phase still fails (a plan was required) — we assert the *diagnostic*.
    await client
      .completePlan({
        systemPrompt: 'sys',
        perceptionContext: 'ctx',
        availableAffordances: [],
        cognitiveTools: [],
        tools: [],
        agentId: 'a1',
      })
      .catch(() => undefined);

    const invalid = errSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((l) => l.includes('[plan-invalid]'));
    expect(invalid.some((l) => l.includes('reason=wrong-tool') && l.includes('tool=talk_to'))).toBe(
      true,
    );
    expect(invalid.some((l) => l.includes('reason=missing-description'))).toBe(false);
  });
});
