# YAAM Workspace: feature-008-pper-error-recovery

**Initialized:** 2025-01-15
**Task:** Draft spec for issue #23 — Error recovery and edge cases in the PPER loop
**Status:** Spec drafted

## Design Decisions

### Decision 1: Cycle-level retry lives in the orchestrator, not the LLM client
**Why:** The `OpenAICompatibleLLMClient` (spec 006) already handles 429 retries with exponential backoff. Non-429 errors (timeout, 5xx, network) are thrown immediately. Adding retry logic for these inside the client would mix HTTP-layer concerns with cycle-level concerns. The orchestrator has the context to decide whether to retry (based on error type) and whether to augment the system prompt (for invalid JSON recovery). Keeping retry at the cycle level preserves the single-responsibility principle.

### Decision 2: Only Plan and Reflect phases are retryable
**Why:** Perceive is passive (no LLM) and Execute is deterministic (engine only). Retrying these would just repeat the same deterministic computation. Only the LLM-dependent phases (Plan, Reflect) have transient failure modes worth retrying. This keeps the retry surface small and avoids unnecessary work.

### Decision 3: Cooperative cancellation instead of AbortController for cancelCycle
**Why:** The orchestrator runs phases sequentially. A `cancelCycle(agentId)` call can set a flag that the orchestrator checks between phases. Hard-aborting an in-flight fetch via AbortController would require threading the signal through the LLM client and phase services — invasive and unnecessary for the cooperative model. The next phase boundary check is sufficient since phases complete in seconds, not minutes.

### Decision 4: Stuck detection via consecutive-failure counter, not time-based
**Why:** Time-based stuck detection would require tracking wall-clock time per agent, which conflicts with the fixed-timestep simulation model. Cycle-count-based detection is deterministic and simpler: count consecutive cycles where any phase returned `success: false`. This aligns with the PPER model where the scheduler drives cycles at tick granularity.

### Decision 5: Edge-state drive labels are semantic hints, not behavioral changes
**Why:** When all drives are 0 or 100, the system prompt label changes to help the LLM make better decisions. We do NOT change drive decay rates, force actions, or override the LLM's autonomy. The agent might still choose to do nothing — that's valid. The label is a nudge, not a constraint. This respects the architecture's separation of deterministic state (drives) from non-deterministic cognition (LLM decisions).

### Decision 6: PPERErrorConfig in shared, not cognition
**Why:** The config is consumed by the orchestrator (cognition) but the scheduler (engine) may also need to know retry limits for logging/metrics. Placing it in `shared` follows the existing pattern (PPERSchedulerConfig, EngineConfig) and avoids cross-package imports.

### Decision 7: Invalid affordance reference clears the plan
**Why:** When a plan step references an affordance not in the room, the plan is stale/invalid. Rather than trying to skip the step (which could leave the agent in an inconsistent state), we clear the entire plan and let the next cycle re-plan from scratch. This is simpler and more robust than partial plan recovery. The system feedback tells the LLM what went wrong and what's available.

### Decision 8: noAffordancesAvailable flag on PerceptionResult
**Why:** Adding a boolean flag to the existing `PerceptionResult` interface is backward-compatible (existing code ignores unknown fields). The PlanBuilder can check this flag and augment the system prompt. This is cleaner than throwing an error or returning a different type for the empty-room case.

