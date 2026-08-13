# Feature: Error Recovery and Edge Cases in the PPER Loop

## Context
- Architecture: [§6 — PPER Loop](../architecture/06-pper-loop.md), [§9 — Engine Routing](../architecture/09-engine-routing.md) (is_thinking, async, feedback), [§10 — Cognitive Guardrails](../architecture/10-cognitive-guardrails.md), [§3 — Agent State Schema](../architecture/03-agent-state-schema.md) (drives 0–100)
- Related specs: [001 — Perceive Phase](001-perceive-phase.md), [002 — Plan Phase](002-plan-phase.md), [003 — Execute Phase](003-execute-phase.md), [004 — Reflect Phase](004-reflect-phase.md), [005 — Game Loop Integration](005-game-loop-integration.md), [006 — OpenAI-Compatible LLM Client](006-openai-compatible-llm-client.md)
- Package: `shared`, `engine`, `cognition`
- Issue: [#23](https://github.com/Redna/evol-hive/issues/23)

## Requirements

### LLM Timeout & Unreachable (Retry with Backoff, Skip Cycle)

1. **Cycle-level retry with backoff** — The PPER orchestrator must retry a failed phase up to `PPERErrorConfig.maxPhaseRetries` times (default: 3) before abandoning the cycle. The retry delay must follow exponential backoff: `baseRetryDelayMs * 2^attempt` (default base: 500ms). Only transient errors (`LLMTimeoutError`, `LLMHTTPError` with 5xx status, network/connection errors) are retried. Permanent errors (`LLMResponseError`, validation failures, `LLMRateLimitError` after exhaustion) are not retried — the cycle is skipped immediately. *(Issue: "LLM timeout or unreachable")*

2. **Skip cycle on exhausted retries** — When all retry attempts for a phase are exhausted, the orchestrator must abort the cycle (skip remaining phases), reset `isThinking` to `false`, and set system feedback on the agent: `"LLM unreachable after N attempts — skipping cycle"`. The next tick's scheduler will naturally retry from the Perceive phase. *(Issue: "retry with backoff, skip cycle")*

3. **LLM unreachable detection** — The `OpenAICompatibleLLMClient` already throws `LLMError` for non-abort fetch failures and `LLMTimeoutError` for timeouts. The orchestrator must classify these as transient (retryable) errors. `LLMHTTPError` with status 5xx is transient; with 4xx (except 429, handled separately) is permanent. *(Issue: "LLM timeout or unreachable")*

### LLM Returns Invalid JSON (Parse Error Recovery)

4. **Invalid JSON response recovery** — When the LLM returns content that fails JSON parsing or schema validation (`LLMResponseError`), the orchestrator must retry the LLM call up to `maxPhaseRetries` times. On each retry, the system prompt must be augmented with a correction directive: `"Your previous response was not valid JSON. Please respond with valid JSON matching the required schema."` If all retries are exhausted, the cycle is skipped with system feedback: `"LLM returned invalid JSON after N attempts — skipping cycle"`. *(Issue: "LLM returns invalid JSON")*

5. **Partial JSON tolerance** — If the LLM returns valid JSON with missing optional fields (e.g., `memoryEntry` is missing from a Reflect response), this is NOT an error — the existing phase services already handle optional fields gracefully. Only structural failures (non-JSON, missing required fields, wrong types) trigger the retry path. *(Issue: "LLM returns invalid JSON")*

### Plan Fails (No Steps, Invalid Affordance Reference)

6. **Empty plan detection** — When the Plan service's LLM call succeeds but the response has zero steps or an empty description, the `PlanServiceImpl` already returns `success: false`. The orchestrator must treat this as a permanent error (no retry of the LLM call) and set system feedback: `"LLM produced an empty plan — forcing re-plan next cycle"`. The agent's `currentPlan` must remain `null` so the next cycle re-enters the Plan phase. *(Issue: "Plan fails — no steps")*

7. **Invalid affordance reference in plan step** — When the Execute phase resolves a `targetAffordance` that does not exist in the agent's current room, the `ExecuteServiceImpl` already sets system feedback and returns `success: false`. The orchestrator must handle this by aborting the cycle and clearing the plan (`currentPlan = null`) so the next cycle re-plans from scratch. The system feedback must include the invalid affordance name and the available affordances in the room: `"Plan step references '{affordance}' which is not available in room '{room}'. Available: [{list}]. Re-planning required."` *(Issue: "Plan fails — invalid affordance reference")*

8. **Plan with all non-physical steps** — If a plan consists entirely of steps with no `targetAffordance` (all cognitive/non-physical steps), the Execute phase must advance through all of them and report `planComplete: true` without error. This is a valid plan, not a failure. *(Edge case clarification)*

### No Available Affordances in Room (Agent Stuck)

9. **Stuck detection** — The PPER orchestrator must track consecutive failed cycles per agent. If an agent fails to make progress for `PPERErrorConfig.maxStuckCycles` consecutive cycles (default: 5), the orchestrator must inject an "unstuck" directive into the next Plan phase's system prompt: `"You have been unable to make progress for {N} cycles. Consider: (1) moving to a different room, (2) using query_memory for relevant memories, (3) updating your goal. You must try a different approach."` *(Issue: "No available affordances in room — agent stuck")*

10. **Empty room affordance handling** — When the Perceive phase detects zero affordances in the agent's room (the `prunedAffordances` array is empty), the perception result must include a flag `noAffordancesAvailable: true`. The Plan phase must receive this flag in its context and the system prompt must instruct the agent: `"No actions are available in this room. You should consider moving to another room or exploring."` *(Issue: "No available affordances in room")*

11. **Stuck counter reset** — The consecutive-failure counter must reset to 0 whenever a cycle completes successfully (any phase succeeds and the full cycle runs to completion). *(Issue: "No available affordances in room — agent stuck")*

### Agent Drives at Edge States (All 0 or All 100)

12. **All-drives-zero detection** — When all five drives are at 0 (all critically urgent), the `DriveSystem.getPrimaryDriveLabel` must return a composite label: `"all drives critical — survival mode"` instead of picking one arbitrary drive. This signals the LLM that the agent is in an emergency state. *(Issue: "Agent drives all at 0")*

13. **All-drives-100 detection** — When all five drives are at 100 (all fully satisfied), the `DriveSystem.getPrimaryDriveLabel` must return: `"all drives satisfied — explore or socialize"`. This signals the LLM that the agent has no urgent needs and should pursue non-survival goals. *(Issue: "Agent drives all at 100")*

14. **Drive clamping safety** — The existing `clampDrive` function already ensures drives stay within [0, 100]. No changes needed to clamping, but the engine must verify that drive changes from affordance results and reflect overrides are always clamped before application. *(Issue: "Agent drives all at 0 or 100 — edge states")*

### PPER Cycle Longer Than One Tick (Scheduler Must Not Re-trigger)

15. **Re-trigger prevention** — The `PPERScheduler` already checks `isThinking === false` before starting a cycle, and sets `isThinking = true` synchronously before the async cycle begins. This prevents re-triggering within the same tick. The scheduler must also verify that `activeCycles < maxConcurrentCycles` before starting any new cycle. No new cycle is started for an agent whose cycle is still in flight. *(Issue: "PPER cycle longer than one tick")*

16. **Phase tracking for in-flight detection** — The `PPEROrchestratorImpl.getPhase(agentId)` must return a non-`'perceive'` phase while a cycle is in flight (it currently does). The scheduler may optionally use this as a secondary guard: if `getPhase(agentId) !== 'perceive'`, skip starting a new cycle even if `isThinking` is somehow `false` (defensive double-check). *(Issue: "PPER cycle longer than one tick")*

17. **Orphaned cycle recovery** — If a PPER cycle promise is still in flight when the engine shuts down (`GameLoopImpl.stop()`), the orchestrator must not leave the agent in a permanently `isThinking = true` state. The scheduler's `finally` block already resets `isThinking`. Additionally, the orchestrator must support a `cancelCycle(agentId)` method that sets the agent's phase back to `'perceive'` and signals the in-flight cycle to abort at the next phase boundary (cooperative cancellation, not hard abort). *(Issue: "PPER cycle longer than one tick — scheduler must not re-trigger")*

### Integration: Kill LLM Mid-Cycle Recovery

18. **LLM failure mid-cycle recovery** — An integration test must verify that when the LLM client throws an error (simulating a killed/unreachable LLM) during the Plan or Reflect phase, the orchestrator retries, exhausts retries, skips the cycle, resets `isThinking`, and the agent successfully completes a new cycle on a subsequent tick once the LLM recovers. *(Issue: "Integration test: kill LLM mid-cycle, verify agent recovers")*

### Configuration

19. **`PPERErrorConfig` type** — Define a new interface in `packages/shared/src/types/engine.ts`:
    ```typescript
    interface PPERErrorConfig {
      maxPhaseRetries: number;      // default 3
      baseRetryDelayMs: number;     // default 500
      maxStuckCycles: number;       // default 5
    }
    ```
    The orchestrator must accept this config and use it for all retry/stuck-detection logic. *(Cross-cutting)*

20. **Default config factory** — Provide `defaultPPERErrorConfig()` in `@evol-hive/shared` returning `{ maxPhaseRetries: 3, baseRetryDelayMs: 500, maxStuckCycles: 5 }`. Environment variable overrides: `PPER_MAX_PHASE_RETRIES`, `PPER_BASE_RETRY_DELAY_MS`, `PPER_MAX_STUCK_CYCLES`. *(Cross-cutting)*

## Acceptance Criteria

- [ ] **AC-1**: When the LLM client throws `LLMTimeoutError` during the Plan phase, the orchestrator retries the Plan phase up to `maxPhaseRetries` (3) times with exponential backoff (500ms, 1000ms, 2000ms). If all retries fail, the cycle is skipped, `isThinking` is `false`, and system feedback contains `"LLM unreachable after 3 attempts — skipping cycle"`. *(Req 1, Req 2)*
- [ ] **AC-2**: When the LLM client throws `LLMHTTPError` with status 503, the orchestrator retries (transient). When the LLM client throws `LLMHTTPError` with status 400, the orchestrator does not retry (permanent) and skips the cycle immediately. *(Req 1, Req 3)*
- [ ] **AC-3**: When the LLM returns invalid JSON (non-parseable content), the orchestrator retries with a correction directive in the system prompt. After exhausting retries, system feedback contains `"LLM returned invalid JSON after 3 attempts — skipping cycle"`. *(Req 4)*
- [ ] **AC-4**: When the LLM returns valid JSON with missing optional fields (e.g., no `memoryEntry` in Reflect), no error is raised and the cycle proceeds normally. *(Req 5)*
- [ ] **AC-5**: When the Plan phase returns `success: false` with an empty plan (zero steps), the orchestrator does not retry the LLM, skips the cycle, sets system feedback `"LLM produced an empty plan — forcing re-plan next cycle"`, and `currentPlan` remains `null`. *(Req 6)*
- [ ] **AC-6**: When the Execute phase fails because `targetAffordance` is not found in the room, the orchestrator clears `currentPlan` to `null`, sets system feedback listing the invalid affordance and available affordances, and the cycle is aborted. The next cycle re-enters the Plan phase. *(Req 7)*
- [ ] **AC-7**: When a plan has all non-physical steps (no `targetAffordance`), the Execute phase advances through all steps and reports `planComplete: true` without error. *(Req 8)*
- [ ] **AC-8**: When an agent fails to make progress for `maxStuckCycles` (5) consecutive cycles, the next Plan phase's system prompt includes the "unstuck" directive mentioning the stuck count and suggesting move/query_memory/update_goal. *(Req 9)*
- [ ] **AC-9**: When the Perceive phase detects zero affordances in the room, `PerceptionResult` includes `noAffordancesAvailable: true`, and the Plan phase's system prompt instructs the agent to consider moving or exploring. *(Req 10)*
- [ ] **AC-10**: The stuck counter resets to 0 when a full PPER cycle completes successfully. *(Req 11)*
- [ ] **AC-11**: When all five drives are at 0, `DriveSystem.getPrimaryDriveLabel` returns `"all drives critical — survival mode"`. *(Req 12)*
- [ ] **AC-12**: When all five drives are at 100, `DriveSystem.getPrimaryDriveLabel` returns `"all drives satisfied — explore or socialize"`. *(Req 13)*
- [ ] **AC-13**: Drive values are always clamped to [0, 100] after applying drive changes from affordance results and reflect overrides. *(Req 14)*
- [ ] **AC-14**: The `PPERScheduler` does not start a new cycle for an agent with `isThinking === true`. When `activeCycles >= maxConcurrentCycles`, no new cycles start. *(Req 15)*
- [ ] **AC-15**: When `getPhase(agentId)` returns a non-`'perceive'` phase, the scheduler skips starting a new cycle for that agent (defensive double-check). *(Req 16)*
- [ ] **AC-16**: `PPEROrchestratorImpl.cancelCycle(agentId)` sets the agent's phase to `'perceive'` and the in-flight cycle aborts at the next phase boundary (no further phases execute). *(Req 17)*
- [ ] **AC-17**: Integration test: LLM throws during Plan phase → orchestrator retries → exhausts → skips cycle → `isThinking = false` → LLM recovers → next tick's scheduler starts a new cycle → cycle completes successfully. *(Req 18)*
- [ ] **AC-18**: `PPERErrorConfig` is defined in `packages/shared/src/types/engine.ts` with `maxPhaseRetries`, `baseRetryDelayMs`, and `maxStuckCycles` fields. *(Req 19)*
- [ ] **AC-19**: `defaultPPERErrorConfig()` returns `{ maxPhaseRetries: 3, baseRetryDelayMs: 500, maxStuckCycles: 5 }` and respects environment variables `PPER_MAX_PHASE_RETRIES`, `PPER_BASE_RETRY_DELAY_MS`, `PPER_MAX_STUCK_CYCLES`. *(Req 20)*
- [ ] **AC-20**: Unit test: LLM timeout during Plan → retry with backoff → eventually succeeds on 2nd attempt → cycle completes. *(Req 1)*
- [ ] **AC-21**: Unit test: LLM returns non-JSON string during Reflect → retry with correction directive → eventually returns valid JSON → cycle completes. *(Req 4)*
- [ ] **AC-22**: Unit test: Agent in room with zero affordances for 5 consecutive cycles → 6th cycle's Plan prompt includes "unstuck" directive. *(Req 9, Req 10)*

## Constraints

- **Package boundaries** (per ADR-0001): `engine` and `cognition` must not directly import from each other. New error config types go in `@evol-hive/shared`. The orchestrator (cognition) uses the config via injection. The scheduler (engine) uses `PPEROrchestratorPort` from shared.
- **No blocking in the game loop**: Retry backoff delays (`await sleep(delay)`) happen inside the async PPER cycle promise, never in the synchronous game loop tick. The scheduler fires-and-forgets the cycle; retries are internal to the cycle. *(§9.1)*
- **Preserve existing phase service interfaces**: The `PlanServiceImpl`, `ExecuteServiceImpl`, `ReflectServiceImpl`, and `PerceptionServiceImpl` APIs must not change. Retry logic wraps around the existing phase service calls in the orchestrator. The phase services already catch errors and return `success: false`; the orchestrator adds retry on top.
- **isThinking is the safety net**: After any error path — exhausted retries, permanent failure, stuck detection — `isThinking` must be `false`. This is already guaranteed by the phase services' `finally` blocks and the scheduler's `finally` block. New code paths must not break this invariant.
- **Drive clamping is unchanged**: The existing `clampDrive(0–100)` logic in `DriveSystemImpl` is correct. Edge-state handling (Req 12–13) only changes the *label* returned by `getPrimaryDriveLabel`, not the clamping behavior.
- **`PerceptionResult` extension**: Adding `noAffordancesAvailable: boolean` to `PerceptionResult` is a backward-compatible change — existing consumers ignore unknown fields. The `PlanBuilder` must check this flag and augment the system prompt accordingly.
- **Retry only LLM-dependent phases**: Only the Plan and Reflect phases (which call the LLM) are retryable. Perceive (passive, no LLM) and Execute (deterministic engine) are not retried — their failures are permanent within a cycle.
- **What NOT to do**:
  - Do not implement hard cancellation (AbortController on the fetch) for `cancelCycle` — use cooperative cancellation at phase boundaries.
  - Do not add retry logic inside the `OpenAICompatibleLLMClient` for non-429 errors — the client already handles 429 retries. Cycle-level retry is the orchestrator's responsibility.
  - Do not change the `isThinking` invariant or the `finally`-block pattern in phase services.
  - Do not add new engine systems — error recovery lives in the orchestrator and drive system, not as new loop-registered systems.
  - Do not implement agent pathfinding or room-graph traversal — the "move to another room" suggestion is an LLM instruction, not automatic teleportation.
