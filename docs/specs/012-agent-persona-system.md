# Feature: Agent Persona System — Personality, Backstory, Goals That Influence LLM Prompts

## Context
- Architecture: [§3 — Agent State Schema](../architecture/03-agent-state-schema.md) (AgentInternalState, AgentProfile, AgentDrives), [§6 — PPER Loop](../architecture/06-pper-loop.md) (all LLM calls in Perceive, Plan, Reflect), [§8 — Cognitive Tools](../architecture/08-cognitive-tools.md) (cognitive tool selection influenced by persona), [§11 — Memory Architecture](../architecture/11-memory-architecture.md) (persona-weighted memory importance), [§2 — System Overview](../architecture/02-system-overview.md) (package boundaries)
- Related specs: [001 — Perceive Phase](001-perceive-phase.md) (PerceptionBuilder, PerceptionResult, PerceptionDataProvider), [002 — Plan Phase](002-plan-phase.md) (PlanBuilder, PlanDataProvider), [003 — Execute Phase](003-execute-phase.md) (ExecuteDataProvider), [004 — Reflect Phase](004-reflect-phase.md) (ReflectBuilder, ReflectDataProvider, MemoryEntryInput), [005 — Game Loop Integration](005-game-loop-integration.md) (AgentProfile in SceneDefinition), [006 — OpenAI-Compatible LLM Client](006-openai-compatible-llm-client.md) (LLMContextPayload, system prompt flow)
- Package: `shared` (persona types), `cognition` (persona injection into builders), `engine` (persona storage and DataProvider bridge)
- ADR: [ADR-0001 — Lean Monorepo Structure](../adr/0001-lean-monorepo-structure.md)
- Issue: [#44](https://github.com/Redna/evol-hive/issues/44)

## Design Rationale

Currently, every agent receives the identical system prompt: `"You are an autonomous NPC in a deterministic simulation."` The agent's `AgentProfile` — with its name, description, and traits — is stored by the engine but never reaches the cognition layer. This makes all agents sound the same and removes any personality from their planning, perception, and reflection.

The fix is straightforward and follows the existing DataProvider bridge pattern: extend `AgentProfile` with persona fields, add `getAgentProfile` to the bridge interfaces, and inject the persona text into the builder system prompts. No new packages, no new architectural concepts — just wiring existing data through existing seams.

## Requirements

### Shared Layer (`@evol-hive/shared`)

1. **Extend `AgentProfile` with persona fields** — The existing `AgentProfile` interface in `packages/shared/src/types/agent.ts` must be extended with the following optional fields (all optional to maintain backward compatibility with existing scene definitions and tests):
   ```typescript
   interface AgentProfile {
     id: string;
     name: string;
     description: string;
     traits: string[];
     initialDrives: Partial<AgentDrives>;
     // ── New persona fields (all optional) ──
     /** A short backstory for the agent, injected into the LLM system prompt. */
     backstory?: string;
     /** Long-term goals and aspirations beyond the current drive-based goal. */
     longTermGoals?: string[];
     /** Behavioral tendencies (e.g., "risk-averse", "curious", "social", "methodical"). */
     behavioralTendencies?: string[];
     /** Speech style / tone preferences (e.g., "formal and precise", "casual and witty"). */
     speechStyle?: string;
     /** Relationships with other agents, keyed by agent ID. */
     relationships?: Record<string, string>;
   }
   ```
   The `relationships` field maps agent IDs to free-text relationship descriptions (e.g., `{ "agent-bob": "trusted colleague and coffee buddy" }`). This is intentionally a simple string map — not a structured sentiment graph — to keep the scope of this spec focused on LLM prompt injection. Structured social dynamics are a future concern (per ROADMAP "Multi-Agent Social").

2. **`PersonaText` type** — A new type alias `PersonaText` must be defined in `packages/shared/src/types/agent.ts`:
   ```typescript
   /** A formatted persona description string suitable for injection into LLM system prompts. */
   type PersonaText = string;
   ```
   This is returned by the `formatPersona` function (Req 3) and consumed by the builders.

3. **`formatPersona` function** — A new exported function `formatPersona(profile: AgentProfile): PersonaText` must be defined in `packages/shared/src/types/agent.ts`. It must produce a natural-language persona description string by composing the profile fields. The output format must be:
   - If `backstory` is present: include `"<name>: <backstory>"`.
   - If `traits` is non-empty: include `"Traits: <trait1>, <trait2>, ..."`.
   - If `behavioralTendencies` is non-empty: include `"Tendencies: <tendency1>, <tendency2>, ..."`.
   - If `speechStyle` is present: include `"Speech style: <speechStyle>"`.
   - If `longTermGoals` is non-empty: include `"Aspirations: <goal1>; <goal2>; ..."`.
   - If `relationships` is non-empty: include `"Relationships: <name1>: <desc1>; <name2>: <desc2>; ..."`.
   - If none of the new persona fields are present (only `name` and `description` exist), return the `description` field as the persona text (backward-compatible behavior for existing profiles).
   - The function must never return an empty string — if no persona fields are set at all, it returns the `name` as a fallback.

4. **`getAgentProfile` on `PerceptionDataProvider`** — A new method `getAgentProfile(agentId: string): AgentProfile | null` must be added to the `PerceptionDataProvider` interface in `packages/shared/src/types/cognition.ts`. This returns the agent's full `AgentProfile` (including the new persona fields) or `null` if the agent does not exist. This follows the existing `getAgentDrives` and `getAgentLocation` pattern — the engine implements it, cognition consumes it.

5. **`getAgentProfile` on `ReflectDataProvider`** — A new method `getAgentProfile(agentId: string): AgentProfile | null` must be added to the `ReflectDataProvider` interface in `packages/shared/src/types/cognition.ts`. Same contract as Req 4. This is needed because the `ReflectBuilder` needs the persona to construct its system prompt, and it does not receive a `PerceptionResult` (which would otherwise carry the persona).

6. **`persona` field on `PerceptionResult`** — A new optional field `persona?: AgentProfile | null` must be added to the `PerceptionResult` interface in `packages/shared/src/types/cognition.ts`. The `PerceptionServiceImpl` populates this field by calling `PerceptionDataProvider.getAgentProfile(agentId)` during the Perceive phase. The `PlanBuilder` reads it from the `PerceptionResult` (it already receives the full `PerceptionResult`). This avoids adding `getAgentProfile` to `PlanDataProvider` — the persona flows through `PerceptionResult`, not through a separate provider call.

### Cognition Layer (`@evol-hive/cognition`)

7. **`PerceptionBuilderImpl` persona injection** — The `PerceptionBuilderImpl.build(perceptionResult)` method in `packages/cognition/src/pper/perception-builder.ts` must inject the agent's persona into the `systemPrompt` when `perceptionResult.persona` is present and non-null. The system prompt must be prefixed with the persona text (produced by `formatPersona`) followed by the existing instruction text. The resulting format must be:
   ```
   You are <name>, <persona description from formatPersona>.
   You perceive your surroundings passively and choose one action per tick.
   Choose an affordance or a cognitive tool. Reason briefly before acting.
   ```
   When `perceptionResult.persona` is `null` or `undefined`, the system prompt must remain the current generic prompt (backward-compatible). The `perceptionContext` string must additionally include the agent's name when persona is present: prepend `"Name: <name>"` as the first line of the context.

8. **`PlanBuilderImpl` persona injection** — The `PlanBuilderImpl.build(perceptionResult)` method in `packages/cognition/src/pper/plan-builder.ts` must inject the agent's persona into the `systemPrompt` when `perceptionResult.persona` is present and non-null. The system prompt must start with the persona text, then continue with the plan-formulation instructions:
   ```
   You are <name>, <persona description from formatPersona>.
   You must formulate a plan to satisfy your most urgent drive.
   Your primary drive is: <primaryDriveLabel>.
   Use the formulate_plan cognitive tool to break your goal into a sequence of actionable steps.
   Each step should map to an available affordance when possible.
   ```
   When `perceptionResult.persona` is `null` or `undefined`, the system prompt remains the current generic prompt (backward-compatible).

9. **`ReflectBuilderImpl` persona injection** — The `ReflectBuilderImpl.build(agentId, agentState, executeResult, profile?)` method in `packages/cognition/src/pper/reflect-builder.ts` must accept an optional 4th parameter `profile?: AgentProfile | null` (the `ReflectBuilder` interface in `packages/cognition/src/index.ts` must be updated accordingly). When `profile` is present and non-null, the system prompt must start with the persona text:
   ```
   You are <name>, <persona description from formatPersona>.
   You must reflect on the outcome of your last action.
   Evaluate whether your goal or drives need adjustment based on what happened.
   Decide if a memory entry should be stored for future reference.
   Consider your personality when deciding what is worth remembering.
   Use the update_internal_state cognitive tool to adjust your goal, drives, or store a memory.
   ```
   The persona-specific instruction `"Consider your personality when deciding what is worth remembering."` must only appear when persona is present — it instructs the LLM to weight memory importance based on the agent's persona (Req 17). When `profile` is `null` or `undefined`, the system prompt remains the current generic prompt (backward-compatible).

10. **`ReflectBuilder` interface update** — The `ReflectBuilder` interface in `packages/cognition/src/index.ts` must be updated to:
    ```typescript
    interface ReflectBuilder {
      build(
        agentId: string,
        agentState: AgentInternalState,
        executeResult: ExecuteResult,
        profile?: AgentProfile | null,
      ): LLMContextPayload;
    }
    ```
    The 4th parameter `profile` is optional — existing callers that do not pass it still compile.

11. **`PerceptionServiceImpl` populates `persona`** — The `PerceptionServiceImpl` (in `packages/cognition/src/pper/index.ts`) must call `provider.getAgentProfile(agentId)` during the Perceive phase and include the result in the `PerceptionResult.persona` field. If `getAgentProfile` returns `null`, `persona` must be set to `null` (not `undefined`) so downstream code can distinguish "agent has no profile" from "profile field was not populated". If the `PerceptionDataProvider` does not implement `getAgentProfile` (e.g., older test mocks), the service must catch the missing method gracefully and set `persona` to `undefined`.

12. **`ReflectServiceImpl` passes persona to builder** — The `ReflectServiceImpl` (in `packages/cognition/src/pper/reflect-service.ts`) must call `dataProvider.getAgentProfile(agentId)` and pass the result as the 4th argument to `reflectBuilder.build(agentId, agentState, executeResult, profile)`. If `getAgentProfile` returns `null`, it passes `null`. If the `ReflectDataProvider` does not implement `getAgentProfile`, it catches the missing method gracefully and passes `undefined`.

### Engine Layer (`@evol-hive/engine`)

13. **`AgentManager` stores `AgentProfile`** — The `AgentManagerImpl` (in `packages/engine/src/agents/state/index.ts`) must store the `AgentProfile` alongside the `AgentInternalState` in an internal `Map<string, AgentProfile>`. The `spawn(profile)` method already receives the `AgentProfile` — it must store it. A new method `getProfile(agentId: string): AgentProfile | null` must be added to the `AgentManager` interface (in `packages/engine/src/agents/index.ts`) to retrieve it. The profile is immutable after spawn — there is no `updateProfile` method in this spec. The profile survives across PPER cycles because it is stored separately from the mutable `AgentInternalState`.

14. **`PerceptionDataProviderImpl.getAgentProfile`** — The `PerceptionDataProviderImpl` in `packages/engine/src/agents/` must implement the new `getAgentProfile(agentId)` method by delegating to `AgentManager.getProfile(agentId)`.

15. **`ReflectDataProviderImpl.getAgentProfile`** — The `ReflectDataProviderImpl` in `packages/engine/src/agents/` must implement the new `getAgentProfile(agentId)` method by delegating to `AgentManager.getProfile(agentId)`.

### Persona-Driven Behavior

16. **Persona in perception context** — When persona is present, the `PerceptionBuilderImpl` and `PlanBuilderImpl` must include the agent's name and behavioral tendencies in the `perceptionContext` string (not just the system prompt). This gives the LLM explicit access to the agent's tendencies when evaluating affordances. The context line format is: `"Name: <name>"` and (if tendencies exist) `"Tendencies: <tendency1>, <tendency2>, ..."`.

17. **Persona-weighted memory importance** — The `ReflectBuilderImpl` system prompt (when persona is present) must include an instruction for the LLM to weight memory importance based on the agent's persona: `"Consider your personality when deciding what is worth remembering."` This is a prompt-level influence — the actual `importance` field in `MemoryEntryInput` is still an LLM-assigned integer 1–10, but the LLM is instructed to assign higher importance to events that align with the agent's personality and long-term goals. No code-level importance adjustment is performed — this is entirely prompt-driven.

18. **Persona in goal-update guidance** — The `ReflectBuilderImpl` system prompt (when persona is present) must include the agent's `longTermGoals` in the context (if present) so the LLM can align goal updates with the agent's aspirations. The context line format is: `"Aspirations: <goal1>; <goal2>; ..."`. This is a prompt-level influence — the `newGoal` field in `ReflectLLMResponse` is still LLM-generated, but the LLM has context about what the agent cares about long-term.

### Cross-Cutting

19. **Backward compatibility** — All new `AgentProfile` fields are optional. All new DataProvider methods must be safely callable by older mock implementations (the services must catch "method not found" gracefully). The `ReflectBuilder.build()` 4th parameter is optional. Existing tests that create `AgentProfile` without persona fields and existing mock DataProviders without `getAgentProfile` must continue to compile and pass without modification.

20. **Package boundaries** (per ADR-0001) — `cognition` and `engine` must not directly import from each other. The `getAgentProfile` methods are defined in `@evol-hive/shared` (on the DataProvider interfaces) and implemented in `engine`. The `formatPersona` function and `PersonaText` type are defined in `@evol-hive/shared` and consumed by both `cognition` and `engine`. The `AgentProfile` type is already in `@evol-hive/shared` — this spec only extends it.

21. **No persona in Execute phase** — The Execute phase (`ExecuteServiceImpl`) is deterministic (System 0/engine physics) and does not call the LLM. Persona injection does not apply to the Execute phase. The `ExecuteDataProvider` does not need a `getAgentProfile` method.

22. **Persona is read-only** — The persona is immutable after agent spawn. No methods are added to modify the `AgentProfile` at runtime. Persona evolution (e.g., the agent's personality changing over time based on experiences) is a future concern and out of scope.

23. **Token budget** — The `formatPersona` function must produce a concise string (target: under 200 tokens). The `backstory` field is expected to be 1–3 sentences. The `behavioralTendencies` and `longTermGoals` arrays are expected to have 2–5 items each. The function does not truncate or summarize — it is the scene author's responsibility to keep these fields concise. If the persona text exceeds 500 characters, a warning is logged but no error is thrown.

24. **What NOT to do**:
    - Do not implement structured social dynamics or a relationship graph — `relationships` is a simple string map for prompt context only.
    - Do not implement persona evolution or personality drift — the profile is immutable after spawn.
    - Do not add persona to the `ExecuteDataProvider` or `ExecuteServiceImpl` — the Execute phase is deterministic and does not use the LLM.
    - Do not modify the `AgentInternalState` type — the persona lives in `AgentProfile`, not in the mutable runtime state.
    - Do not implement a separate `AgentPersona` type — the existing `AgentProfile` type is extended in place.
    - Do not add `getAgentProfile` to `PlanDataProvider` — the persona flows through `PerceptionResult.persona` to the PlanBuilder.
    - Do not change the `LLMClient` interface or LLM client implementations — persona injection happens in the builders, which produce `LLMContextPayload.systemPrompt` strings. The LLM client sends whatever system prompt it receives.
    - Do not implement per-affordance persona weighting in the System 0 classifier — the classifier is embedding-based and does not use the LLM. Persona influence on affordance prioritization is prompt-level (the LLM sees the persona when choosing among pruned affordances).
    - Do not add new npm dependencies.

## Acceptance Criteria

- [ ] **AC-1**: `AgentProfile` in `packages/shared/src/types/agent.ts` includes optional fields `backstory?: string`, `longTermGoals?: string[]`, `behavioralTendencies?: string[]`, `speechStyle?: string`, and `relationships?: Record<string, string>`. Existing code creating `AgentProfile` objects without these fields compiles without error. *(Req 1)*
- [ ] **AC-2**: `PersonaText` type alias is exported from `packages/shared/src/types/agent.ts`. *(Req 2)*
- [ ] **AC-3**: `formatPersona(profile: AgentProfile): PersonaText` is exported from `packages/shared/src/types/agent.ts`. Given a profile with `name: "Alice"`, `backstory: "A diligent researcher who runs on coffee"`, `traits: ["diligent", "caffeine-dependent"]`, `behavioralTendencies: ["risk-averse", "methodical"]`, `speechStyle: "precise and academic"`, `longTermGoals: ["finish thesis"]`, and `relationships: { "agent-bob": "trusted colleague" }`, the returned string contains "Alice", "diligent researcher who runs on coffee", "risk-averse", "methodical", "precise and academic", "finish thesis", and "trusted colleague". *(Req 3)*
- [ ] **AC-4**: `formatPersona` returns the `description` field when only `name` and `description` are set (no new persona fields). Given `{ name: "Alice", description: "A sleepy agent who needs coffee" }`, it returns `"A sleepy agent who needs coffee"`. *(Req 3)*
- [ ] **AC-5**: `formatPersona` returns the `name` as a fallback when no persona fields and no description are set. *(Req 3)*
- [ ] **AC-6**: `PerceptionDataProvider` interface in `packages/shared/src/types/cognition.ts` includes `getAgentProfile(agentId: string): AgentProfile | null`. *(Req 4)*
- [ ] **AC-7**: `ReflectDataProvider` interface in `packages/shared/src/types/cognition.ts` includes `getAgentProfile(agentId: string): AgentProfile | null`. *(Req 5)*
- [ ] **AC-8**: `PerceptionResult` interface in `packages/shared/src/types/cognition.ts` includes `persona?: AgentProfile | null`. *(Req 6)*
- [ ] **AC-9**: When `PerceptionBuilderImpl.build()` receives a `PerceptionResult` with `persona` set to a profile with `name: "Alice"` and `backstory: "A caffeine-dependent researcher"`, the returned `LLMContextPayload.systemPrompt` contains "Alice" and "caffeine-dependent researcher". *(Req 7)*
- [ ] **AC-10**: When `PerceptionBuilderImpl.build()` receives a `PerceptionResult` with `persona: null`, the returned `LLMContextPayload.systemPrompt` is the current generic prompt (does not contain any persona text). *(Req 7)*
- [ ] **AC-11**: When `PerceptionBuilderImpl.build()` receives a `PerceptionResult` with `persona` set, the returned `LLMContextPayload.perceptionContext` includes a line `"Name: Alice"` as the first line. *(Req 7, Req 16)*
- [ ] **AC-12**: When `PerceptionBuilderImpl.build()` receives a `PerceptionResult` with `persona` having `behavioralTendencies: ["curious", "social"]`, the `perceptionContext` includes `"Tendencies: curious, social"`. *(Req 16)*
- [ ] **AC-13**: When `PlanBuilderImpl.build()` receives a `PerceptionResult` with `persona` set to a profile with `name: "Alice"`, the returned `LLMContextPayload.systemPrompt` contains "Alice" and does not start with "You are an autonomous NPC". *(Req 8)*
- [ ] **AC-14**: When `PlanBuilderImpl.build()` receives a `PerceptionResult` with `persona: null`, the returned `LLMContextPayload.systemPrompt` is the current generic plan prompt. *(Req 8)*
- [ ] **AC-15**: `ReflectBuilder` interface in `packages/cognition/src/index.ts` accepts an optional 4th parameter `profile?: AgentProfile | null`. Existing code calling `build(agentId, agentState, executeResult)` without the 4th arg compiles without error. *(Req 10)*
- [ ] **AC-16**: When `ReflectBuilderImpl.build()` is called with a profile having `name: "Alice"` and `backstory: "A caffeine-dependent researcher"`, the returned `LLMContextPayload.systemPrompt` contains "Alice" and "caffeine-dependent researcher" and includes "Consider your personality when deciding what is worth remembering." *(Req 9, Req 17)*
- [ ] **AC-17**: When `ReflectBuilderImpl.build()` is called with `profile: null` (or no 4th arg), the returned `LLMContextPayload.systemPrompt` is the current generic reflect prompt and does not contain "Consider your personality". *(Req 9)*
- [ ] **AC-18**: When `ReflectBuilderImpl.build()` is called with a profile having `longTermGoals: ["finish thesis", "publish paper"]`, the `perceptionContext` includes `"Aspirations: finish thesis; publish paper"`. *(Req 18)*
- [ ] **AC-19**: `PerceptionServiceImpl` calls `provider.getAgentProfile(agentId)` and sets the result on `PerceptionResult.persona`. When the provider returns a profile, `persona` is that profile. When the provider returns `null`, `persona` is `null`. *(Req 11)*
- [ ] **AC-20**: When `PerceptionDataProvider` does not implement `getAgentProfile` (e.g., an older mock), `PerceptionServiceImpl` does not throw — it sets `persona` to `undefined`. *(Req 11, Req 19)*
- [ ] **AC-21**: `ReflectServiceImpl` calls `dataProvider.getAgentProfile(agentId)` and passes the result to `reflectBuilder.build(agentId, agentState, executeResult, profile)`. *(Req 12)*
- [ ] **AC-22**: When `ReflectDataProvider` does not implement `getAgentProfile`, `ReflectServiceImpl` does not throw — it passes `undefined` as the profile. *(Req 12, Req 19)*
- [ ] **AC-23**: `AgentManager` interface includes `getProfile(agentId: string): AgentProfile | null`. `AgentManagerImpl` stores the `AgentProfile` passed to `spawn(profile)` and returns it via `getProfile(agentId)`. After `spawn(profile)`, `getProfile(profile.id)` returns the same `AgentProfile` object. After `despawn(agentId)`, `getProfile(agentId)` returns `null`. *(Req 13)*
- [ ] **AC-24**: `PerceptionDataProviderImpl.getAgentProfile(agentId)` delegates to `AgentManager.getProfile(agentId)`. *(Req 14)*
- [ ] **AC-25**: `ReflectDataProviderImpl.getAgentProfile(agentId)` delegates to `AgentManager.getProfile(agentId)`. *(Req 15)*
- [ ] **AC-26**: An agent spawned with `{ name: "Alice", backstory: "A sleepy researcher", behavioralTendencies: ["cautious"] }` running through a full PPER cycle produces `LLMContextPayload.systemPrompt` strings in all three LLM-invoking phases (Perceive, Plan, Reflect) that contain "Alice" and "sleepy researcher". *(Req 7, Req 8, Req 9)*
- [ ] **AC-27**: An agent spawned with the old-style profile `{ name: "Alice", description: "A sleepy agent who needs coffee", traits: ["diligent"] }` (no new persona fields) running through a full PPER cycle produces `LLMContextPayload.systemPrompt` strings that contain "A sleepy agent who needs coffee" (via `formatPersona` falling back to `description`). *(Req 3, Req 7, Req 8, Req 9)*
- [ ] **AC-28**: `formatPersona` is called from `cognition` (builders) and imports from `@evol-hive/shared` only — no `cognition` → `engine` or `engine` → `cognition` imports. *(Req 20)*
- [ ] **AC-29**: The `ExecuteDataProvider` interface does not include `getAgentProfile`. The `ExecuteServiceImpl` does not call `getAgentProfile`. *(Req 21)*
- [ ] **AC-30**: No `updateProfile` or `setProfile` method exists on `AgentManager` or any DataProvider. The `AgentProfile` is read-only after spawn. *(Req 22)*
- [ ] **AC-31**: The `examples/minimal-scene.ts` agent profile (or any existing test profile) that does not set any new persona fields continues to work without modification — the system prompts fall back to the generic prompt or the `description` field. *(Req 19)*

## Constraints

- **Package boundaries** (per ADR-0001): `cognition` and `engine` must not directly import from each other. The `getAgentProfile` bridge methods are defined in `@evol-hive/shared` and implemented in `engine`. The `formatPersona` function is in `@evol-hive/shared` and consumed by `cognition` (builders). No new cross-package dependencies are introduced.
- **Backward compatibility**: All new `AgentProfile` fields are optional. All new DataProvider methods are added to interfaces (not replacing existing ones). The `ReflectBuilder.build()` 4th parameter is optional. Existing tests, mocks, and scene definitions must compile and pass without modification.
- **Graceful degradation**: When a DataProvider does not implement `getAgentProfile` (older mock), the services must not throw — they set `persona` to `undefined` and the builders fall back to the generic system prompt. This is important because many existing test mocks only implement the methods they need.
- **Persona is prompt-level influence**: The persona influences LLM behavior through the system prompt text. It does not change the structured output schemas, tool definitions, or affordance pruning logic. The System 0 classifier remains embedding-based and persona-agnostic. The LLM receives the persona in the system prompt and is expected to respond in character.
- **Persona is immutable**: The `AgentProfile` is stored at spawn time and never modified. No methods are added to change the profile at runtime. Persona evolution is a future concern.
- **No new types beyond `AgentProfile`**: Do not create a separate `AgentPersona` type. The existing `AgentProfile` is extended in place. This avoids type proliferation and keeps the data model simple.
- **Token budget**: The `formatPersona` function should produce under 200 tokens. It is the scene author's responsibility to keep persona fields concise. The function does not truncate — it logs a warning if the output exceeds 500 characters.
- **What NOT to do**:
  - Do not implement structured social dynamics or a relationship graph.
  - Do not implement persona evolution or personality drift.
  - Do not add persona to the Execute phase (it is deterministic, no LLM).
  - Do not modify `AgentInternalState` — persona lives in `AgentProfile`.
  - Do not change the `LLMClient` interface or LLM client implementations.
  - Do not modify the System 0 classifier to be persona-aware.
  - Do not add new npm dependencies.
