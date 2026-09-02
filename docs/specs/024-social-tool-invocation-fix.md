# Feature: Social Tool Invocation Fix — Make LLM Call `talk_to` Directly When Agents Are Present

## Context
- Architecture: [§6 — PPER Loop](../architecture/06-pper-loop.md) (Plan phase, tool ordering), [§8 — Cognitive Tools](../architecture/08-cognitive-tools.md) (intrinsic tools, tool calling, mid-loop execution), [§9 — Engine Routing](../architecture/09-engine-routing.md) (action feedback loop), [§10 — Cognitive Guardrails](../architecture/10-cognitive-guardrails.md) (contextual forcing)
- Related specs: [015 — Full Cognitive Tools](015-full-cognitive-tools.md) (tool call loop, `COGNITIVE_TOOL_NAMES`, cognitive tool execution), [018 — Multi-Agent Social](018-multi-agent-social.md) (social tools, `talk_to`, `observe_agent`, `help`, `ignore`, social drive hint), [016 — Cognitive Guardrails](016-cognitive-guardrails.md) (contextual forcing, system prompt directives), [019 — Affordance-as-Tools](019-affordance-as-tools.md) (tool ordering, terminal vs. cognitive tools), [021 — KV Cache Prompt Optimization](021-kv-cache-prompt-optimization.md) (system prompt stability)
- Package: `cognition` (builder tool ordering, system prompt updates, social forcing directive)
- ADR: [ADR-0001 — Lean Monorepo Structure](../adr/0001-lean-monorepo-structure.md)
- Issue: [#98](https://github.com/Redna/evol-hive/issues/98)

## Design Rationale

**Problem**: When agents are co-located, the LLM is presented with social tools (`talk_to`, `observe_agent`, `help`, `ignore`) alongside `formulate_plan` in the Plan phase. Despite prompt hints like "You can call talk_to, observe_agent, help, or ignore directly" and "You feel a strong need for social interaction," gemma4 consistently calls `formulate_plan` instead of `talk_to`. Diagnostic runs show 0 social interactions across 91 PPER cycles.

**Root cause analysis**: Three factors contribute:

1. **Tool ordering bias**: In both `PlanBuilderImpl` and `PerceptionBuilderImpl`, social tools are appended to the END of the tools array: `[formulatePlanTool, queryMemoryTool, updateInternalStateTool, ...affordanceTools, talkToTool, observeAgentTool, helpTool, ignoreTool]`. Research on smaller LLMs (7B–14B parameters) shows a strong positional bias — tools listed first are called more frequently. `formulate_plan` is always first, making it the default choice.

2. **Weak directive phrasing**: The existing prompt hint uses hedging language ("Consider using talk_to or help"). The system prompt says "You must formulate a plan" with no conditional for social situations. This creates a competing instruction — the system prompt says "plan" while the user message says "consider social tools." Smaller models resolve conflicts toward the system prompt.

3. **No forcing mechanism**: The guardrail system (spec 016) provides contextual forcing for the "no plan" case (forcing the agent to plan). There is no equivalent forcing for the social case — when agents are present and social drive is urgent, nothing forces the LLM toward social tools over planning.

**Solution**: This spec combines the issue's proposed solutions A (stronger prompt) and B (reorder tools) into a single, low-risk change:

- **B — Reorder social tools first**: When agents are present, social tools (`talk_to`, `observe_agent`, `help`, `ignore`) are placed BEFORE `formulate_plan` and other cognitive tools in the tools array. This leverages positional bias in favor of social interaction. This is the primary fix.

- **A — Stronger system prompt directive**: When agents are present, the Plan phase system prompt is extended with a conditional directive: "When other agents are present and your social drive is urgent, call talk_to, observe_agent, help, or ignore directly — do not use formulate_plan for social actions." This replaces the hedging "consider using" language with a direct imperative. The directive is added to the dynamic portion of the user message (not the frozen system prompt prefix) to preserve KV cache stability (spec 021).

- **Social forcing** (simplified version of C): When `agentsPresent` is non-empty AND the primary drive label contains "social", `formulate_plan` is moved to the END of the tools array (after all other tools). This is a stronger version of B — instead of just placing social tools first, we actively demote `formulate_plan` to last position, making it the least likely choice. This is not a full two-phase approach (the tools remain available in a single request) but achieves a similar effect through ordering.

**Why not D (affordance mapping)**: Registering `talk_to` as an affordance would place it in the Execute phase's affordance resolution path, but `talk_to` requires a `message` argument that the affordance system cannot express (spec 018 design rationale explicitly chose cognitive tools for this reason). This would require re-architecting the affordance system. The tool ordering + prompt fix is far less invasive and directly addresses the root cause.

**Why not full C (two-phase plan)**: Splitting the Plan phase into "social plan" and "action plan" would add a new phase boundary, require changes to the PPER orchestrator, and double the LLM calls when agents are present. The tool reordering approach achieves the same goal (prioritize social actions) without architectural changes.

**Risk assessment**: Tool reordering is a prompt-engineering change, not an architectural change. The tool call loop (spec 015) already handles all four social tools as mid-loop cognitive tools — they execute and feed results back to the LLM. Reordering the tools array does not change execution logic; it only changes which tool the LLM is biased toward calling first. The social drive hint (spec 018, Req 39) and social context lines remain unchanged. The only changes are array order and prompt wording.

## Requirements

### Cognition Layer — Plan Builder (`@evol-hive/cognition`)

1. **Social tools first in Plan phase tool ordering** — The `buildPlanTools` function in `packages/cognition/src/pper/plan-builder.ts` must place social tools (`talkToTool`, `observeAgentTool`, `helpTool`, `ignoreTool`) BEFORE `formulatePlanTool`, `queryMemoryTool`, `updateInternalStateTool`, and affordance tools when `hasAgentsPresent` is `true`. The new ordering must be:
   ```typescript
   // When agents are present:
   [talkToTool, observeAgentTool, helpTool, ignoreTool, formulatePlanTool, queryMemoryTool, updateInternalStateTool, ...affordanceTools]
   ```
   When no agents are present, the ordering remains unchanged:
   ```typescript
   [formulatePlanTool, queryMemoryTool, updateInternalStateTool, ...affordanceTools]
   ```
   This leverages the documented positional bias of smaller LLMs (gemma4, kimi) toward first-listed tools.

2. **Social drive urgency demotes `formulate_plan` to last** — When `hasAgentsPresent` is `true` AND the primary drive label contains "social" (case-insensitive), `formulatePlanTool` must be moved to the very end of the tools array — after social tools, cognitive tools, AND affordance tools. This is a stronger version of Req 1: social tools are still first, but `formulate_plan` becomes the least likely choice rather than just not-first. The ordering must be:
   ```typescript
   // When agents present AND social is primary drive:
   [talkToTool, observeAgentTool, helpTool, ignoreTool, queryMemoryTool, updateInternalStateTool, ...affordanceTools, formulatePlanTool]
   ```
   When agents are present but social is NOT the primary drive, the ordering from Req 1 applies (social tools first, `formulate_plan` in its normal position after social tools).

3. **Stronger social directive in Plan phase user message** — When `hasAgentsPresent` is `true`, the `PlanBuilderImpl.build()` method must add a directive line to the dynamic portion of `perceptionContext` (after the existing social context lines, before the `---` separator's dynamic section). The directive text must be:
   ```
   IMPORTANT: Other agents are present. Call talk_to, observe_agent, help, or ignore directly to interact with them. Do not use formulate_plan for social actions.
   ```
   This replaces the existing softer hint (`'You can call talk_to, observe_agent, help, or ignore directly to interact with other agents.'`) which remains in the stable section as informational context. The new directive is in the dynamic section because its presence depends on whether agents are currently present (which can change per tick).

4. **Stronger social drive hint** — When `hasAgentsPresent` is `true` AND the primary drive label contains "social" (case-insensitive), the existing social drive hint must be strengthened from:
   ```
   You feel a strong need for social interaction. Consider using talk_to or help to engage with other agents in the room.
   ```
   to:
   ```
   Your social drive is your most urgent need. Call talk_to or help NOW to interact with another agent in this room. Do not formulate a plan first.
   ```
   This replaces the hedging "Consider using" with an imperative "Call ... NOW" and adds "Do not formulate a plan first" to directly counter the system prompt's "You must formulate a plan" instruction.

### Cognition Layer — Perception Builder (`@evol-hive/cognition`)

5. **Social tools first in Perception/Action phase** — The `PerceptionBuilderImpl.build()` method must place social tools (`talkToTool`, `observeAgentTool`, `helpTool`, `ignoreTool`) BEFORE `queryMemoryTool`, `updateInternalStateTool`, and affordance tools when `hasAgentsPresent` is `true`. The new ordering must be:
   ```typescript
   // When agents are present (normal, non-masked path):
   [talkToTool, observeAgentTool, helpTool, ignoreTool, queryMemoryTool, updateInternalStateTool, ...affordanceTools]
   ```
   When affordance masking is active (`noPlan && maskingEnabled`), social tools are still placed first:
   ```typescript
   [talkToTool, observeAgentTool, helpTool, ignoreTool, ...cognitiveToolDefinitions]
   ```
   When no agents are present, the ordering remains unchanged.

6. **Stronger social directive in Perception phase** — When `hasAgentsPresent` is `true`, the `PerceptionBuilderImpl.build()` method must add the same directive line as Req 3 to the dynamic portion of `perceptionContext`:
   ```
   IMPORTANT: Other agents are present. Call talk_to, observe_agent, help, or ignore directly to interact with them.
   ```
   (Note: the Perception/Action phase does not have `formulate_plan` in its tools by default, so the "do not use formulate_plan" portion is omitted here. The directive focuses on encouraging direct social tool use.)

### Cognition Layer — System Prompt (Both Builders)

7. **Conditional social directive in Plan system prompt** — The `buildSystemPrompt` function in `plan-builder.ts` must accept an optional `hasAgentsPresent: boolean` parameter. When `true`, the system prompt must include the following directive appended to the existing prompt text:
   ```
   When other agents are present and your social drive is urgent, call talk_to, observe_agent, help, or ignore directly — do not use formulate_plan for social actions.
   ```
   This directive is added AFTER the existing "You must formulate a plan..." sentence, creating a conditional override. The persona-prefixed and generic system prompts both include this when agents are present. When `hasAgentsPresent` is `false` or `undefined`, the system prompt is unchanged (preserving KV cache stability for the non-social case, per spec 021).

   **KV cache impact note**: The system prompt changes when agents enter/leave the room. This is acceptable because agent presence already changes the user message (stable section includes "Agents present: ..." lines), so the KV cache prefix already breaks on room-entry events. The system prompt change is aligned with an existing cache-break event.

### Cognition Layer — LLM Client (No Changes)

8. **No changes to tool call loop or `COGNITIVE_TOOL_NAMES`** — The LLM client's tool call loop (`openai-client.ts`) is NOT modified. The four social tools remain mid-loop cognitive tools in `COGNITIVE_TOOL_NAMES`. The tool execution handlers (`executeTalkTo`, `executeObserveAgent`, `executeHelp`, `executeIgnore`) are unchanged. The fix is purely in tool ordering and prompt content — the execution path is already correct.

### Cross-Cutting

9. **Package boundaries** (per ADR-0001) — All changes are in:
   - `packages/cognition/src/pper/plan-builder.ts` (tool ordering, system prompt directive, user message directive, social drive hint strengthening)
   - `packages/cognition/src/pper/perception-builder.ts` (tool ordering, user message directive)
   - `docs/specs/INDEX.md` (spec 024 added)
   No changes to `packages/shared/`, `packages/engine/`, `packages/memory/`, or `examples/`. No new npm dependencies. No changes to types, interfaces, or schemas.

10. **Backward compatibility** — When no agents are present, all builders produce identical output to the current implementation (same tool order, same system prompt, same user message). Existing tests that do not involve co-located agents pass without modification. Tests that verify tool ordering with agents present must be updated to reflect the new ordering.

11. **What NOT to do**:
   - Do not register `talk_to` as a physical affordance (Solution D from the issue) — it requires a `message` argument the affordance system cannot express.
   - Do not split the Plan phase into separate "social plan" and "action plan" phases (Solution C full) — this would double LLM calls and require PPER orchestrator changes.
   - Do not modify `COGNITIVE_TOOL_NAMES` or the tool call loop in `openai-client.ts`.
   - Do not modify the `CognitiveToolExecutor` interface or `CognitiveToolExecutorImpl`.
   - Do not modify `packages/shared/`, `packages/engine/`, or `packages/memory/`.
   - Do not modify the `LLMClient` interface.
   - Do not add new npm dependencies.
   - Do not remove the existing social context lines ("Agents present: ...", "You can call talk_to...") from the stable section — the new directive is additive.
   - Do not change the frozen system prompt prefix for the no-agents case (spec 021 KV cache optimization must remain intact when agents are absent).
   - Do not implement relationship decay or social drive mechanics changes — those are out of scope.

## Acceptance Criteria

- [ ] **AC-1**: `PlanBuilderImpl.build()` with `agentsPresent` non-empty returns a payload whose `tools` array has `talkToTool`, `observeAgentTool`, `helpTool`, `ignoreTool` as the first four elements, followed by `formulatePlanTool`, `queryMemoryTool`, `updateInternalStateTool`, and affordance tools. *(Req 1)*
- [ ] **AC-2**: `PlanBuilderImpl.build()` with no agents present returns a payload whose `tools` array starts with `formulatePlanTool, queryMemoryTool, updateInternalStateTool, ...affordanceTools` — unchanged from current behavior. *(Req 1)*
- [ ] **AC-3**: `PlanBuilderImpl.build()` with `agentsPresent` non-empty AND `primaryDriveLabel` containing "social" returns a payload where `formulatePlanTool` is the LAST element in the `tools` array (after social tools, cognitive tools, and affordance tools). *(Req 2)*
- [ ] **AC-4**: `PlanBuilderImpl.build()` with `agentsPresent` non-empty AND `primaryDriveLabel` containing "social" returns a payload where the first four tools are still `talkToTool, observeAgentTool, helpTool, ignoreTool`. *(Req 2)*
- [ ] **AC-5**: `PlanBuilderImpl.build()` with `agentsPresent` non-empty includes the directive `"IMPORTANT: Other agents are present. Call talk_to, observe_agent, help, or ignore directly to interact with them. Do not use formulate_plan for social actions."` in `perceptionContext`. *(Req 3)*
- [ ] **AC-6**: `PlanBuilderImpl.build()` with no agents present does NOT include the social directive in `perceptionContext`. *(Req 3)*
- [ ] **AC-7**: `PlanBuilderImpl.build()` with `agentsPresent` non-empty AND `primaryDriveLabel` containing "social" includes `"Your social drive is your most urgent need. Call talk_to or help NOW to interact with another agent in this room. Do not formulate a plan first."` in `perceptionContext` (replacing the old "Consider using" hint). *(Req 4)*
- [ ] **AC-8**: `PlanBuilderImpl.build()` with `agentsPresent` non-empty AND `primaryDriveLabel` NOT containing "social" does NOT include the strengthened hint from AC-7 (the old hint is also not present — the strengthened hint only appears when social is the primary drive). *(Req 4)*
- [ ] **AC-9**: `PlanBuilderImpl.build()` system prompt with `hasAgentsPresent = true` includes `"When other agents are present and your social drive is urgent, call talk_to, observe_agent, help, or ignore directly — do not use formulate_plan for social actions."` *(Req 7)*
- [ ] **AC-10**: `PlanBuilderImpl.build()` system prompt with `hasAgentsPresent = false` (or no agents present) does NOT include the social directive — the system prompt is identical to the current implementation. *(Req 7)*
- [ ] **AC-11**: `PerceptionBuilderImpl.build()` with `agentsPresent` non-empty (normal, non-masked path) returns a payload whose `tools` array has `talkToTool, observeAgentTool, helpTool, ignoreTool` as the first four elements, followed by `queryMemoryTool, updateInternalStateTool`, and affordance tools. *(Req 5)*
- [ ] **AC-12**: `PerceptionBuilderImpl.build()` with `agentsPresent` non-empty AND affordance masking active (`noPlan && maskingEnabled`) returns a payload whose `tools` array starts with `talkToTool, observeAgentTool, helpTool, ignoreTool` followed by cognitive tool definitions. *(Req 5)*
- [ ] **AC-13**: `PerceptionBuilderImpl.build()` with no agents present returns a payload whose `tools` array does NOT include any social tools — unchanged from current behavior. *(Req 5)*
- [ ] **AC-14**: `PerceptionBuilderImpl.build()` with `agentsPresent` non-empty includes `"IMPORTANT: Other agents are present. Call talk_to, observe_agent, help, or ignore directly to interact with them."` in `perceptionContext`. *(Req 6)*
- [ ] **AC-15**: `PerceptionBuilderImpl.build()` with no agents present does NOT include the social directive in `perceptionContext`. *(Req 6)*
- [ ] **AC-16**: No files in `packages/shared/`, `packages/engine/`, `packages/memory/`, or `examples/` are modified. No new npm dependencies are added. *(Req 9)*
- [ ] **AC-17**: `COGNITIVE_TOOL_NAMES` in `openai-client.ts` is unchanged — still contains `'talk_to'`, `'observe_agent'`, `'help'`, `'ignore'`, `'query_memory'`, `'update_internal_state'`. *(Req 8)*
- [ ] **AC-18**: The `CognitiveToolExecutor` interface and `CognitiveToolExecutorImpl` class are not modified. *(Req 8)*
- [ ] **AC-19**: `docs/specs/INDEX.md` is updated with spec 024 added with status 📝 Drafted. *(Req 9)*
- [ ] **AC-20**: An integration test: Two agents (Alice, Carol) are co-located in the same room. Alice's `primaryDriveLabel` contains "social". The `PlanBuilderImpl.build()` payload has social tools first and `formulatePlanTool` last in the tools array. The system prompt includes the social directive. The user message includes the strengthened social hint. A mock LLM that returns the first tool in the list calls `talk_to` (not `formulate_plan`). *(Req 1, Req 2, Req 3, Req 4, Req 7)*
- [ ] **AC-21**: An integration test: Two agents co-located, primary drive is "energy" (not social). The `PlanBuilderImpl.build()` payload has social tools first, `formulatePlanTool` in its normal position (after social tools, before cognitive tools). The strengthened social hint is NOT present. The social directive IS present (agents are present regardless of drive). *(Req 1, Req 3, Req 4)*
- [ ] **AC-22**: Existing tests that create `PlanBuilderImpl` or `PerceptionBuilderImpl` payloads with no agents present pass without modification — tool ordering, system prompt, and user message are identical to the current implementation. *(Req 10)*
- [ ] **AC-23**: A diagnostic run (60s, gemma4) with two agents co-located in the same room shows at least 1 `talk_to` tool call within 60s. *(Issue AC-1)*
- [ ] **AC-24**: After a `talk_to` call between two agents, relationships form with `trust > 0` and `familiarity > 0` for both agents. *(Issue AC-2)*
- [ ] **AC-25**: After a `talk_to` call, the calling agent's `social` drive increases (social drive value goes up by at least 10). *(Issue AC-3)*

## Constraints

- **Package boundaries** (per ADR-0001): All changes are confined to `packages/cognition/src/pper/plan-builder.ts` and `packages/cognition/src/pper/perception-builder.ts`. No changes to `packages/shared/`, `packages/engine/`, `packages/memory/`, or `examples/`. No new npm dependencies.
- **No architectural changes**: The fix is purely prompt engineering and tool array reordering. No new types, interfaces, schemas, or execution paths. The tool call loop, cognitive tool executor, social action bridge, and PPER orchestrator are unchanged.
- **KV cache awareness** (per spec 021): The system prompt change (Req 7) only activates when agents are present. When no agents are present, the system prompt is byte-identical to the current implementation, preserving the KV cache prefix for the common case. The system prompt change is aligned with the existing cache-break event (agent presence already changes the user message).
- **Backward compatibility**: When no agents are present, all builder output is identical to the current implementation. Existing tests for the no-agents case pass without modification. Tests for the agents-present case must be updated to reflect new tool ordering and prompt content.
- **No removal of existing context**: The existing social context lines ("Agents present: ...", "You can call talk_to...") in the stable section remain. The new directive (Req 3, Req 6) is additive — it appears in the dynamic section alongside the existing lines.
- **What NOT to do**:
  - Do not register `talk_to` as a physical affordance (Solution D).
  - Do not split the Plan phase into two sub-phases (Solution C full).
  - Do not modify the tool call loop, `COGNITIVE_TOOL_NAMES`, or `CognitiveToolExecutorImpl`.
  - Do not modify `packages/shared/`, `packages/engine/`, `packages/memory/`, or `examples/`.
  - Do not change the frozen system prompt for the no-agents case.
  - Do not implement relationship decay, social drive mechanics, or new social tools.
  - Do not add new npm dependencies.
  - Do not remove existing social context lines from the stable section.
