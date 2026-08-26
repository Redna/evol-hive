# Feature: Performance Tuning — LLM Batching, Concurrent Agent Scheduling, Context Window Optimization, Caching

## Context
- Architecture: [§6 — PPER Loop](../architecture/06-pper-loop.md) (phase orchestration, context window), [§9 — Engine Routing](../architecture/09-engine-routing.md) (concurrency, is_thinking, async), [§11 — Memory Architecture](../architecture/11-memory-architecture.md) (memory injection, retrieval)
- Related specs: [005 — Game Loop Integration](005-game-loop-integration.md) (PPERScheduler, PPERSchedulerConfig, engine assembly), [006 — OpenAI-Compatible LLM Client](006-openai-compatible-llm-client.md) (LLM client, request/response), [008 — PPER Error Recovery](008-pper-error-recovery.md) (failure tracking, cycle status), [014 — Memory Consolidation](014-memory-consolidation-decay-retrieval.md) (memory injection, topK), [018 — Multi-Agent Social](018-multi-agent-social.md) (multi-agent scenes), [021 — KV Cache Prompt Optimization](021-kv-cache-prompt-optimization.md) (prompt stability, token savings)
- Package: `shared` (new types, config), `engine` (scheduler, assembly), `cognition` (batching, caching, token tracking, tool pruning, builders), `memory` (memory injection cap)
- Issue: [#91](https://github.com/Redna/evol-hive/issues/91)

## Problem Summary

With 3 agents, the simulation takes ~25 seconds per PPER cycle per agent (sequential). Multi-agent scenes are slow because agents process one at a time. The `PPERScheduler` already supports `maxConcurrentCycles` (default 8 via `ENGINE_MAX_CONCURRENT_LLM`), but this is a global env-var — not configurable per scene. Additionally, each agent triggers a separate LLM call per phase even when agents share the same room and drive state. There is no token usage measurement, no response caching, and no per-phase tool pruning.

This spec addresses four areas: (1) per-scene concurrent scheduling, (2) LLM request batching for the Plan phase, (3) context window optimization, and (4) response/affordance/persona caching.

## Requirements

### 1. Per-Scene Concurrent Agent Scheduling

### Req 1 — Add optional `maxConcurrentCycles` to `SceneDefinition`
The `SceneDefinition` interface in `packages/shared/src/types/world.ts` must accept an optional `maxConcurrentCycles?: number` field. When present, this value overrides the global `ENGINE_MAX_CONCURRENT_LLM` env var for the `PPERScheduler` used by that scene's engine. When absent, the existing env-var default (8) is used.

### Req 2 — `assembleGameLoop` accepts scheduler config override
The `assembleGameLoop` function in `packages/engine/src/assembly.ts` must accept an optional `schedulerConfig?: PPERSchedulerConfig` parameter. When provided, this config is passed to the `PPERScheduler` constructor instead of `defaultPPERSchedulerConfig()`. The `loadScene` function must extract `maxConcurrentCycles` from the `SceneDefinition` and pass it through as a `PPERSchedulerConfig` override.

### Req 3 — `createEngine` propagates scene-level concurrency
The `createEngine` factory must accept an optional `schedulerConfig?: PPERSchedulerConfig` parameter and forward it to `assembleGameLoop`. This allows the entry point to set concurrency per scene without modifying env vars.

### Req 4 — Default concurrency remains 1 for single-model Ollama
The `defaultPPERSchedulerConfig()` function must default `maxConcurrentCycles` to `Number(process.env['ENGINE_MAX_CONCURRENT_LLM'] ?? 1)` (changed from 8 to 1). This protects single-model Ollama setups from quota-limited concurrent requests. Multi-model or self-hosted setups can override via env var or per-scene config.

### 2. LLM Request Batching

### Req 5 — `BatchPlanService` for multi-agent plan formulation
A new `BatchPlanService` class in `packages/cognition/src/pper/batch-plan-service.ts` must batch the Plan phase for multiple agents in the same room into a single LLM call. It collects `PerceptionResult` objects from agents sharing a room, constructs a multi-agent prompt listing each agent's perception context, sends one `completePlan` call with a multi-agent tool schema, and parses the response into per-agent `FormulatePlanResult` objects.

### Req 6 — Multi-agent plan prompt construction
The `BatchPlanService` must build a prompt that concatenates each agent's stable perception context (room, objects, drives) with a clear delimiter between agents. The system prompt must instruct the LLM to formulate a plan for each agent. The tool schema must use a `multi_agent_plans` tool that accepts an array of `{ agentId, description, steps[] }` objects.

### Req 7 — Batch size limit
The `BatchPlanService` must accept a `maxBatchSize` config parameter (default: 5). When more agents than `maxBatchSize` share a room, they are split into multiple batches of at most `maxBatchSize` agents each.

### Req 8 — Batch fallback to individual calls
If the LLM response from a batched call cannot be parsed into per-agent plans (missing agent, invalid steps), the `BatchPlanService` must fall back to individual `PlanService.plan()` calls for the affected agents. This guarantees no agent is left without a plan due to batching errors.

### Req 9 — Batching is opt-in
The `PPEROrchestratorImpl` must accept an optional `batchPlanService?: BatchPlanService` in its options. When absent, the orchestrator uses the existing per-agent `PlanService` — no behavior change. When present, the orchestrator collects perception results for agents in the same room and delegates to `BatchPlanService.batchPlan()` instead of calling `PlanService.plan()` per agent.

### 3. Context Window Optimization

### Req 10 — Token usage measurement and reporting
The `OpenAICompatibleLLMClient` must capture the `usage` field from the OpenAI API response envelope (`usage.prompt_tokens`, `usage.completion_tokens`, `usage.total_tokens`) and return it alongside the parsed result. A new `TokenUsageReport` type in `@evol-hive/shared` must store `{ promptTokens, completionTokens, totalTokens, agentId?, phase?, tickNumber? }`. A `TokenUsageReporter` class in `packages/cognition/src/llm/token-usage-reporter.ts` must aggregate reports per tick and expose `getTickUsage(tickNumber)` and `getTotalUsage()`.

### Req 11 — Phase-aware tool pruning
The `PlanBuilderImpl` must exclude cognitive tools not relevant to the Plan phase. Specifically, `observe_agent`, `talk_to`, `help`, and `ignore` social tools must only be included when agents are present (already done). Additionally, the `PerceptionBuilderImpl` must exclude `formulatePlanTool` when the agent already has an active plan (to reduce tool definition tokens). The tool list sent to the LLM must be the minimal set required for the current phase + context.

### Req 12 — Drive history compression
The `ReflectDataProviderImpl` (or the reflect builder) must compress drive change history to show only the last 3 changes per drive instead of the full history. A `maxDriveHistoryEntries` config parameter (default: 3) controls this. The full history remains in internal state — only the LLM-visible context is compressed.

### Req 13 — Memory injection top-K cap
The `MemoryInjectorImpl.injectAssociative()` method must accept a configurable `topK` parameter (default: 3, down from current hardcoded 5). This is configurable via a new `MemoryInjectionConfig` type in `@evol-hive/shared` with `{ topK: number }` and via env var `MEMORY_INJECTION_TOP_K` (default: 3). This caps the number of memories injected into the perception context window.

### 4. Caching

### Req 14 — LLM response cache for identical prompts
An `LLMResponseCache` class in `packages/cognition/src/llm/response-cache.ts` must cache LLM responses keyed on a hash of `(systemPrompt + perceptionContext + tools)`. The cache has a configurable TTL (default: 1 tick / 16.67ms at 60 FPS, configurable via `LLM_CACHE_TTL_MS` env var). On a cache hit, the cached `LLMActionResponse` or `FormulatePlanResult` is returned without an LLM call. The cache is opt-in — when no `LLMResponseCache` instance is wired into the LLM client, behavior is unchanged.

### Req 15 — Affordance resolution cache
An `AffordanceResolutionCache` class in `packages/engine/src/world/affordances/cache.ts` must cache the mapping from `roomId` to available affordance tool definitions. The cache is invalidated when any smart object in the room changes state (via a state-change callback). This avoids recomputing affordance tool definitions for rooms that haven't changed.

### Req 16 — Persona formatting cache
The `formatPersona()` function in `@evol-hive/shared` must memoize its output per `AgentProfile` reference. Since persona text is stable per agent (spec 021, Req 6), the formatted string should be computed once and reused. This is a simple `Map<AgentProfile, string>` or `WeakMap` — no TTL needed.

### 5. Cross-Cutting

### Req 17 — All features are opt-in and backward compatible
Every feature in this spec must be disabled by default. The existing behavior (sequential per-agent PPER cycles, no batching, no caching, no token tracking) must be the default when no new config is provided. All existing tests must pass without modification.

### Req 18 — All existing tests pass
No existing test may be broken by this spec. New tests must be added for each feature. When `maxConcurrentCycles` default changes from 8 to 1, tests that explicitly set `maxConcurrentCycles` must continue to work. Tests that rely on the default of 8 must be updated to explicitly set `maxConcurrentCycles: 8`.

## Acceptance Criteria

- [ ] **AC-1** (Req 1, Req 2): `SceneDefinition` accepts optional `maxConcurrentCycles?: number`. When a scene defines `maxConcurrentCycles: 3`, the `PPERScheduler` constructed for that scene's engine has `maxConcurrent` set to 3, regardless of the `ENGINE_MAX_CONCURRENT_LLM` env var.
- [ ] **AC-2** (Req 2, Req 3): `createEngine(config, orchestrator, memoryStore?, vectorStore?, schedulerConfig?)` accepts an optional `schedulerConfig` and forwards it to `assembleGameLoop`. When omitted, `defaultPPERSchedulerConfig()` is used.
- [ ] **AC-3** (Req 4): `defaultPPERSchedulerConfig()` returns `maxConcurrentCycles: 1` when `ENGINE_MAX_CONCURRENT_LLM` is unset. When `ENGINE_MAX_CONCURRENT_LLM=8` is set, it returns `maxConcurrentCycles: 8`.
- [ ] **AC-4** (Req 5, Req 6): `BatchPlanService.batchPlan(perceptions: PerceptionResult[])` sends a single LLM call with a multi-agent prompt. The prompt contains each agent's perception context separated by delimiters. The response is parsed into per-agent `FormulatePlanResult` objects.
- [ ] **AC-5** (Req 7): When 7 agents share a room and `maxBatchSize: 5`, `BatchPlanService` makes 2 LLM calls (batch of 5, batch of 2) instead of 7.
- [ ] **AC-6** (Req 8): When the LLM returns an invalid batch response (missing agentId, empty steps for one agent), `BatchPlanService` falls back to individual `PlanService.plan()` calls for the affected agent(s). Agents with valid batch responses are not re-called.
- [ ] **AC-7** (Req 9): `PPEROrchestratorImpl` with no `batchPlanService` option behaves identically to the current implementation — per-agent `PlanService.plan()` calls. Existing orchestrator tests pass unchanged.
- [ ] **AC-8** (Req 10): `OpenAICompatibleLLMClient` captures `usage.prompt_tokens`, `usage.completion_tokens`, `usage.total_tokens` from the API response. `TokenUsageReporter.getTickUsage(tickNumber)` returns the sum of token usage for all LLM calls in that tick. `TokenUsageReporter.getTotalUsage()` returns cumulative totals.
- [ ] **AC-9** (Req 10): When the LLM API response has no `usage` field (some providers omit it), `TokenUsageReport` is still created with all token counts set to 0 — no crash.
- [ ] **AC-10** (Req 11): `PlanBuilderImpl.build()` excludes social tools (`talk_to`, `observe_agent`, `help`, `ignore`) when no agents are present. `PerceptionBuilderImpl.build()` excludes `formulatePlanTool` when the agent has an active plan (`hasPlan: true`).
- [ ] **AC-11** (Req 12): The reflect builder's drive change history in `perceptionContext` contains at most `maxDriveHistoryEntries` (default 3) entries per drive. The full history remains in `AgentInternalState`.
- [ ] **AC-12** (Req 13): `MemoryInjectorImpl.injectAssociative()` with `topK: 3` returns at most 3 memory snippets. Setting `MEMORY_INJECTION_TOP_K=1` via env var results in at most 1 snippet injected.
- [ ] **AC-13** (Req 14): `LLMResponseCache` with a cache hit returns the cached response without making an LLM call. Two identical `(systemPrompt, perceptionContext, tools)` tuples within the TTL produce exactly 1 LLM call.
- [ ] **AC-14** (Req 14): After the cache TTL expires, the same prompt tuple produces a new LLM call (cache miss). The stale entry is evicted.
- [ ] **AC-15** (Req 15): `AffordanceResolutionCache.getAffordanceTools(roomId)` returns cached tool definitions for a room. After a smart object in that room changes state, the cache entry for that room is invalidated and the next call recomputes.
- [ ] **AC-16** (Req 16): `formatPersona(profile)` called twice with the same `AgentProfile` reference returns the same string instance (memoized). Two calls with different `AgentProfile` objects that have identical content may return different string instances (reference-based memoization).
- [ ] **AC-17** (Req 17): With no new config provided (no `batchPlanService`, no `LLMResponseCache`, no `schedulerConfig`, no `MemoryInjectionConfig`), the engine behaves identically to the current implementation. All existing tests pass.
- [ ] **AC-18** (Req 18): All tests in `packages/engine/tests/`, `packages/cognition/tests/`, and `packages/memory/tests/` pass without modification to test logic. Tests that relied on the old default `maxConcurrentCycles: 8` are updated to explicitly set it.
- [ ] **AC-19** (Req 5, Req 7): In a multi-agent scene with 3 agents in the same room and `batchPlanService` enabled, the Plan phase makes 1 LLM call instead of 3 — a 66% reduction in LLM calls for the Plan phase.
- [ ] **AC-20** (Req 14): In a scene with `LLMResponseCache` enabled, two consecutive ticks where agents have identical prompts (same room, same drives) result in the second tick's Plan/Reflect calls being served from cache — 0 LLM calls for the cached phase.

## Constraints

- **Package boundaries** (per ADR-0001): `engine` and `cognition` must not directly import from each other. New shared types (`TokenUsageReport`, `MemoryInjectionConfig`, `BatchPlanConfig`) go in `@evol-hive/shared`. The `BatchPlanService` lives in `@evol-hive/cognition`. The `AffordanceResolutionCache` lives in `@evol-hive/engine`. The `LLMResponseCache` lives in `@evol-hive/cognition`.
- **No blocking in the game loop**: All batch LLM calls, caching lookups, and token tracking happen inside async phase service calls (fired-and-forgotten promises). The game loop `update()` path remains fully synchronous. The `PPERScheduler.update()` does not batch — batching happens inside the orchestrator's async `runCycle()`.
- **Batching scope**: Only the Plan phase is batched. Perceive (passive, no LLM), Execute (deterministic), and Reflect (per-agent memory storage) remain per-agent. Batching the Plan phase yields the greatest reduction in LLM calls because it's the most expensive phase.
- **Cache safety**: The LLM response cache TTL must be short enough (default 1 tick) to prevent stale plans from being reused when drive values have changed. The cache key includes the full `perceptionContext` (which contains drive values rounded to integers per spec 021), so different drive states produce different cache keys.
- **Token usage is best-effort**: Not all LLM providers return `usage` in the response envelope. The `TokenUsageReporter` must handle missing `usage` gracefully (zeros, not errors).
- **Backward compatibility is paramount**: The default `maxConcurrentCycles` change from 8 to 1 is the only breaking change. All other features are opt-in. This is acceptable because the issue explicitly states the default should be 1 for single-model Ollama.
- **What NOT to do**:
  - Do not batch the Perceive, Execute, or Reflect phases — only Plan.
  - Do not change the `PPERScheduler` class's synchronous `update()` method — batching is orchestrator-level.
  - Do not implement a distributed cache or external cache store — in-memory only.
  - Do not change the `LLMClient` interface signature — token usage is reported via a side channel (`TokenUsageReporter` injected into the client).
  - Do not change drive decay, physics, or spatial logic.
  - Do not remove the `cognitiveTools` field from `LLMContextPayload` — it's used internally (spec 021, Req 4).
  - Do not change the `AgentInternalState` type — drive history compression only affects the LLM-visible context.
  - Do not make the `formatPersona` memoization persistent across process restarts — it's an in-process `WeakMap`.
