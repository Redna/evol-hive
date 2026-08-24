# Feature: Affordance-as-Tools — Replace `choose_action` with Per-Affordance Tool Definitions

## Context
- Architecture: [§7 — Structured Outputs](../architecture/07-structured-outputs.md) (tool calling), [§8 — Cognitive Tools](../architecture/08-cognitive-tools.md) (intrinsic tools as native tool definitions), [§6 — PPER Loop](../architecture/06-pper-loop.md) (Plan and Execute phases), [§10 — Cognitive Guardrails](../architecture/10-cognitive-guardrails.md) (affordance masking), [§4 — Smart Objects & Affordances](../architecture/04-smart-objects.md) (Affordance, SmartObject)
- Related specs: [011 — Structured Output to Tool Calling](011-structured-output-to-tool-calling.md) (introduced `choose_action` tool, `ToolDefinition`, `LLMContextPayload.tools` — this spec **supersedes** the `choose_action` portion), [015 — Full Cognitive Tools](015-full-cognitive-tools.md) (tool call loop, `COGNITIVE_TOOL_NAMES`, cognitive tool execution), [016 — Cognitive Guardrails](016-cognitive-guardrails.md) (affordance masking, plan validation), [013 — Richer Prototype Scenes](013-richer-prototype-scenes.md) (scene affordances, effects on drives)
- Package: `shared` (new helper, schema deprecation), `cognition` (builder changes, client response parsing, plan step parsing), `examples` (mock updates)
- ADR: [ADR-0001 — Lean Monorepo Structure](../adr/0001-lean-monorepo-structure.md)
- Issue: [#71](https://github.com/Redna/evol-hive/issues/71)

## Design Rationale

The LLM hallucinates affordance names. In Phase 4 validation testing, the LLM generates `targetAffordance: "make_coffee"` instead of the registered `brew_coffee`. The Execute phase silently skips the unknown step — the agent thinks it acted but nothing happens. Energy stays at 0.

**Root cause**: Affordances are currently presented as plain text in the user message (`"Available actions:\nid: brew_coffee, label: Brew coffee"`), and the LLM uses a `choose_action` tool with a free-text `action: { type: "string" }` field. There is no constraint forcing the LLM to use exact affordance IDs. Ollama does not enforce enum values — the enum is a soft hint, not a hard constraint (Test 2 in the issue confirmed this).

**Solution**: Register each affordance as a **separate tool** whose `name` IS the affordance ID. The LLM cannot call a non-existent tool — it must use the exact affordance ID. Test 3 in the issue confirmed this approach works: `LLM called: brew_coffee ✅ (exact tool name — cannot call non-existent tools)`.

This change affects two PPER phases:

1. **Plan phase**: `formulate_plan` step `targetAffordance` values must reference real affordance IDs. By presenting affordances as tools alongside `formulate_plan`, the LLM sees the exact tool names and uses them in plan steps.

2. **Perception/Action phase**: The `choose_action` tool is removed. Each available affordance becomes a tool the LLM can call directly. The LLM calls `brew_coffee(...)` instead of `choose_action(action: "brew_coffee")`. The engine maps the tool name to the affordance.

**Key insight**: The tool call loop from spec 015 already distinguishes cognitive tools (executed mid-loop) from terminal tools (returned as the phase result). Affordance tools are **terminal tools** — when the LLM calls one, the loop terminates and the tool name + arguments become the action response. This requires updating `completeStructured` to interpret affordance tool calls as `LLMActionResponse` objects.

**Guardrail interaction**: When affordance masking is active (agent has no plan), affordance tools are excluded from the tools list. Only cognitive tools remain, forcing the agent to plan first. This replaces the current approach of removing `chooseActionTool` and keeping cognitive tools.

**Plan step format flexibility**: Testing revealed that kimi-k2.6 returns `steps: ["brew_coffee"]` (string array) instead of `[{ description: "...", targetAffordance: "brew_coffee" }]` (object array). The plan parser must handle both formats.

## Requirements

### Shared Layer (`@evol-hive/shared`)

1. **`affordanceToToolDefinition` helper** — A new function must be exported from `packages/shared/src/schemas/llm-schemas.ts` that converts an `Affordance` to a `ToolDefinition`:
   ```typescript
   function affordanceToToolDefinition(affordance: Affordance): ToolDefinition
   ```
   The tool name is `affordance.id`. The tool description is `affordance.label` plus a summary of `affordance.effects` (e.g., `"Brew coffee. Effects: energy +20."`). The tool `parameters` is an empty object schema `{ type: 'object', properties: {}, additionalProperties: false }` when the affordance has no parameters. This is the common case — most affordances take no arguments.

2. **`affordancesToToolDefinitions` helper** — A convenience function must be exported from `packages/shared/src/schemas/llm-schemas.ts`:
   ```typescript
   function affordancesToToolDefinitions(affordances: Affordance[]): ToolDefinition[]
   ```
   Maps each affordance through `affordanceToToolDefinition`. Returns an empty array for empty input.

3. **`formatAffordanceEffects` helper** — A helper function must be exported from `packages/shared/src/schemas/llm-schemas.ts` that formats an affordance's `effects` into a human-readable string for the tool description:
   ```typescript
   function formatAffordanceEffects(effects: Partial<Record<string, number>>): string
   ```
   For example, `{ energy: 20 }` → `"energy +20"`, `{ comfort: -5, energy: 10 }` → `"comfort -5, energy +10"`. Returns `"none"` for an empty effects object. The tool description is then `"{label}. Effects: {formatted effects}."`.

4. **`chooseActionTool` deprecated (not removed)** — The `chooseActionTool` constant in `packages/shared/src/schemas/llm-schemas.ts` must be marked as deprecated via a JSDoc `@deprecated` comment. It is NOT removed from the codebase — it remains exported for backward compatibility and for any code paths that still reference it during the transition. The `llmActionResponseSchema` is also NOT removed — it may be used by other tool definitions. No compile errors should result from existing imports of `chooseActionTool`.

5. **`AFFORDANCE_TOOL_PARAMETERS` constant** — An empty parameters schema constant must be exported from `packages/shared/src/schemas/llm-schemas.ts` for reuse:
   ```typescript
   const AFFORDANCE_TOOL_PARAMETERS = {
     type: 'object',
     properties: {},
     additionalProperties: false,
   } as const;
   ```
   This is used by `affordanceToToolDefinition` for affordances with no parameters. Affordances that accept arguments in the future can define their own parameter schemas.

### Cognition Layer — Builders (`@evol-hive/cognition`)

6. **`PerceptionBuilderImpl` builds affordance tools** — The `PerceptionBuilderImpl.build()` method must construct affordance tool definitions from `prunedAffordances` and include them in the `tools` array alongside cognitive tools:
   ```typescript
   const affordanceTools = affordancesToToolDefinitions(availableAffordances);
   const cognitiveToolDefs = [queryMemoryTool, updateInternalStateTool];
   // Social tools added when agents present (existing behavior)
   tools = [...cognitiveToolDefs, ...affordanceTools, ...socialTools];
   ```
   The `chooseActionTool` is NO LONGER included in the tools array. The `availableAffordances` field in the payload remains populated (for backward compatibility and user message text). The user message still lists available affordances as text (for LLM context), but the primary mechanism is now the tool definitions.

7. **Affordance masking in `PerceptionBuilderImpl`** — When affordance masking is active (`noPlan && maskingEnabled`), the affordance tools are excluded from the `tools` array. Only cognitive tools (and social tools when agents are present) remain. This replaces the current approach of removing `chooseActionTool` — now ALL affordance tools are removed. Cognitive tools including `formulate_plan` remain available so the agent can create a plan. The `availableAffordances` field is set to `[]` (existing behavior, spec 016, Req 10).

8. **`PlanBuilderImpl` includes affordance tools** — The `PlanBuilderImpl.build()` method must include affordance tool definitions from `prunedAffordances` in the `tools` array alongside `formulatePlanTool` and cognitive tools:
   ```typescript
   const affordanceTools = affordancesToToolDefinitions(prunedAffordances);
   tools = [formulatePlanTool, queryMemoryTool, updateInternalStateTool, ...affordanceTools, ...socialTools];
   ```
   This ensures the LLM sees the exact affordance IDs as tool names when formulating a plan. The LLM uses these tool names in the `targetAffordance` field of plan steps. The system prompt continues to instruct the LLM to "map each step to an available affordance when possible."

9. **Remove `"Available actions"` text from user message** — The `buildUserMessage()` method in `OpenAICompatibleLLMClient` must NO LONGER append the `"Available actions:\n..."` text block to the user message. The affordance list is now represented as tool definitions — the LLM sees them as tools, not as text. The user message contains only the perception context and cognitive tools text. The `availableAffordances` field remains on `LLMContextPayload` but is not rendered as text. (Cognitive tools text is retained for backward compatibility with mock LLM clients.)

### Cognition Layer — LLM Client Response Parsing (`@evol-hive/cognition`)

10. **`completeStructured` maps affordance tool calls to `LLMActionResponse`** — The `completeStructured(payload)` method must handle the case where the LLM calls an affordance tool (a tool whose name is NOT a cognitive tool name and NOT `choose_action`). When the LLM calls an affordance tool:
    - The tool name IS the action (e.g., `brew_coffee` → `action: "brew_coffee"`)
    - The tool arguments become `actionArgs` (typically `{}` for parameterless affordances)
    - The `reasoning` field is set to an empty string `""` (the LLM's reasoning is implicit in its tool choice — most LLMs don't provide a separate reasoning field when calling a non-`choose_action` tool)
    - The method returns `{ reasoning: "", action: <toolName>, actionArgs: <parsedArgs> }`
    When the LLM calls `choose_action` (backward compatibility), the existing parsing logic applies — extract `reasoning` and `action` from the arguments.
    When the LLM calls a cognitive tool name (e.g., `query_memory`), the tool call loop (spec 015) handles it — the cognitive tool is executed mid-loop and the loop continues.

11. **`COGNITIVE_TOOL_NAMES` unchanged** — The `COGNITIVE_TOOL_NAMES` set in `openai-client.ts` is NOT modified. It still contains `query_memory`, `update_internal_state`, `talk_to`, `observe_agent`, `help`, `ignore`. Affordance tool names are NOT added to this set — they are terminal tools, not cognitive tools. When the LLM calls an affordance tool, the tool call loop terminates (the tool name is not in `COGNITIVE_TOOL_NAMES`), and `requestChat` returns the parsed arguments. The caller (`completeStructured`) then maps the tool name to the action.

12. **`requestChat` returns tool name alongside arguments** — The `requestChat` method already returns the parsed arguments object. It must also make the called tool name available to the caller. This is achieved by modifying `requestChat` to return `{ toolName: string, args: Record<string, unknown> }` instead of just `Record<string, unknown>`. The terminal tool's name is returned alongside its parsed arguments. When the cognitive tool loop is active, the loop terminates when a terminal tool is called — the terminal tool's name and arguments are returned. When the loop is not active (no `cognitiveToolExecutor`), the single-request response's tool name and arguments are returned.

13. **`completePlan` handles string array step format** — The `completePlan(payload)` method's step parsing must handle both formats:
    - **Object format** (existing): `[{ description: "Brew coffee", targetAffordance: "brew_coffee" }]` — parsed as before, with alias mapping (`action`→`targetAffordance`, `affordance`→`targetAffordance`, `tool`→`targetAffordance`).
    - **String format** (new): `["brew_coffee"]` — each string is treated as the `targetAffordance` value. The `description` is set to the string itself (e.g., `"brew_coffee"`). This handles the kimi-k2.6 simplification documented in the issue (Test 5).
    The parser checks if each step element is a string — if so, it creates `{ description: <string>, targetAffordance: <string> }`. If the step element is an object, existing parsing logic applies. The `tool` field is added as a recognized alias for `targetAffordance` (in addition to existing aliases `action`, `affordance`, `target`).

14. **`completeReflect` and `completeReflection` unchanged** — These methods do not interact with affordances. Their parsing logic is not modified.

### Cognition Layer — Execute Phase Interaction

15. **Execute phase resolves affordance by tool name (exact match)** — The `ExecuteServiceImpl.execute()` method already resolves `step.targetAffordance` via `dataProvider.resolveAffordance(location, affordanceId)`. No change is needed to the execute service itself — the plan's `targetAffordance` values are already exact affordance IDs. The improvement comes from the Plan phase: the LLM now sees affordance IDs as tool names, so it generates correct `targetAffordance` values. The existing "skip unknown affordance" logic (advance step + system feedback) remains as a safety net for any residual hallucination.

16. **No changes to `ExecuteServiceImpl`** — The execute service is NOT modified. It already handles the case where `targetAffordance` doesn't resolve (skip step + feedback). The fix is preventive (correct affordance IDs in plans) rather than reactive (handling bad IDs in execute).

### Minimal Scene & Mocks (`examples/`)

17. **`MockLLMClient` updated for affordance-as-tools** — The `MockLLMClient` in `examples/minimal-scene.ts` must be updated to handle the new tools array that includes affordance tools. The mock should:
    - Read `payload.tools` and identify affordance tools (tools whose names are not cognitive tool names and not `choose_action`)
    - Return an `LLMActionResponse` with `action` set to the first affordance tool's name (simulating the LLM choosing an affordance)
    - For `completePlan`, return a `FormulatePlanResult` with `steps` whose `targetAffordance` values match the affordance tool names in the payload
    - The mock interface methods remain the same (they implement `LLMClient`)

18. **Existing example scenes continue to work** — `examples/minimal-scene.ts`, `examples/morning-routine.ts`, and `examples/office-day.ts` must compile and run without errors after the changes. No scene definitions are modified — the affordance-to-tool conversion happens at runtime in the builders.

### Cross-Cutting

19. **Architecture doc §7 update note** — The architecture doc `docs/architecture/07-structured-outputs.md` should be updated to reflect that affordances are now registered as individual tools rather than presented as text + `choose_action`. The tool table should note that the Execute phase's primary tool is now "per-affordance tools (dynamic)" instead of `choose_action`. This is a documentation-only change.

20. **Specs 011 `choose_action` portion superseded** — This spec supersedes the `choose_action` tool portion of spec 011. The `chooseActionTool` constant remains in the codebase (deprecated) but is no longer used by any builder. Spec 011's other contributions (`ToolDefinition` type, `LLMContextPayload.tools`, tool calling mechanism, response parsing) are NOT superseded — they are foundational and still in use. The status of spec 011 in `INDEX.md` remains ✅ Done (the spec was implemented; this spec evolves the approach).

21. **Package boundaries** (per ADR-0001) — All changes are in:
    - `packages/shared/src/schemas/llm-schemas.ts` (new helpers: `affordanceToToolDefinition`, `affordancesToToolDefinitions`, `formatAffordanceEffects`, `AFFORDANCE_TOOL_PARAMETERS`; `chooseActionTool` deprecation comment)
    - `packages/cognition/src/pper/perception-builder.ts` (affordance tools in `tools` array, masking logic)
    - `packages/cognition/src/pper/plan-builder.ts` (affordance tools in `tools` array)
    - `packages/cognition/src/llm/openai-client.ts` (`completeStructured` affordance tool mapping, `requestChat` return type, `completePlan` string array parsing, remove "Available actions" text)
    - `examples/minimal-scene.ts` (MockLLMClient update)
    - `docs/architecture/07-structured-outputs.md` (documentation update)
    - `docs/specs/INDEX.md` (spec 019 added)
    No changes to `packages/engine/` or `packages/memory/`. No new npm dependencies.

22. **What NOT to do**:
    - Do not remove `chooseActionTool` or `llmActionResponseSchema` from `@evol-hive/shared` — they are deprecated, not deleted. Existing imports must not break.
    - Do not modify `ExecuteServiceImpl` — the execute phase already handles affordance resolution by exact ID match.
    - Do not modify the `LLMClient` interface method signatures — only the internal implementation of `completeStructured` and `completePlan` changes.
    - Do not modify `COGNITIVE_TOOL_NAMES` — affordance tools are terminal, not cognitive.
    - Do not modify the `CognitiveToolExecutor` interface or `CognitiveToolExecutorImpl` — affordance tool calls are not executed mid-loop.
    - Do not add affordance-specific parameter schemas — all affordances use the empty parameters schema for now. Parameterized affordances are a future concern.
    - Do not modify `PerceptionServiceImpl`, `PlanServiceImpl`, `ReflectServiceImpl`, or `PPEROrchestratorImpl` — the builder changes are transparent to the services.
    - Do not remove the `availableAffordances` field from `LLMContextPayload` — it is retained for backward compatibility.
    - Do not remove the cognitive tools text from the user message — it is retained for backward compatibility with mock LLM clients.
    - Do not add new npm dependencies.
    - Do not implement streaming support.
    - Do not implement a tool call execution loop for affordance tools — they are terminal; the engine does not execute them via the LLM tool call loop. The engine executes them deterministically in the Execute phase.

## Acceptance Criteria

- [ ] **AC-1**: `affordanceToToolDefinition` is exported from `@evol-hive/shared` and converts an `Affordance` to a `ToolDefinition` with `function.name === affordance.id`, `function.description` containing `affordance.label` and formatted effects, and `function.parameters` being an empty object schema. *(Req 1, Req 5)*
- [ ] **AC-2**: `affordancesToToolDefinitions` is exported from `@evol-hive/shared` and maps an array of `Affordance` objects to an array of `ToolDefinition` objects. For an empty input array, it returns an empty array. *(Req 2)*
- [ ] **AC-3**: `formatAffordanceEffects({ energy: 20 })` returns `"energy +20"`. `formatAffordanceEffects({ comfort: -5, energy: 10 })` returns `"comfort -5, energy +10"`. `formatAffordanceEffects({})` returns `"none"`. *(Req 3)*
- [ ] **AC-4**: `chooseActionTool` is still exported from `@evol-hive/shared` and has a `@deprecated` JSDoc comment. Existing code that imports `chooseActionTool` compiles without errors. *(Req 4)*
- [ ] **AC-5**: `AFFORDANCE_TOOL_PARAMETERS` is exported from `@evol-hive/shared` and equals `{ type: 'object', properties: {}, additionalProperties: false }`. *(Req 5)*
- [ ] **AC-6**: `PerceptionBuilderImpl.build()` returns a payload whose `tools` array includes affordance tool definitions (one per available affordance) alongside cognitive tools (`queryMemoryTool`, `updateInternalStateTool`) and social tools (when agents are present). The `chooseActionTool` is NOT in the tools array. *(Req 6)*
- [ ] **AC-7**: When affordance masking is active (no plan + masking enabled), `PerceptionBuilderImpl.build()` returns a payload whose `tools` array contains only cognitive tools and social tools (when agents are present) — no affordance tool definitions. The `availableAffordances` field is `[]`. *(Req 7)*
- [ ] **AC-8**: `PlanBuilderImpl.build()` returns a payload whose `tools` array includes affordance tool definitions from `prunedAffordances` alongside `formulatePlanTool`, `queryMemoryTool`, `updateInternalStateTool`, and social tools (when agents are present). *(Req 8)*
- [ ] **AC-9**: `OpenAICompatibleLLMClient.buildUserMessage()` does NOT append `"Available actions:\n..."` to the user message. The user message contains only the perception context and cognitive tools text. *(Req 9)*
- [ ] **AC-10**: When the LLM calls an affordance tool (e.g., `brew_coffee`) in response to a `completeStructured` request, the method returns an `LLMActionResponse` with `action === "brew_coffee"`, `actionArgs === {}` (or the parsed arguments), and `reasoning === ""`. *(Req 10)*
- [ ] **AC-11**: When the LLM calls `choose_action` in response to a `completeStructured` request (backward compatibility), the method returns an `LLMActionResponse` with `reasoning` and `action` extracted from the tool arguments as before. *(Req 10)*
- [ ] **AC-12**: `COGNITIVE_TOOL_NAMES` in `openai-client.ts` is unchanged — it still contains `query_memory`, `update_internal_state`, `talk_to`, `observe_agent`, `help`, `ignore` and does NOT contain any affordance IDs. *(Req 11)*
- [ ] **AC-13**: `requestChat` returns an object `{ toolName: string, args: Record<string, unknown> }` where `toolName` is the called tool's name and `args` is the parsed arguments. A unit test with a mock `fetch` response returning `tool_calls[0].function.name = "brew_coffee"` verifies `toolName === "brew_coffee"`. *(Req 12)*
- [ ] **AC-14**: `completePlan` correctly parses plan steps in object format: `[{ description: "Brew coffee", targetAffordance: "brew_coffee" }]` → steps with `description: "Brew coffee"`, `targetAffordance: "brew_coffee"`. *(Req 13)*
- [ ] **AC-15**: `completePlan` correctly parses plan steps in string format: `["brew_coffee"]` → steps with `description: "brew_coffee"`, `targetAffordance: "brew_coffee"`. *(Req 13)*
- [ ] **AC-16**: `completePlan` recognizes the `tool` field as an alias for `targetAffordance`: a step `{ description: "Brew", tool: "brew_coffee" }` → `targetAffordance: "brew_coffee"`. *(Req 13)*
- [ ] **AC-17**: `completeReflect` and `completeReflection` are unchanged — their parsing logic produces the same results as before. *(Req 14)*
- [ ] **AC-18**: `ExecuteServiceImpl` is not modified — the file `packages/cognition/src/pper/execute-service.ts` has no changes. *(Req 15, Req 16)*
- [ ] **AC-19**: `MockLLMClient` in `examples/minimal-scene.ts` reads `payload.tools`, identifies affordance tools, and returns an `LLMActionResponse` with `action` set to an affordance tool name. For `completePlan`, it returns a `FormulatePlanResult` with `targetAffordance` values matching affordance tool names. *(Req 17)*
- [ ] **AC-20**: `examples/minimal-scene.ts`, `examples/morning-routine.ts`, and `examples/office-day.ts` compile without errors. No scene definition files are modified. *(Req 18)*
- [ ] **AC-21**: All existing tests in `packages/cognition/tests/` and `packages/shared/tests/` pass (with updates to tests that explicitly check for `chooseActionTool` in the tools array or the "Available actions" text in the user message). *(Issue AC-7)*
- [ ] **AC-22**: A unit test verifies the end-to-end flow: `PerceptionBuilderImpl.build()` produces a payload with affordance tool definitions, `OpenAICompatibleLLMClient.completeStructured()` sends those tools in the request body, a mock `fetch` returns `tool_calls[0].function.name = "brew_coffee"`, and the parsed result is `{ reasoning: "", action: "brew_coffee", actionArgs: {} }`. *(Req 6, Req 10, Req 12)*
- [ ] **AC-23**: A unit test verifies the Plan phase end-to-end: `PlanBuilderImpl.build()` produces a payload with affordance tools alongside `formulatePlanTool`, a mock `fetch` returns `formulate_plan` tool call with `steps: ["brew_coffee"]`, and `completePlan` returns a `FormulatePlanResult` with `steps[0].targetAffordance === "brew_coffee"`. *(Req 8, Req 13, Req 15)*
- [ ] **AC-24**: `docs/specs/INDEX.md` is updated with spec 019 added with status 📝 Drafted. *(Req 21)*
- [ ] **AC-25**: No files in `packages/engine/` or `packages/memory/` are modified. No new npm dependencies are added. *(Req 21)*
- [ ] **AC-26**: When the LLM calls a cognitive tool (e.g., `query_memory`) during a `completeStructured` request with `cognitiveToolExecutor` wired, the tool call loop executes it mid-loop and continues — the affordance tools remain available for the next iteration. *(Req 11, Req 12)*

## Constraints

- **Package boundaries** (per ADR-0001): Changes are confined to `packages/shared/` (schema helpers, deprecation), `packages/cognition/` (builders, LLM client), `examples/` (mock updates), and `docs/` (architecture, specs index). No changes to `packages/engine/` or `packages/memory/`.
- **No external dependencies**: No new npm packages. The affordance-to-tool conversion uses existing `ToolDefinition` and `Affordance` types.
- **Backward compatible at the interface level**: The `LLMClient` interface is unchanged. The `LLMContextPayload` type is unchanged (the `tools` array now contains affordance tools, but the field type `ToolDefinition[]` is the same). The `availableAffordances` field is retained. Existing mock LLM clients that check `payload.tools` continue to work — they see more tools but the interface is the same.
- **`chooseActionTool` deprecated, not removed**: The constant remains exported with a `@deprecated` tag. No compile errors for existing imports. This allows a gradual transition — any code path still using `chooseActionTool` continues to compile.
- **Affordance tools are terminal**: When the LLM calls an affordance tool, the tool call loop terminates. The engine does NOT execute affordance tools via the tool call loop — execution happens deterministically in the Execute phase. Affordance tools in the LLM request are a selection mechanism, not an execution mechanism.
- **Dynamic tool list per tick**: Tools are rebuilt every perception/plan tick from the currently available affordances. When an affordance is no longer available (e.g., water depleted, conditions not met), its tool disappears from the list. The LLM cannot call it. This is inherent in the builder approach — builders read `prunedAffordances` (which already reflects availability) each tick.
- **Empty affordance parameters**: All affordances use the empty parameters schema `{ type: 'object', properties: {}, additionalProperties: false }`. Parameterized affordances (e.g., `talk_to` with `targetAgentId`) are cognitive tools, not physical affordances. If a future affordance needs parameters, `affordanceToToolDefinition` can be extended to accept a custom parameter schema.
- **What NOT to do**:
  - Do not remove `chooseActionTool`, `llmActionResponseSchema`, or the `availableAffordances` field.
  - Do not modify `ExecuteServiceImpl`, `COGNITIVE_TOOL_NAMES`, `CognitiveToolExecutor`, or PPER services.
  - Do not modify the `LLMClient` interface.
  - Do not add affordance IDs to `COGNITIVE_TOOL_NAMES`.
  - Do not implement parameterized affordance tools in this spec.
  - Do not add new npm dependencies.
  - Do not implement streaming or multi-turn affordance execution.
  - Do not remove cognitive tools text from the user message (backward compatibility).
