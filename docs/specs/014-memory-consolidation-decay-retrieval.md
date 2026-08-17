# Feature: Memory Consolidation — Background Reflection, Importance Scoring, Memory Decay, Weighted Retrieval

## Context
- Architecture: [§11 — Memory Architecture](../architecture/11-memory-architecture.md) (dual-track injection, weighted retrieval scoring, reflection & consolidation), [§6 — PPER Loop](../architecture/06-pper-loop.md) (Reflect stores memories, Perceive retrieves), [§9 — Engine Routing](../architecture/09-engine-routing.md) (background systems, isThinking), [§2 — System Overview](../architecture/02-system-overview.md) (package boundaries)
- Related specs: [001 — Perceive Phase](001-perceive-phase.md) (retrieves memories during perception), [004 — Reflect Phase](004-reflect-phase.md) (stores memories during Reflect — `MemoryStore`, `MemoryStoreImpl`, `EmbeddingProvider`, `MemoryEntryInput`), [005 — Game Loop Integration](005-game-loop-integration.md) (`EngineSystem`, `GameLoop.registerSystem`, assembly), [006 — OpenAI-Compatible LLM Client](006-openai-compatible-llm-client.md) (`completeReflection`, `memoryConsolidationSchema`, `ReflectionResult`)
- Package: `shared`, `memory`, `cognition`, `engine`
- ADR: [ADR-0001 — Lean Monorepo Structure](../adr/0001-lean-monorepo-structure.md)
- Issue: [#50](https://github.com/Redna/evol-hive/issues/50)

## Requirements

### Shared Layer (`@evol-hive/shared`)

1. **`MemoryNode.lastAccessed` field** — The existing `MemoryNode` interface in `packages/shared/src/types/memory.ts` must be extended with an optional `lastAccessed?: number` field representing the last simulation time the memory was retrieved or accessed. When a memory is first created, `lastAccessed` is set to `timestamp` (creation time). When a memory is retrieved by the `RetrievalEngine`, `lastAccessed` is updated to the current simulation time. When a memory is checked by the decay service, `lastAccessed` is not modified (decay is computed, not stored — see Req 12). If `lastAccessed` is `undefined` (legacy nodes created before this spec), it is treated as equal to `timestamp` for all decay computations.

2. **`VectorStore.update` method** — The existing `VectorStore` interface in `packages/memory/src/index.ts` must be extended with a new method: `update(id: string, changes: Partial<Pick<MemoryNode, 'importance' | 'lastAccessed'>>): Promise<void>`. This method partially updates a stored `MemoryNode` by applying the given `changes` to the node with the matching `id`. Only `importance` and `lastAccessed` are mutable via this method — `id`, `agentId`, `content`, `embedding`, `type`, `timestamp`, `location`, and `relatedNodes` cannot be modified. If no node with the given `id` exists, the method is a no-op (does not throw). This is needed for: (a) updating `lastAccessed` after retrieval, (b) reducing `importance` when deprioritizing consolidated nodes (§11.3), (c) increasing `importance` for recurring patterns.

3. **`VectorStore.queryByAgent` method** — The existing `VectorStore` interface must be extended with a new method: `queryByAgent(agentId: string): Promise<MemoryNode[]>`. This returns all `MemoryNode` objects stored for the given `agentId`. This is needed by the `MemoryDecayService` to scan all memories for decay processing and pruning. The order of results is unspecified.

4. **`ConsolidationProvider` interface** — A new interface `ConsolidationProvider` must be defined in `packages/shared/src/types/memory.ts` (or `cognition.ts` — it belongs in `shared` because both `memory` and `cognition` need to reference it):
   ```typescript
   interface ConsolidationProvider {
     /** Consolidate low-level memories into higher-level insights via an LLM call. */
     consolidate(
       agentId: string,
       systemPrompt: string,
       memoryNodes: MemorySnippet[],
     ): Promise<ReflectionResult>;
   }
   ```
   This is the bridge interface that lets the memory package's `ReflectionLoopImpl` call the LLM for consolidation without importing from `cognition` (per ADR-0001, `memory` cannot import from `cognition`). The `cognition` package provides a concrete implementation wrapping `LLMClient.completeReflection` (see Req 19). The `agentId` parameter is used to set the `agentId` field on each `MemoryNode` in the returned `ReflectionResult.newMemories` — the existing `LLMClient.completeReflection` signature does not take `agentId`, so the `ConsolidationProviderImpl` sets it post-call.

5. **`MemoryDecayConfig` type** — A new interface `MemoryDecayConfig` must be defined in `packages/shared/src/types/memory.ts`:
   ```typescript
   interface MemoryDecayConfig {
     /** Exponential decay rate for importance (per simulation second). Higher = faster decay. */
     decayRate: number;
     /** Effective importance below which a memory is a pruning candidate. */
     pruneThreshold: number;
     /** Run the decay pass every N engine ticks. */
     decayIntervalTicks: number;
   }
   ```
   This configures the background decay system. The `decayRate` controls how fast importance decays for never-accessed memories. The `pruneThreshold` is the effective importance below which a memory is eligible for pruning. The `decayIntervalTicks` controls how often the decay pass runs (not every tick — decay is a background process).

6. **`defaultRetrievalWeights` constant** — A new constant `defaultRetrievalWeights` must be defined in `packages/shared/src/types/memory.ts` (or a constants file exported from shared):
   ```typescript
   const defaultRetrievalWeights: RetrievalWeights = {
     recencyWeight: 1.0,
     importanceWeight: 1.0,
     relevanceWeight: 1.0,
     recencyDecayRate: 0.01,
   };
   ```
   These are the default weights from §11.2. The `RetrievalEngineImpl` uses these when no explicit weights are provided.

7. **`defaultReflectionConfig` constant** — A new constant `defaultReflectionConfig` must be defined in `packages/shared/src/types/memory.ts`:
   ```typescript
   const defaultReflectionConfig: ReflectionConfig = {
     nodeThreshold: 50,
     idleThresholdSeconds: 30,
     enabled: true,
   };
   ```
   These are the defaults from §11.3.

8. **`defaultMemoryDecayConfig` constant** — A new constant `defaultMemoryDecayConfig` must be defined in `packages/shared/src/types/memory.ts`:
   ```typescript
   const defaultMemoryDecayConfig: MemoryDecayConfig = {
     decayRate: 0.001,
     pruneThreshold: 0.5,
     decayIntervalTicks: 100,
   };
   ```
   A `decayRate` of 0.001 means a memory with base importance 10 that is never accessed for 1000 simulation seconds has an effective importance of `10 * e^(-0.001 * 1000) ≈ 3.68`. After 5000 seconds, it drops to `10 * e^(-5) ≈ 0.067`, which is below the `pruneThreshold` of 0.5.

### Memory Layer (`@evol-hive/memory`)

9. **`InMemoryVectorStore` concrete implementation** — A concrete `InMemoryVectorStore` class must be implemented in `packages/memory/src/store/in-memory-vector-store.ts`, exported from `packages/memory/src/store/index.ts` and `packages/memory/src/index.ts`. It must implement the full `VectorStore` interface including the new `update` and `queryByAgent` methods (Req 2, Req 3). It stores `MemoryNode` objects in an in-memory `Map<string, MemoryNode>` keyed by `id`. The `queryByEmbedding` method computes cosine similarity between the query embedding and each stored node's embedding, returning the top-K most similar nodes (sorted by similarity descending). Cosine similarity is defined as `dot(a, b) / (|a| * |b|)` — if either vector has zero magnitude, the similarity is 0. The `countRecent` method returns the count of nodes for the given `agentId` with `timestamp >= sinceTimestamp`. The `delete` method removes nodes by ID from the map. The `update` method (Req 2) applies `changes` to the existing node if present. The `queryByAgent` method (Req 3) returns all nodes whose `agentId` matches. This is the default `VectorStore` implementation for testing and single-process deployments.

10. **`RetrievalEngineImpl` — weighted retrieval scoring** — A concrete `RetrievalEngineImpl` class must be implemented in `packages/memory/src/retrieval/retrieval-engine.ts`, exported from `packages/memory/src/retrieval/index.ts` and `packages/memory/src/index.ts`. It must implement the existing `RetrievalEngine` interface. It accepts `RetrievalEngineOptions` via constructor injection:
    ```typescript
    interface RetrievalEngineOptions {
      vectorStore: VectorStore;
      embeddingProvider: EmbeddingProvider;
      weights?: RetrievalWeights;
    }
    ```
    If `weights` is not provided, `defaultRetrievalWeights` (Req 6) is used. The `score(nodes, queryEmbedding, currentSimTime, weights?)` method must compute a `RetrievalScore` for each node:
    - **recency** = `e^(-recencyDecayRate * (currentSimTime - node.timestamp))` — exponential decay based on time since creation (§11.2).
    - **importance** = `node.importance * e^(-decayRate * (currentSimTime - (node.lastAccessed ?? node.timestamp)))` — effective importance, decaying based on time since last access. Note: this uses the `RetrievalWeights.recencyDecayRate` is for recency; the importance decay rate is a separate parameter. Use `weights.recencyDecayRate * 0.1` as the importance decay rate (10x slower than recency decay — importance is more persistent than recency). This is a design decision: importance should decay slowly, while recency should decay faster, reflecting that a memory's significance persists longer than its freshness.
    - **relevance** = cosine similarity between `queryEmbedding` and `node.embedding`. If either vector has zero magnitude, relevance is 0.
    - **composite** = `(recency * weights.recencyWeight) + (importance * weights.importanceWeight) + (relevance * weights.relevanceWeight)` (§11.2).
    The `score` method must use the provided `weights` parameter if given, otherwise the constructor's `weights`.

11. **`RetrievalEngineImpl.retrieve` method** — The `retrieve(query, agentId, topK)` method must:
    - Generate an embedding via `embeddingProvider.embed(query)`.
    - Call `vectorStore.queryByEmbedding(embedding, topK * 3)` to get candidate nodes (3x over-fetch for agent filtering).
    - Filter candidates to only those with `node.agentId === agentId`.
    - Call `score(filteredNodes, embedding, currentSimTime)` — the `currentSimTime` is obtained from a `SimulationClock` function injected at construction time. Add `clock: SimulationClock` to `RetrievalEngineOptions`.
    - Sort by `composite` score descending.
    - Take the top-K results.
    - For each returned result, call `vectorStore.update(node.id, { lastAccessed: currentSimTime })` to update the last-accessed timestamp (Req 1). This is fire-and-forget — do not await individual updates; use `Promise.all` to update all in parallel.
    - Return `{ node, score }[]` — the top-K scored results.

12. **`MemoryDecayService` interface** — A new interface `MemoryDecayService` must be defined in `packages/memory/src/index.ts`:
    ```typescript
    interface MemoryDecayService {
      /** Compute effective importance for all of an agent's memories and identify prune candidates. */
      applyDecay(agentId: string, currentSimTime: number): Promise<DecayResult>;
      /** Prune memories whose effective importance is below the threshold. Returns count of pruned nodes. */
      pruneMemories(agentId: string, currentSimTime: number): Promise<number>;
    }
    ```
    The `DecayResult` type must be defined in `packages/shared/src/types/memory.ts`:
    ```typescript
    interface DecayResult {
      agentId: string;
      /** IDs of memories whose effective importance is below the prune threshold. */
      pruneCandidateIds: string[];
      /** Effective importance scores for all memories (for debugging/inspection). */
      scores: { memoryId: string; effectiveImportance: number; baseImportance: number }[];
    }
    ```
    The decay is computed, not stored — the `MemoryNode.importance` field is not modified by the decay service. Instead, the effective importance is computed on-the-fly during retrieval (in `RetrievalEngineImpl.score`) and during decay checks (in `MemoryDecayService`). The `MemoryNode.importance` is the base importance, modified only by consolidation (increase) or deprioritization (decrease). This separates "what the memory is worth" (base importance) from "how relevant is it right now" (effective importance after decay).

13. **`MemoryDecayServiceImpl` concrete implementation** — A concrete `MemoryDecayServiceImpl` class must be implemented in `packages/memory/src/retrieval/memory-decay-service.ts` (or `packages/memory/src/decay/index.ts`), exported from `packages/memory/src/index.ts`. It accepts `MemoryDecayServiceOptions` via constructor injection:
    ```typescript
    interface MemoryDecayServiceOptions {
      vectorStore: VectorStore;
      config: MemoryDecayConfig;
    }
    ```
    The `applyDecay(agentId, currentSimTime)` method must:
    - Call `vectorStore.queryByAgent(agentId)` to get all memories for the agent.
    - For each memory, compute `effectiveImportance = node.importance * e^(-config.decayRate * (currentSimTime - (node.lastAccessed ?? node.timestamp)))`.
    - Collect IDs where `effectiveImportance < config.pruneThreshold` into `pruneCandidateIds`.
    - Return a `DecayResult` with `agentId`, `pruneCandidateIds`, and `scores`.
    The `pruneMemories(agentId, currentSimTime)` method must:
    - Call `applyDecay(agentId, currentSimTime)` to get prune candidates.
    - Call `vectorStore.delete(pruneCandidateIds)` to remove them.
    - Return `pruneCandidateIds.length` (the count of pruned memories).
    Pruning is irreversible — deleted memories are gone. The caller (engine system) decides whether to prune or just report candidates.

14. **`ReflectionLoopImpl` — background consolidation** — A concrete `ReflectionLoopImpl` class must be implemented in `packages/memory/src/reflection/reflection-loop.ts`, exported from `packages/memory/src/reflection/index.ts` and `packages/memory/src/index.ts`. It must implement the existing `ReflectionLoop` interface. It accepts `ReflectionLoopOptions` via constructor injection:
    ```typescript
    interface ReflectionLoopOptions {
      vectorStore: VectorStore;
      embeddingProvider: EmbeddingProvider;
      consolidationProvider: ConsolidationProvider;
      config: ReflectionConfig;
      clock: SimulationClock;
    }
    ```
    The `shouldReflect(agentId, currentSimTime, isIdle)` method must return `true` if:
    - `config.enabled` is `true`, AND
    - Either: (a) `vectorStore.countRecent(agentId, <lastReflectionTime>) >= config.nodeThreshold` — the number of new memories since the last reflection exceeds the threshold, OR (b) `isIdle && (currentSimTime - <lastActivityTime>) >= config.idleThresholdSeconds` — the agent has been idle long enough.
    The `lastReflectionTime` is tracked internally per agent (initialized to 0). After a successful reflection, `lastReflectionTime` is updated to `currentSimTime`.
    The `runReflection(agentId)` method must:
    - Get the current sim time via `clock()`.
    - Call `vectorStore.queryByAgent(agentId)` to get all memories for the agent.
    - Convert `MemoryNode[]` to `MemorySnippet[]` (mapping `id`, `content`, `importance`, `timestamp`).
    - Build a system prompt instructing the LLM to consolidate the low-level memories into higher-level insights (the prompt text is a constant defined in the implementation).
    - Call `consolidationProvider.consolidate(agentId, systemPrompt, snippets)` → `ReflectionResult`.
    - For each new memory in `ReflectionResult.newMemories`:
      - If `embedding` is empty (`[]` or undefined), generate via `embeddingProvider.embed(content)`.
      - Set `agentId` on the node (override whatever the provider set — the `ReflectionLoopImpl` is authoritative).
      - Set `lastAccessed` to the current sim time.
      - Call `vectorStore.store(node)`.
    - For each ID in `ReflectionResult.consolidatedNodeIds`:
      - Reduce importance by calling `vectorStore.update(id, { importance: <reduced> })`. The reduced importance is `max(1, <original> / 2)` — halved, but never below 1. To get the original importance, call `vectorStore.get(id)` first. If the node doesn't exist, skip it.
    - Update `lastReflectionTime` for the agent to the current sim time.
    - Return the `ReflectionResult`.
    The `start()` and `stop()` methods set/clear an internal `running` flag. `runReflection` should be a no-op if `start()` has not been called (or if `config.enabled` is false).

15. **`MemoryInjectorImpl` — dual-track injection** — A concrete `MemoryInjectorImpl` class must be implemented in `packages/memory/src/retrieval/memory-injector.ts`, exported from `packages/memory/src/retrieval/index.ts` and `packages/memory/src/index.ts`. It must implement the existing `MemoryInjector` interface. It accepts `MemoryInjectorOptions` via constructor injection:
    ```typescript
    interface MemoryInjectorOptions {
      retrievalEngine: RetrievalEngine;
    }
    ```
    The `injectAssociative(agentId, roomId, currentDrives)` method (Track 1 — passive, §11.1) must:
    - Build a query string from the room and drives context, e.g., `${roomId} ${Object.entries(currentDrives).map(([k, v]) => v > 50 ? k : '').filter(Boolean).join(' ')}`. This creates a semantic query representing the agent's current situation (location + pressing needs).
    - Call `retrievalEngine.retrieve(query, agentId, 5)` to get the top-5 most relevant memories.
    - Convert `MemoryNode[]` results to `MemorySnippet[]` (mapping `id`, `content`, `importance`, `timestamp`).
    - Return the `MemorySnippet[]`. This is injected silently into the perception context window (no LLM call required — the caller, the Perceive phase, handles injection).
    The `activeRecall(agentId, query, topK)` method (Track 2 — active, §11.1) must:
    - Call `retrievalEngine.retrieve(query, agentId, topK)`.
    - Convert results to `MemorySnippet[]`.
    - Return the `MemorySnippet[]`.

### Engine Layer (`@evol-hive/engine`)

16. **`MemoryMaintenanceSystem` — engine system** — A new `MemoryMaintenanceSystem` class must be implemented in `packages/engine/src/systems/memory-maintenance.ts`, exported from `packages/engine/src/index.ts`. It must implement the `EngineSystem` interface (existing, defined in `packages/engine/src/index.ts`). It accepts `MemoryMaintenanceOptions` via constructor injection:
    ```typescript
    interface MemoryMaintenanceOptions {
      agentManager: AgentManager;
      memoryDecayService: MemoryDecayService;
      reflectionLoop: ReflectionLoop;
      decayConfig: MemoryDecayConfig;
    }
    ```
    The `name` property is `'memory-maintenance'`. The `update(tick: GameTick)` method must:
    - Increment an internal tick counter.
    - If `tickCounter % decayConfig.decayIntervalTicks === 0` (time for a decay pass):
      - For each active agent from `agentManager.getActiveAgents()`:
        - Call `memoryDecayService.applyDecay(agent.agentId, tick.simulationTime)` (fire-and-forget — do not await; use `.catch()` to log errors).
    - For each active agent:
      - Call `reflectionLoop.shouldReflect(agent.agentId, tick.simulationTime, <isIdle>)` where `isIdle` is `!agent.isThinking && <no recent plan activity>` — simplified: `isIdle = !agent.isThinking`.
      - If `shouldReflect` returns `true`, call `reflectionLoop.runReflection(agent.agentId)` (fire-and-forget — `.catch()` to log errors, like `PPERScheduler`).
    - The `update` method is synchronous and never awaits — it fires-and-forgets async operations, matching the `PPERScheduler` pattern (spec 005). This ensures the game loop is never blocked by memory maintenance.
    - Decay and reflection run concurrently for different agents — there is no mutex or ordering requirement between them.

17. **Assembly integration** — The `assembleGameLoop` function in `packages/engine/src/assembly.ts` must be extended to register the `MemoryMaintenanceSystem` as the 4th engine system (after `PPERScheduler`). The `EngineCore` interface must be extended to include `memoryDecayService: MemoryDecayService` and `reflectionLoop: ReflectionLoop` (if wired), or these are passed in as construction parameters. The `createEngineCore` function must accept optional `memoryMaintenance` configuration. If `MemoryDecayService` or `ReflectionLoop` is not provided (e.g., in minimal test setups), the `MemoryMaintenanceSystem` is not registered — memory maintenance is an optional enhancement. The assembly must not fail if memory subsystems are not wired.

18. **`EngineCore` extension** — The `EngineCore` interface must add:
    ```typescript
    memoryDecayService?: MemoryDecayService;
    reflectionLoop?: ReflectionLoop;
    memoryMaintenanceConfig?: MemoryDecayConfig;
    ```
    All three are optional. If `memoryDecayService` is provided, `assembleGameLoop` registers a `MemoryMaintenanceSystem` with the decay service and (if provided) the reflection loop. If `memoryDecayService` is not provided, no memory maintenance system is registered — the engine runs without background memory processing (backward-compatible with existing tests and minimal scenes).

### Cognition Layer (`@evol-hive/cognition`)

19. **`ConsolidationProviderImpl` — bridge implementation** — A concrete `ConsolidationProviderImpl` class must be implemented in `packages/cognition/src/pper/consolidation-provider.ts` (or `packages/cognition/src/memory/`), exported from `packages/cognition/src/index.ts`. It must implement the `ConsolidationProvider` interface (Req 4) defined in `@evol-hive/shared`. It accepts `ConsolidationProviderOptions` via constructor injection:
    ```typescript
    interface ConsolidationProviderOptions {
      llmClient: LLMClient;
    }
    ```
    The `consolidate(agentId, systemPrompt, memoryNodes)` method must:
    - Call `llmClient.completeReflection(systemPrompt, memoryNodes)` → `ReflectionResult`.
    - For each `MemoryNode` in `result.newMemories`, set `node.agentId = agentId` (override whatever the LLM client set — the caller is authoritative).
    - Return the modified `ReflectionResult`.
    This is a thin adapter that bridges the `LLMClient.completeReflection` method (cognition) to the `ConsolidationProvider` interface (shared, consumed by memory). Per ADR-0001, `cognition` can import from `shared` (where `ConsolidationProvider` is defined) but not from `memory` implementations.

### Cross-Cutting

20. **Package boundaries** (per ADR-0001) — The dependency graph is: `shared ← memory`, `shared ← cognition`, `memory ← cognition`, `shared ← engine`, `memory ← engine`. This means:
    - `memory` imports from `shared` only (not from `cognition` or `engine`).
    - `cognition` imports from `shared` and `memory` (for types only, not implementations — `ConsolidationProviderImpl` uses `LLMClient` which is in cognition).
    - `engine` imports from `shared` and `memory` (for `MemoryDecayService`, `ReflectionLoop`, `InMemoryVectorStore`, etc.).
    - The `ConsolidationProvider` interface (Req 4) is defined in `shared` because both `memory` (consumer) and `cognition` (provider) need it. The `ConsolidationProviderImpl` (Req 19) is in `cognition` because it wraps `LLMClient`.
    - The wiring of `ConsolidationProviderImpl` → `ReflectionLoopImpl` → `MemoryMaintenanceSystem` happens at the application entry point, which imports from all packages.

21. **`lastAccessed` update on retrieval** — When the `RetrievalEngineImpl.retrieve` method returns memories, it must update `lastAccessed` on each returned `MemoryNode` via `vectorStore.update(id, { lastAccessed: currentSimTime })`. This ensures that frequently-retrieved memories maintain their effective importance (decay is based on time since last access). The update is fire-and-forget — it must not block the retrieval response. Use `Promise.all` to batch the updates. If an update fails (e.g., node was deleted between retrieval and update), the error is swallowed (logged but not thrown) — the retrieval result is still returned.

22. **Deprioritization on consolidation** — When `ReflectionLoopImpl.runReflection` creates consolidated memories, the original low-level memories must be deprioritized (§11.3). Deprioritization means reducing the `importance` field of the original nodes by 50% (halved, rounded down, minimum 1). This makes the original memories less likely to be retrieved in favor of the higher-level consolidated memories. The original memories are NOT deleted — they remain in the vector store with reduced importance. This follows the architecture: "Original nodes deprioritized (not deleted, but lower retrieval weight)."

23. **Consolidation increases importance** — The consolidated memories created by `ReflectionLoopImpl.runReflection` must have an `importance` score set by the LLM (via `memoryConsolidationSchema`'s `consolidatedMemories[].importance` field, spec 006). The LLM is instructed (via the system prompt) to assign higher importance to consolidated memories than the originals (e.g., importance 8-10 for insights, vs. 3-5 for raw observations). The `ReflectionLoopImpl` does not override the LLM-assigned importance — it stores it as-is.

24. **Decay is computed, not stored** — The `MemoryNode.importance` field is the base importance (set by the LLM at creation, modified by consolidation). The effective importance (after decay) is computed on-the-fly:
    - During retrieval: `RetrievalEngineImpl.score` computes `effectiveImportance = importance * e^(-decayRate * (simTime - lastAccessed))` and uses it as the `importance` component of `RetrievalScore`.
    - During decay checks: `MemoryDecayServiceImpl.applyDecay` computes the same formula to identify prune candidates.
    - The stored `importance` is NOT modified by the decay service. This ensures the base importance is preserved — if a memory is retrieved (boosting `lastAccessed`), its effective importance recovers to the base.
    - Only consolidation (increase) and deprioritization (decrease, Req 22) modify the stored `importance`.

25. **No LLM call in retrieval** — Track 1 (associative injection, `MemoryInjectorImpl.injectAssociative`) must NOT make an LLM call. It uses only embedding similarity and weighted scoring (§11.1: "No LLM call required"). Track 2 (active recall, `MemoryInjectorImpl.activeRecall`) also does not make an LLM call directly — it delegates to `RetrievalEngine.retrieve` which uses embeddings only. The `query_memory` cognitive tool (which the agent invokes during the Plan or Execute phase to actively recall memories) is a separate concern and is NOT in scope for this spec.

26. **Reflection is async and non-blocking** — The `MemoryMaintenanceSystem.update` method is synchronous and never awaits — it fire-and-forgets both decay and reflection operations (matching the `PPERScheduler` pattern, spec 005). The `ReflectionLoopImpl.runReflection` method is async (it calls the LLM via `ConsolidationProvider.consolidate`), but the engine system does not await it. This ensures the game loop runs at full FPS regardless of LLM latency. Multiple agents' reflections can run concurrently — there is no global mutex on memory consolidation.

27. **Thread safety** — The `InMemoryVectorStore` is a single-process, single-threaded store. The `update` and `delete` methods are safe against concurrent reads (JavaScript is single-threaded with async — no data races). The `ReflectionLoopImpl.runReflection` method may be called concurrently for the same agent (if `shouldReflect` returns true on consecutive ticks before a previous reflection completes). To prevent this, `ReflectionLoopImpl` must track `reflectingAgents: Set<string>` — if `runReflection` is called for an agent that is already reflecting, it returns immediately with an empty `ReflectionResult` (no-op). The flag is cleared when the reflection completes (in a `finally` block).

28. **Reuse from existing specs** — The following types and interfaces are already defined and must NOT be redefined:
    - `MemoryNode`, `MemoryType`, `MemorySnippet`, `RetrievalScore`, `RetrievalWeights`, `ReflectionResult`, `ReflectionConfig` (in `@evol-hive/shared`)
    - `VectorStore`, `RetrievalEngine`, `MemoryInjector`, `ReflectionLoop`, `EmbeddingProvider`, `MemoryStore`, `MemoryStoreImpl`, `MemoryEntryInput` (in `@evol-hive/shared` and `@evol-hive/memory`)
    - `LLMClient.completeReflection`, `memoryConsolidationSchema` (in `@evol-hive/cognition` and `@evol-hive/shared`)
    - `EngineSystem`, `GameLoop`, `AgentManager`, `GameTick` (in `@evol-hive/engine` and `@evol-hive/shared`)
    - `SimulationClock` (in `@evol-hive/engine` — `() => number`)
    This spec adds: `MemoryNode.lastAccessed`, `VectorStore.update`, `VectorStore.queryByAgent`, `ConsolidationProvider`, `MemoryDecayConfig`, `DecayResult`, `defaultRetrievalWeights`, `defaultReflectionConfig`, `defaultMemoryDecayConfig`, `InMemoryVectorStore`, `RetrievalEngineImpl`, `MemoryInjectorImpl`, `MemoryDecayService`, `MemoryDecayServiceImpl`, `ReflectionLoopImpl`, `MemoryMaintenanceSystem`, `ConsolidationProviderImpl`, and associated option types.

29. **What NOT to do**:
    - Do not implement the `query_memory` cognitive tool — that is a separate spec for the Plan/Execute phase's active recall tool. This spec implements the retrieval mechanism (`MemoryInjector.activeRecall`), but not the tool wiring.
    - Do not modify the `LLMClient.completeReflection` interface or the `memoryConsolidationSchema` — they are already defined (spec 006). This spec uses them as-is via the `ConsolidationProvider` bridge.
    - Do not implement a persistent vector store backend (LanceDB, ChromaDB) — only `InMemoryVectorStore` is in scope. Persistence is a separate concern.
    - Do not modify the `MemoryStore` or `MemoryStoreImpl` interfaces — they are already implemented (spec 004). This spec builds on top of them, not modifies them.
    - Do not modify the PPER orchestrator — the memory maintenance system runs independently of the PPER cycle.
    - Do not implement cognitive guardrails (§10) — memory consolidation is not a guarded operation.
    - Do not implement the full `MemoryInjector` integration with the Perceive phase — the `MemoryInjectorImpl` is implemented, but the wiring into the Perceive phase's context window is a separate integration task.
    - Do not add `MemoryDecayConfig`, `DecayResult`, or `ConsolidationProvider` to `packages/memory/` or `packages/cognition/` — they belong in `shared` since multiple packages need to reference them.
    - Do not delete original memories during consolidation — they are deprioritized (importance reduced), not deleted (§11.3).

## Acceptance Criteria

- [ ] **AC-1**: `MemoryNode` in `packages/shared/src/types/memory.ts` includes an optional `lastAccessed?: number` field. *(Req 1)*
- [ ] **AC-2**: `VectorStore` interface in `packages/memory/src/index.ts` includes `update(id: string, changes: Partial<Pick<MemoryNode, 'importance' | 'lastAccessed'>>): Promise<void>`. *(Req 2)*
- [ ] **AC-3**: `VectorStore.update` with non-existent ID is a no-op (does not throw). *(Req 2)*
- [ ] **AC-4**: `VectorStore` interface includes `queryByAgent(agentId: string): Promise<MemoryNode[]>`. *(Req 3)*
- [ ] **AC-5**: `ConsolidationProvider` interface is defined in `packages/shared/src/types/memory.ts` with `consolidate(agentId: string, systemPrompt: string, memoryNodes: MemorySnippet[]): Promise<ReflectionResult>`. *(Req 4)*
- [ ] **AC-6**: `MemoryDecayConfig` is defined in `packages/shared/src/types/memory.ts` with `decayRate: number`, `pruneThreshold: number`, `decayIntervalTicks: number`. *(Req 5)*
- [ ] **AC-7**: `DecayResult` is defined in `packages/shared/src/types/memory.ts` with `agentId: string`, `pruneCandidateIds: string[]`, and `scores: { memoryId: string; effectiveImportance: number; baseImportance: number }[]`. *(Req 12)*
- [ ] **AC-8**: `defaultRetrievalWeights` is defined in shared with `recencyWeight: 1.0`, `importanceWeight: 1.0`, `relevanceWeight: 1.0`, `recencyDecayRate: 0.01`. *(Req 6)*
- [ ] **AC-9**: `defaultReflectionConfig` is defined in shared with `nodeThreshold: 50`, `idleThresholdSeconds: 30`, `enabled: true`. *(Req 7)*
- [ ] **AC-10**: `defaultMemoryDecayConfig` is defined in shared with `decayRate: 0.001`, `pruneThreshold: 0.5`, `decayIntervalTicks: 100`. *(Req 8)*
- [ ] **AC-11**: `InMemoryVectorStore` is defined in `packages/memory/src/store/in-memory-vector-store.ts` and exported from `packages/memory/src/index.ts`. *(Req 9)*
- [ ] **AC-12**: `InMemoryVectorStore.queryByEmbedding` returns nodes sorted by cosine similarity descending, limited to `topK`. *(Req 9)*
- [ ] **AC-13**: `InMemoryVectorStore.queryByEmbedding` returns 0 similarity for zero-magnitude vectors. *(Req 9)*
- [ ] **AC-14**: `InMemoryVectorStore.countRecent(agentId, sinceTimestamp)` returns the count of nodes for `agentId` with `timestamp >= sinceTimestamp`. *(Req 9)*
- [ ] **AC-15**: `InMemoryVectorStore.update(id, changes)` applies `changes` to the existing node. Calling `update` on a non-existent ID is a no-op. *(Req 2, Req 9)*
- [ ] **AC-16**: `InMemoryVectorStore.queryByAgent(agentId)` returns all nodes with matching `agentId`. *(Req 3, Req 9)*
- [ ] **AC-17**: `InMemoryVectorStore.delete(ids)` removes the specified nodes from the store. *(Req 9)*
- [ ] **AC-18**: `RetrievalEngineImpl` is defined in `packages/memory/src/retrieval/retrieval-engine.ts` and exported from `packages/memory/src/index.ts`. *(Req 10)*
- [ ] **AC-19**: `RetrievalEngineImpl` accepts `{ vectorStore, embeddingProvider, weights?, clock }` via constructor. If `weights` is omitted, `defaultRetrievalWeights` is used. *(Req 10)*
- [ ] **AC-20**: `RetrievalEngineImpl.score` computes `recency = e^(-recencyDecayRate * (simTime - timestamp))`. *(Req 10)*
- [ ] **AC-21**: `RetrievalEngineImpl.score` computes effective `importance = node.importance * e^(-importanceDecayRate * (simTime - (lastAccessed ?? timestamp)))` where `importanceDecayRate = recencyDecayRate * 0.1`. *(Req 10)*
- [ ] **AC-22**: `RetrievalEngineImpl.score` computes `relevance` as cosine similarity between the query embedding and node embedding. Zero-magnitude vectors yield 0. *(Req 10)*
- [ ] **AC-23**: `RetrievalEngineImpl.score` computes `composite = (recency * recencyWeight) + (importance * importanceWeight) + (relevance * relevanceWeight)`. *(Req 10)*
- [ ] **AC-24**: `RetrievalEngineImpl.retrieve` embeds the query, fetches candidates from `VectorStore`, filters by `agentId`, scores, sorts by `composite` descending, and returns top-K. *(Req 11)*
- [ ] **AC-25**: `RetrievalEngineImpl.retrieve` calls `vectorStore.update(node.id, { lastAccessed: currentSimTime })` for each returned result (updating last-accessed timestamp). *(Req 11, Req 21)*
- [ ] **AC-26**: `MemoryDecayService` interface is defined in `packages/memory/src/index.ts` with `applyDecay(agentId, currentSimTime): Promise<DecayResult>` and `pruneMemories(agentId, currentSimTime): Promise<number>`. *(Req 12)*
- [ ] **AC-27**: `MemoryDecayServiceImpl` is defined and exported from `packages/memory/src/index.ts`. *(Req 13)*
- [ ] **AC-28**: `MemoryDecayServiceImpl.applyDecay` computes `effectiveImportance = importance * e^(-decayRate * (simTime - (lastAccessed ?? timestamp)))` for each memory and collects IDs where `effectiveImportance < pruneThreshold`. *(Req 13)*
- [ ] **AC-29**: `MemoryDecayServiceImpl.pruneMemories` calls `applyDecay`, deletes prune candidates via `vectorStore.delete`, and returns the count. *(Req 13)*
- [ ] **AC-30**: `ReflectionLoopImpl` is defined in `packages/memory/src/reflection/reflection-loop.ts` and exported from `packages/memory/src/index.ts`. *(Req 14)*
- [ ] **AC-31**: `ReflectionLoopImpl` accepts `{ vectorStore, embeddingProvider, consolidationProvider, config, clock }` via constructor. *(Req 14)*
- [ ] **AC-32**: `ReflectionLoopImpl.shouldReflect` returns `true` when `config.enabled` is `true` and either the node threshold is exceeded or the idle threshold is met. *(Req 14)*
- [ ] **AC-33**: `ReflectionLoopImpl.runReflection` calls `consolidationProvider.consolidate`, stores new memories via `vectorStore.store`, and deprioritizes original nodes via `vectorStore.update`. *(Req 14)*
- [ ] **AC-34**: `ReflectionLoopImpl.runReflection` generates embeddings for new memories with empty embeddings via `embeddingProvider.embed`. *(Req 14)*
- [ ] **AC-35**: `ReflectionLoopImpl.runReflection` deprioritizes consolidated nodes by halving their importance (minimum 1). *(Req 14, Req 22)*
- [ ] **AC-36**: `ReflectionLoopImpl.runReflection` returns immediately with an empty `ReflectionResult` if the agent is already reflecting (concurrent call guard). *(Req 27)*
- [ ] **AC-37**: `MemoryInjectorImpl` is defined in `packages/memory/src/retrieval/memory-injector.ts` and exported from `packages/memory/src/index.ts`. *(Req 15)*
- [ ] **AC-38**: `MemoryInjectorImpl.injectAssociative` builds a query from room + drives context and returns top-5 memories as `MemorySnippet[]` without an LLM call. *(Req 15, Req 25)*
- [ ] **AC-39**: `MemoryInjectorImpl.activeRecall` delegates to `retrievalEngine.retrieve` and returns results as `MemorySnippet[]`. *(Req 15)*
- [ ] **AC-40**: `MemoryMaintenanceSystem` is defined in `packages/engine/src/systems/memory-maintenance.ts` and exported from `packages/engine/src/index.ts`. *(Req 16)*
- [ ] **AC-41**: `MemoryMaintenanceSystem.name` is `'memory-maintenance'`. *(Req 16)*
- [ ] **AC-42**: `MemoryMaintenanceSystem.update` runs decay every `decayIntervalTicks` ticks (fire-and-forget). *(Req 16)*
- [ ] **AC-43**: `MemoryMaintenanceSystem.update` triggers reflection via `reflectionLoop.runReflection` when `shouldReflect` returns `true` (fire-and-forget). *(Req 16)*
- [ ] **AC-44**: `MemoryMaintenanceSystem.update` never awaits — all async operations are fire-and-forget with `.catch()` error logging. *(Req 16, Req 26)*
- [ ] **AC-45**: `assembleGameLoop` registers `MemoryMaintenanceSystem` as the 4th system (after `PPERScheduler`) when `memoryDecayService` is provided in `EngineCore`. *(Req 17, Req 18)*
- [ ] **AC-46**: `assembleGameLoop` does NOT register `MemoryMaintenanceSystem` when `memoryDecayService` is not provided (backward-compatible with existing tests). *(Req 17, Req 18)*
- [ ] **AC-47**: `ConsolidationProviderImpl` is defined in `packages/cognition/src/pper/consolidation-provider.ts` and exported from `packages/cognition/src/index.ts`. *(Req 19)*
- [ ] **AC-48**: `ConsolidationProviderImpl.consolidate` calls `llmClient.completeReflection` and sets `agentId` on each `MemoryNode` in the result. *(Req 19)*
- [ ] **AC-49**: `RetrievalEngineImpl` imports from `@evol-hive/shared` only (not from `@evol-hive/cognition` or `@evol-hive/engine`). *(Req 20)*
- [ ] **AC-50**: `ReflectionLoopImpl` imports from `@evol-hive/shared` only (not from `@evol-hive/cognition` or `@evol-hive/engine`). *(Req 20)*
- [ ] **AC-51**: `MemoryMaintenanceSystem` imports from `@evol-hive/shared` and `@evol-hive/memory` (not from `@evol-hive/cognition`). *(Req 20)*
- [ ] **AC-52**: `ConsolidationProviderImpl` imports from `@evol-hive/shared` (for `ConsolidationProvider`, `ReflectionResult`, `MemorySnippet`) and from `@evol-hive/cognition` (for `LLMClient`). It does NOT import from `@evol-hive/memory`. *(Req 20)*
- [ ] **AC-53**: When `MemoryNode.lastAccessed` is `undefined`, decay and retrieval computations treat it as equal to `timestamp`. *(Req 1, Req 10, Req 13)*
- [ ] **AC-54**: `RetrievalEngineImpl.retrieve` with an agent that has no memories returns an empty array (no error). *(Req 11)*
- [ ] **AC-55**: `MemoryDecayServiceImpl.applyDecay` with an agent that has no memories returns `DecayResult` with empty `pruneCandidateIds` and `scores`. *(Req 13)*
- [ ] **AC-56**: `ReflectionLoopImpl.runReflection` when `config.enabled` is `false` is a no-op returning an empty `ReflectionResult`. *(Req 14)*
- [ ] **AC-57**: After `ReflectionLoopImpl.runReflection`, the consolidated original nodes have reduced `importance` (halved, minimum 1). *(Req 14, Req 22)*
- [ ] **AC-58**: After `ReflectionLoopImpl.runReflection`, new consolidated memories are stored in the `VectorStore` with correct `agentId` and `lastAccessed`. *(Req 14)*
- [ ] **AC-59**: `RetrievalEngineImpl.score` with `weights` parameter override uses the provided weights instead of constructor defaults. *(Req 10)*
- [ ] **AC-60**: `MemoryInjectorImpl.injectAssociative` does not call `llmClient` or any LLM (pure embedding-based retrieval). *(Req 15, Req 25)*

## Constraints

- **Package boundaries** (per ADR-0001): `memory` imports from `shared` only. `cognition` imports from `shared` and `memory` (types only). `engine` imports from `shared` and `memory`. The `ConsolidationProvider` bridge (in `shared`) is the only communication channel between `memory` (consumer of LLM consolidation) and `cognition` (provider of LLM consolidation). The `ConsolidationProviderImpl` (in `cognition`) wraps `LLMClient.completeReflection`. The wiring happens at the application entry point.
- **Decay is computed, not stored**: The `MemoryNode.importance` field is the base importance (set by LLM at creation). Effective importance is computed on-the-fly during retrieval and decay checks. Only consolidation (increase) and deprioritization (decrease) modify the stored `importance`. This preserves the base importance so that retrieval (updating `lastAccessed`) can restore effective importance to the base level.
- **No LLM call in retrieval**: Track 1 (associative injection) and Track 2 (active recall) use only embedding similarity and weighted scoring. No LLM call is made during retrieval (§11.1). The LLM is only used for background consolidation (§11.3) via `ConsolidationProvider.consolidate`.
- **Reflection is async and non-blocking**: The `MemoryMaintenanceSystem.update` method is synchronous and fire-and-forgets all async operations. The game loop is never blocked by memory maintenance. This follows the `PPERScheduler` pattern (spec 005).
- **Concurrent reflection guard**: `ReflectionLoopImpl` must prevent concurrent reflections for the same agent using a `Set<string>` of reflecting agent IDs. If `runReflection` is called for an agent already reflecting, it returns immediately with an empty result. This prevents duplicate consolidation passes.
- **Deprioritization, not deletion**: Consolidated original memories are deprioritized (importance halved, minimum 1), NOT deleted. They remain in the vector store with reduced importance and may still be retrieved (with lower scores). This follows §11.3: "Original nodes deprioritized (not deleted, but lower retrieval weight)."
- **Optional memory subsystems**: The `MemoryMaintenanceSystem` is only registered when `MemoryDecayService` is provided in `EngineCore`. If not provided, the engine runs without background memory processing. This is backward-compatible with existing tests and minimal scenes that don't wire memory subsystems.
- **Reuse existing interfaces**: The `VectorStore`, `RetrievalEngine`, `MemoryInjector`, `ReflectionLoop`, `EmbeddingProvider`, `MemoryStore` interfaces already exist. This spec adds methods to `VectorStore` (`update`, `queryByAgent`) and a field to `MemoryNode` (`lastAccessed`) — these are additive changes that don't break existing implementations. The `InMemoryVectorStore` must implement the full extended `VectorStore` interface. The `MemoryStoreImpl` (spec 004) does NOT need to be modified — it delegates to `VectorStore` which handles storage.
- **Importance decay rate**: The importance decay rate is `recencyDecayRate * 0.1` (10x slower than recency decay). This is a design decision: importance should be more persistent than recency. A memory from 100 ticks ago that was accessed 10 ticks ago has low recency but near-full effective importance. This ensures important memories remain retrievable even if they're old.
- **What NOT to do**:
  - Do not implement the `query_memory` cognitive tool — the retrieval mechanism is in scope, but the tool wiring is not.
  - Do not modify `LLMClient.completeReflection` or `memoryConsolidationSchema` — use them as-is.
  - Do not implement persistent vector store backends — only `InMemoryVectorStore`.
  - Do not modify `MemoryStore` or `MemoryStoreImpl` — build on top of them.
  - Do not modify the PPER orchestrator — memory maintenance runs independently.
  - Do not implement cognitive guardrails (§10).
  - Do not wire `MemoryInjectorImpl` into the Perceive phase — implement the injector, but the Perceive integration is separate.
  - Do not delete original memories during consolidation — deprioritize only.
  - Do not add `MemoryDecayConfig`, `DecayResult`, or `ConsolidationProvider` to `packages/memory/` or `packages/cognition/` — they belong in `shared`.
