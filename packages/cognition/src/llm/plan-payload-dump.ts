/**
 * llm/plan-payload-dump — env-gated largest-payload dump (spec 061, R4)
 * ────────────────────────────────────────────────────────────────────────────
 * The spec-060 `[llm-raw]` dump writes the FIRST malformed payload per agent
 * (`/tmp/empty-args-<agent>.json`) — early-run and small, so it cannot
 * discriminate H1 (prompt growth) from H2 (provider load), which must be
 * tested on a LATE-run payload. When `PLAN_PAYLOAD_DUMP_DIR` is set, the client
 * writes the largest plan payload seen per agent to
 * `<dir>/plan-payload-<agent>.json`, overwriting only when the new payload is
 * larger. Zero-LLM, inert when the env var is unset, and every fs call is
 * wrapped so a throwing writer never breaks a plan request (spec 049).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** The subset of the plan payload the dump captures for offline replay. */
export interface PlanPayloadDump {
  messages: unknown[];
  tools: unknown;
  systemPrompt: string;
  perceptionContext: string;
  agentId: string | undefined;
}

/**
 * Write `data` to `<dir>/plan-payload-<agent>.json` only when its serialized
 * length exceeds the existing file (spec 061, R4 — largest payload wins). The
 * caller gates this on `PLAN_PAYLOAD_DUMP_DIR`; this function is pure file
 * work and never throws (every step is swallowed — diagnostics only).
 */
export function writeLargestPlanPayload(dir: string, data: PlanPayloadDump): void {
  const agentId = data.agentId ?? 'unknown';
  const body = JSON.stringify({
    messages: data.messages,
    tools: data.tools,
    systemPrompt: data.systemPrompt,
    perceptionContext: data.perceptionContext,
    agentId,
  });
  const file = join(dir, `plan-payload-${agentId}.json`);

  let existing = 0;
  try {
    if (existsSync(file)) {
      existing = readFileSync(file, 'utf8').length;
    }
  } catch {
    existing = 0;
  }
  if (body.length <= existing) return;

  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, body);
  } catch {
    // diagnostics only — never break a plan request over a dump.
  }
}
