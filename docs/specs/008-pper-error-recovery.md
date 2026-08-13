# Feature: PPER Loop Error Recovery & Edge Cases

## Context
- Architecture: [§6 — PPER Loop](../architecture/06-pper-loop.md), [§9 — Engine Routing](../architecture/09-engine-routing.md), [§10 — Cognitive Guardrails](../architecture/10-cognitive-guardrails.md), [§7 — Structured Outputs](../architecture/07-structured-outputs.md), [§3 — Agent State Schema](../architecture/03-agent-state-schema.md)
- Related specs: [001 — Perceive Phase](001-perceive-phase.md), [002 — Plan Phase](002-plan-phase.md), [003 — Execute Phase](003-execute-phase.md), [004 — Reflect Phase](004-reflect-phase.md), [005 — Game Loop Integration](005-game-loop-integration.md), [006 — OpenAI-Compatible LLM Client](006-openai-compatible-llm-client.md)
- Package: `shared`, `engine`, `cognition`
- Issue: [#23](https://github.com/Redna/evol-hive/issues/23)

## Background

The PPER loop (specs 001–005) has basic error handling: each phase service catches exceptions and returns `{ success: false }`, and the `PPERScheduler` catches uncaught rejections and resets `isThinking`. However, several real-world error paths lack systematic handling, retry logic, or edge-case detection. This spec hardens the PPER loop against six categories of failures identified in issue #23.

## Current State Summary

| Error Case | Current Handling | Gap |
|---|---|---|
| LLM timeout / unreachable | `OpenAICompatibleLLMClient` has `AbortController` timeout → `LLMTimeoutError`. No retry on timeout (only 429 retried). | No retry-with-backoff for timeout/connection errors at LLM client level. No orchestrator-level skip-cycle-after-N-failures. |
| Invalid JSON from LLM | `OpenAICompatibleLLMClient` throws `LLMResponseError` on parse failure. `PlanServiceImpl` and `ReflectServiceImpl` validate and return `success: false`. | No circuit-breaker for repeated LLM failures. Orchestrator silently retries every tick. |
| Plan fails (no steps, invalid affordance) | `PlanServiceImpl` validates steps. `ExecuteServiceImpl` handles missing affordance, missing plan, missing step. | No plan-invalidation feedback to LLM context. No consecutive-failure counter. |
| No available affordances in room | `PerceptionServiceImpl` returns empty `prunedAffordances`. `PlanServiceImpl` sends to LLM with empty affordance list. | No explicit "stuck" detection. Agent keeps cycling with no actionable options. |
| Agent drives all at 0 or 100 | `DriveSystemImpl` clamps to 0–100. `getPrimaryDrive` picks lowest. | No saturation detection — agent stuck if all drives at 0 (all equally urgent, ambiguous). No "satisfied" state if all at 100. |
| PPER cycle longer than one tick | `isThinking` gate in `PPERScheduler` prevents re-trigger. | `isThinking` is set by `PlanServiceImpl`/`ReflectServiceImpl` — not at cycle start. Gap between scheduler setting `isThinking=true` and phase service setting it means re-trigger is possible in the gap. |

## Requirements

### 1. LLM Retry with Backoff (Cognition Layer)

1.1. **Retry on timeout and connection errors** — The `OpenAICompatibleLLMClient` must retry on `LLMTimeoutError` and network-level fetch failures (not just HTTP 429), using the existing exponential backoff mechanism (`retryDelayMs * 2^(attempt-1)`). The retry loop in `requestChat()` must catch `LLMTimeoutError` and non-Abort fetch errors, retry up to `maxRetries` times, and only throw after all retries are exhausted.

1.2. **Configurable retry for timeout vs. rate-limit** — Add optional config field `retryOnTimeout` (default: `true`) to `OpenAICompatibleLLMClientConfig`. When `false`, timeout errors are thrown immediately without retry (useful for real-time systems where latency matters more than eventual success).

1.3. **Error classification propagation** — The LLM client's typed errors (`LLMTimeoutError`, `LLMHTTPError`, `LLMRateLimitError`, `LLMResponseError`, `LLMError`) must be exported from `@evol-hive/cognition` so the orchestrator and phase services can catch specific error types.

### 2. PPER Cycle Failure Tracking (Cognition Layer — Orchestrator)

2.1. **Cycle failure counter** — The `PPEROrchestratorImpl` must track consecutive cycle failures per agent via a `consecutiveFailures` map. On any phase returning `{ success: false }`, the counter increments. On a successful full cycle, the counter resets to 0.

2.2. **Skip cycle after threshold** — When `consecutiveFailures` for an agent reaches `maxConsecutiveFailures` (configurable, default: 3), the orchestrator's `runCycle()` must skip the cycle immediately (return without executing any phase) and set a `cycleSkipped` flag. The counter does not increment during skip — it resets only on a successful cycle. The agent remains available for the next scheduler tick, but the orchestrator will keep skipping until a manual reset or a configurable cooldown period elapses.

2.3. **Cooldown timer** — After reaching `maxConsecutiveFailures`, the orchestrator must enforce a cooldown period (`failureCooldownMs`, default: 5000ms) during which `runCycle()` returns early for that agent. After the cooldown expires, the next `runCycle()` attempt resets the failure counter to 0 and proceeds normally.

2.4. **Cycle status accessor** — Add `getCycleStatus(agentId): PPERCycleStatus` to the orchestrator, returning `{ consecutiveFailures: number; coolingDown: boolean; lastError?: string }`. This allows the engine/monitoring to observe error state without coupling.

2.5. **PPERCycleStatus type** — Define `PPERCycleStatus` in `@evol-hive/shared` with fields: `{ consecutiveFailures: number; coolingDown: boolean; lastError?: string }`.

### 3. Invalid JSON / Parse Error Recovery (Cognition Layer)

3.1. **LLMResponseError handling in phase services** — The `PlanServiceImpl` and `ReflectServiceImpl` already catch all errors in their try/catch blocks and return `{ success: false, error: message }`. This behavior is confirmed and must be preserved. No code change needed — the requirement is to verify and test it explicitly.

3.2. **Distinguish parse errors from transient errors** — When the phase service catches an `LLMResponseError` (invalid JSON / schema violation), the error message must be prefixed with `"LLM response error: "` so the orchestrator's failure tracking can distinguish persistent LLM-quality issues from transient network issues. This is a presentation/logging concern — the failure counter treats both equally for now.

### 4. Plan Failure Recovery (Cognition + Engine Layer)

4.1. **No active plan → graceful skip** — When `ExecuteServiceImpl.execute()` returns `{ success: false, error: 'No active plan', planComplete: true }`, the orchestrator must not count this as a failure (it is an expected state, not an error). The cycle completes normally and the agent waits for the next Perceive→Plan cycle.

4.2. **Invalid affordance reference feedback** — When the Execute phase fails because the plan references an affordance not available in the current room, the existing `setSystemFeedback` mechanism injects a message into the next Perceive phase (already implemented in `ExecuteServiceImpl`). This spec requires verifying the feedback is present in the next perception snapshot and that the Plan phase receives it.

4.3. **Plan with zero steps** — The `PlanServiceImpl` already validates that `steps` is a non-empty array via `isValidFormulatePlanResult()`. This must be preserved and tested. If the LLM returns a plan with zero steps, the Plan phase returns `{ success: false, error: 'LLM returned an invalid plan: missing description or steps' }`.

### 5. No Available Affordances — Agent Stuck Detection (Cognition Layer)

5.1. **Empty affordance detection** — The `PerceptionServiceImpl` must detect when `prunedAffordances` is empty (no actionable affordances in the room). When this occurs, the PerceptionResult must include a flag `stuck: true`.

5.2. **Stuck flag in PerceptionResult** — Add optional field `stuck?: boolean` to the `PerceptionResult` type in `@evol-hive/shared`. When `true`, the Plan phase can inject a contextual forcing directive (per §10 Guardrail 2) telling the LLM: "No physical actions are available in this room. Consider using a cognitive tool or moving to another room."

5.3. **Stuck directive in PlanBuilder** — The `PlanBuilderImpl` (or `PerceptionBuilderImpl` — whichever builds the LLM context for the Plan phase) must append a directive to `perceptionContext` when `perceptionResult.stuck === true`: `"\n\nWARNING: No physical actions are available in this room. You may need to move or use a cognitive tool."`.

5.4. **Stuck does not fail the cycle** — An empty affordance list is not an error — it is a valid environmental state. The PPER cycle must complete normally. The orchestrator's failure counter must NOT increment on a stuck cycle.

### 6. Drive Edge States (Shared + Engine Layer)

6.1. **Saturation detection** — Add a utility function `detectDriveEdgeState(drives: AgentDrives): 'all-zero' | 'all-full' | null` to `@evol-hive/shared`. Returns `'all-zero'` when all five drives are at 0, `'all-full'` when all are at 100, and `null` otherwise.

6.2. **All-zero handling** — When all drives are at 0, the primary drive selection is ambiguous (all equally urgent). The `getPrimaryDriveLabel` must detect this and return a special label: `"All drives critically low — agent is in crisis state"`. This gives the LLM clear context to prioritize survival.

6.3. **All-full handling** — When all drives are at 100, the agent has no urgent needs. The `getPrimaryDriveLabel` must return: `"All drives satisfied — agent is content"`. This allows the LLM to choose curiosity-driven or social actions rather than survival actions.

6.4. **Drive edge states do not fail the cycle** — Edge states are valid agent states, not errors. The PPER cycle completes normally. No failure counter increment.

### 7. PPER Cycle Re-trigger Prevention (Engine Layer)

7.1. **Cycle-in-progress flag** — The `PPERScheduler` already sets `isThinking = true` synchronously in `startCycle()` before firing the async `runCycle()` promise. This is the primary gate against re-triggering. This behavior must be preserved and tested explicitly.

7.2. **Active cycle tracking** — The `PPERScheduler` already tracks `activeCycles` count and checks `agent.isThinking` before starting a new cycle. This dual-gate (count limit + per-agent flag) prevents re-trigger. This behavior must be preserved and tested.

7.3. **Orchestrator never re-enters** — The `PPEROrchestratorImpl.runCycle()` is not re-entrant for the same agent — the scheduler will not call it again while `isThinking` is true. This is guaranteed by Req 7.1. No additional lock is needed, but a test must verify that a slow cycle does not cause a second concurrent `runCycle()` for the same agent.

7.4. **Cleanup on uncaught rejection** — The `PPERScheduler.startCycle()` `.catch().finally()` chain already guarantees `isThinking` is reset to `false` and `activeCycles` is decremented regardless of success/failure. This must be preserved and tested for the "kill LLM mid-cycle" integration scenario.

### 8. Orchestrator Error Configuration (Shared Layer)

8.1. **PPERErrorConfig type** — Define `PPERErrorConfig` in `@evol-hive/shared` with fields: `{ maxConsecutiveFailures: number; failureCooldownMs: number }`. Defaults: `{ maxConsecutiveFailures: 3, failureCooldownMs: 5000 }`.

8.2. **Default factory** — Provide `defaultPPERErrorConfig()` in `@evol-hive/shared` returning the defaults above, overridable via env vars `PPER_MAX_CONSECUTIVE_FAILURES` and `PPER_FAILURE_COOLDOWN_MS`.

8.3. **Wiring into orchestrator** — The `PPEROrchestratorOptions` interface must accept an optional `errorConfig?: PPERErrorConfig`. When omitted, `defaultPPERErrorConfig()` is used.

### 9. Integration Testing

9.1. **Unit tests for each error path** — Each requirement above must have at least one unit test verifying the behavior in isolation. Tests must use mock LLM clients, mock data providers, and fake timers where needed.

9.2. **Integration test: kill LLM mid-cycle** — An integration test must simulate an LLM that throws mid-cycle (e.g., the `completePlan` promise rejects). The test must verify: (a) the game loop does not crash, (b) `isThinking` is reset to `false`, (c) the agent is available for a new cycle on the next tick, (d) the `consecutiveFailures` counter increments, (e) after `maxConsecutiveFailures`, the orchestrator enters cooldown.

9.3. **Integration test: agent recovers after cooldown** — After the cooldown period elapses, the agent must resume normal PPER cycles. The test must verify the failure counter resets to 0 on the first successful cycle post-cooldown.

## Acceptance Criteria

- [ ] **AC-1**: `OpenAICompatibleLLMClient.requestChat()` retries on `LLMTimeoutError` up to `maxRetries` times with exponential backoff, then throws `LLMTimeoutError`. *(Req 1.1)*
- [ ] **AC-2**: `OpenAICompatibleLLMClient.requestChat()` retries on non-Abort `fetch()` errors (connection refused, DNS failure) up to `maxRetries` times, then throws `LLMError`. *(Req 1.1)*
- [ ] **AC-3**: When `OpenAICompatibleLLMClientConfig.retryOnTimeout` is `false`, a timeout throws `LLMTimeoutError` immediately without retry. *(Req 1.2)*
- [ ] **AC-4**: `LLMTimeoutError`, `LLMHTTPError`, `LLMRateLimitError`, `LLMResponseError`, and `LLMError` are all exported from `@evol-hive/cognition` (re-exported from the llm module). *(Req 1.3)*
- [ ] **AC-5**: `PPEROrchestratorImpl` tracks `consecutiveFailures` per agent. A failed Plan phase increments the counter; a successful full cycle resets it to 0. *(Req 2.1)*
- [ ] **AC-6**: When `consecutiveFailures` reaches `maxConsecutiveFailures` (default 3), `runCycle()` returns immediately without executing any phase. *(Req 2.2)*
- [ ] **AC-7**: After `failureCooldownMs` (default 5000ms) elapses following threshold, the next `runCycle()` proceeds normally and resets the counter to 0. *(Req 2.3)*
- [ ] **AC-8**: `PPEROrchestratorImpl.getCycleStatus(agentId)` returns `{ consecutiveFailures, coolingDown, lastError? }`. `coolingDown` is `true` during the cooldown period. *(Req 2.4)*
- [ ] **AC-9**: `PPERCycleStatus` is defined in `@evol-hive/shared` with `{ consecutiveFailures: number; coolingDown: boolean; lastError?: string }`. *(Req 2.5)*
- [ ] **AC-10**: When `PlanServiceImpl` catches an `LLMResponseError`, the returned `error` message is prefixed with `"LLM response error: "`. Same for `ReflectServiceImpl`. *(Req 3.2)*
- [ ] **AC-11**: When `ExecuteServiceImpl` returns `{ success: false, error: 'No active plan', planComplete: true }`, the orchestrator does NOT increment `consecutiveFailures` — the cycle is treated as complete. *(Req 4.1)*
- [ ] **AC-12**: When the Execute phase fails due to missing affordance, the next `PerceptionResult.passive.systemFeedback` contains the failure message. *(Req 4.2)*
- [ ] **AC-13**: When the LLM returns a plan with zero steps, `PlanServiceImpl.plan()` returns `{ success: false, error: 'LLM returned an invalid plan: missing description or steps' }`. *(Req 4.3)*
- [ ] **AC-14**: When `prunedAffordances` is empty, `PerceptionResult.stuck` is `true`. When non-empty, `stuck` is `false` or `undefined`. *(Req 5.1)*
- [ ] **AC-15**: `PerceptionResult` in `@evol-hive/shared` has an optional `stuck?: boolean` field. *(Req 5.2)*
- [ ] **AC-16**: When `perceptionResult.stuck === true`, the LLM context payload's `perceptionContext` includes the warning directive about no physical actions available. *(Req 5.3)*
- [ ] **AC-17**: A cycle where `stuck === true` completes normally — `consecutiveFailures` does NOT increment. *(Req 5.4)*
- [ ] **AC-18**: `detectDriveEdgeState(drives)` returns `'all-zero'` when all 5 drives are 0, `'all-full'` when all are 100, `null` otherwise. *(Req 6.1)*
- [ ] **AC-19**: When all drives are 0, `getPrimaryDriveLabel` returns `"All drives critically low — agent is in crisis state"`. *(Req 6.2)*
- [ ] **AC-20**: When all drives are 100, `getPrimaryDriveLabel` returns `"All drives satisfied — agent is content"`. *(Req 6.3)*
- [ ] **AC-21**: The `PPERScheduler` sets `isThinking = true` synchronously before firing `runCycle()`. A second tick during a long cycle does not start a second `runCycle()` for the same agent. *(Req 7.1, 7.2, 7.3)*
- [ ] **AC-22**: When `runCycle()` rejects with an uncaught error, the `.catch().finally()` handler resets `isThinking = false` and decrements `activeCycles`. The game loop continues. *(Req 7.4)*
- [ ] **AC-23**: `PPERErrorConfig` is defined in `@evol-hive/shared` with `{ maxConsecutiveFailures: number; failureCooldownMs: number }`. *(Req 8.1)*
- [ ] **AC-24**: `defaultPPERErrorConfig()` returns `{ maxConcurrentFailures: 3, failureCooldownMs: 5000 }` by default, overridable via env vars. *(Req 8.2)*
- [ ] **AC-25**: `PPEROrchestratorOptions` accepts optional `errorConfig?: PPERErrorConfig`. When omitted, defaults are used. *(Req 8.3)*
- [ ] **AC-26**: Integration test: when `completePlan()` rejects mid-cycle, the game loop does not crash, `isThinking` resets to `false`, and the agent is available on the next tick. *(Req 9.2)*
- [ ] **AC-27**: Integration test: after `maxConsecutiveFailures` failed cycles, the orchestrator enters cooldown. After `failureCooldownMs`, a successful cycle resets the counter to 0. *(Req 9.2, 9.3)*

## Constraints

- **Package boundaries** (per ADR-0001): `engine` and `cognition` must not directly import from each other. New types (`PPERCycleStatus`, `PPERErrorConfig`) go in `@evol-hive/shared`. The orchestrator's failure tracking lives in `@evol-hive/cognition`. The scheduler's re-trigger prevention lives in `@evol-hive/engine`.
- **No blocking in the game loop**: All retry/backoff logic happens inside async phase service calls (which run in fired-and-forgotten promises). The game loop `update()` path remains fully synchronous.
- **Preserve existing error handling**: The existing try/catch/finally pattern in `PlanServiceImpl`, `ExecuteServiceImpl`, and `ReflectServiceImpl` must be preserved. This spec adds retry logic to the LLM client and failure tracking to the orchestrator — it does not restructure the phase services' error handling.
- **Stuck and edge states are not errors**: Empty affordances and drive saturation are valid environmental/agent states. They must not cause cycle failures or increment the failure counter. The LLM receives context hints, not error messages.
- **"No active plan" is not a failure**: When the Execute phase returns `planComplete: true` with no active plan, this is an expected state after plan completion or at cycle start. It is not counted as a failure.
- **What NOT to do**:
  - Do not add automatic agent movement or pathfinding — the "stuck" detection only provides context to the LLM; it does not move the agent.
  - Do not implement the full guardrail engine (§10) — only the contextual forcing directive for the stuck case.
  - Do not add circuit-breaking at the LLM client level — the circuit-breaker logic (cooldown) lives in the orchestrator, not the LLM client. The LLM client retries individual requests; the orchestrator manages cycle-level failure patterns.
  - Do not roll back partial Reflect updates on failure — the existing atomicity design (validation before any writes) is preserved.
  - Do not add a separate "cycle lock" or mutex — `isThinking` is the gate. The scheduler's synchronous `isThinking = true` before the async call is sufficient.
  - Do not modify the `GameLoopImpl` — all error recovery happens at the orchestrator and LLM client level. The game loop already handles the "cycle longer than one tick" case via `isThinking`.
