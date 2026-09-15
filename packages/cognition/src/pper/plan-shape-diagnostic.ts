/**
 * pper/plan-shape-diagnostic — zero-LLM plan-shape diagnostics (spec 060, R2 —
 * issue #214)
 * ────────────────────────────────────────────────────────────────────────────
 * The 96% plan-formation failure ramp in the spec-059 live run had three live
 * mechanisms (prompt growth, provider load, client parse) that a boolean shape
 * check could not distinguish. `estimatePlanPrompt` is a deterministic,
 * zero-LLM size estimate of the actual plan prompt (system prompt +
 * perception context + serialized tool definitions); both the client and the
 * service use it, so `[plan-prompt]` and `[plan-invalid]` lines carry the same
 * units and can be correlated directly.
 *
 * Every line is one line per event, pure string arithmetic, and the call sites
 * wrap each emission so a throwing writer can never break a cycle (spec 049).
 * No line is added to the stable system prompt prefix (spec 021).
 */

import type { PlanShapeReason, ToolDefinition } from '@evol-hive/shared';

/** The subset of `LLMContextPayload` the prompt-size estimate reads. */
export interface PlanPromptInput {
  systemPrompt: string;
  perceptionContext: string;
  tools: readonly ToolDefinition[];
}

/** Deterministic prompt size in characters and estimated tokens. */
export interface PlanPromptSize {
  chars: number;
  estTokens: number;
}

/**
 * Estimate the size of a plan prompt (spec 060, R2). Pure and synchronous:
 * `chars = |systemPrompt| + |perceptionContext| + |serialized tools|` and
 * `estTokens = ceil(chars / 4)`. The serialization is plain `JSON.stringify`
 * over the tool definitions, so equal inputs always yield equal sizes.
 */
export function estimatePlanPrompt(input: PlanPromptInput): PlanPromptSize {
  const serializedTools = JSON.stringify(input.tools ?? []);
  const chars =
    (input.systemPrompt?.length ?? 0) +
    (input.perceptionContext?.length ?? 0) +
    serializedTools.length;
  return { chars, estTokens: Math.ceil(chars / 4) };
}

/** `[plan-prompt]` — one line per plan LLM request (spec 060, R2). */
export function logPlanPrompt(agentId: string | undefined, size: PlanPromptSize): void {
  console.error(
    `[plan-prompt] agent=${agentId ?? '?'} chars=${size.chars} estTokens=${size.estTokens}`,
  );
}

/** `[plan-invalid]` — one line per shape detection, naming the reason (spec 060, R2). */
export function logPlanInvalid(
  agentId: string | undefined,
  reason: PlanShapeReason,
  size: PlanPromptSize,
): void {
  console.error(
    `[plan-invalid] agent=${agentId ?? '?'} reason=${reason} ` +
      `chars=${size.chars} estTokens=${size.estTokens}`,
  );
}

/** `[plan-repair]` — one line when a bounded client-seam repair is issued (spec 060, R3). */
export function logPlanRepair(
  agentId: string | undefined,
  reason: PlanShapeReason,
  attempt = 1,
): void {
  console.error(`[plan-repair] agent=${agentId ?? '?'} attempt=${attempt} reason=${reason}`);
}

/** `[plan-floor]` — one line when the fallback floor stores a plan (spec 060, R4). */
export function logPlanFloor(agentId: string, failures: number, target: string): void {
  console.error(`[plan-floor] agent=${agentId} failures=${failures} target=${target}`);
}
