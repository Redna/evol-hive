# Feature: KV Cache Prompt Optimization — Freeze Prompt Prefix for Ollama Prompt Caching

## Context
- Architecture: [§6 PPER Loop](../architecture/06-pper-loop.md), [§7 Structured Outputs](../architecture/07-structured-outputs.md), [§8 Cognitive Tools](../architecture/08-cognitive-tools.md)
- Related specs: [002-plan-phase](002-plan-phase.md), [004-reflect-phase](004-reflect-phase.md), [011-structured-output-to-tool-calling](011-structured-output-to-tool-calling.md), [012-agent-persona-system](012-agent-persona-system.md), [019-affordance-as-tools](019-affordance-as-tools.md)
- Issue: [#86](https://github.com/Redna/evol-hive/issues/86)
- Package: cognition (primary), shared (if interface changes needed)

## Problem Summary

Every LLM call produces a unique prompt because drive values decay at 0.1/sec,
producing uncacheable decimal strings (e.g. `energy=19.998333333333335`). The
Ollama KV cache never hits, so every call pays full prompt token cost. Four
changes to the prompt construction layer can achieve an estimated 60–80% KV
cache hit rate and ~300–400 token savings per call.

## Requirements

### Req 1 — Remove primary drive label from PLAN system prompt
The PLAN system prompt must not contain the dynamic `primaryDriveLabel`. Replace
the sentence `"Your primary drive is: {label}."` with a static sentence
`"You must formulate a plan to satisfy your most urgent drive."` The drive label
remains in the user message (dynamic section).

### Req 2 — Reorder user message: stable content first, dynamic content last
All user messages produced by `PlanBuilderImpl`, `ReflectBuilderImpl`, and
`PerceptionBuilderImpl` must place stable content at the top of the
`perceptionContext` string and dynamic content at the bottom, separated by a
`---` marker on its own line. Content above `---` must be deterministic for a
given room + object set. Content below `---` includes drive labels, drive
values, execution results, and any other per-tick-mutating data.

### Req 3 — Round drive values to integers in user messages
The `formatDrives` helper in each builder must round drive values to the
nearest integer (`Math.round`) before formatting. E.g. `energy=19.998` →
`energy=20`. This applies to the `Drives:` line in the user message only;
internal state and engine computations continue to use full-precision floats.

### Req 4 — Remove cognitive tool descriptions from user message
The `buildUserMessage` method in `OpenAICompatibleLLMClient` must no longer
append the `Cognitive tools:\n…` block to the user message. Cognitive tool
descriptions are already sent as tool definitions via the `tools` API
parameter. The `cognitiveTools` field on `LLMContextPayload` may be retained
for internal use but must not be rendered into user-visible prompt text.

### Req 5 — Remove affordance text from user message (verify already done)
The user message must not contain an affordance list as text. Affordances are
sent as per-affordance tool definitions via the `tools` parameter (spec 019).
This was implemented in spec 019; this requirement verifies it remains true
after the other changes.

### Req 6 — PLAN system prompt is fully stable
After Req 1, the PLAN system prompt (including persona variant) must be
identical across all calls for a given agent persona. The only variable in the
system prompt is the persona text, which is stable for a given agent. The
guardrail forcing directive (`GUARDRAIL_FORCING_DIRECTIVE`) appended when
`!hasPlan && forcingEnabled` is an acceptable exception — it changes only on
plan completion, not every tick.

### Req 7 — REFLECT system prompt remains stable
The REFLECT system prompt is already stable (no dynamic content). This
requirement verifies it remains unchanged.

### Req 8 — Agent behavior unchanged
The agent must continue to brew coffee, gain energy, formulate plans, and
reflect correctly. The optimizations must not alter the semantic content
available to the LLM — only the ordering, formatting precision, and removal of
redundant tool descriptions.

## Acceptance Criteria

- [ ] **AC-1** (Req 1, Req 6): `PlanBuilderImpl.build()` produces a system prompt that does NOT contain the `primaryDriveLabel` string. Two calls with different `primaryDriveLabel` values produce identical system prompts.
- [ ] **AC-2** (Req 7): `ReflectBuilderImpl.build()` system prompt is unchanged from current behavior — no dynamic content, identical across calls with different drive values.
- [ ] **AC-3** (Req 2): `PlanBuilderImpl.build()` perceptionContext contains a `---` separator line. All lines above `---` are stable for a given room + object set (Room, Objects, and any stable social context). All lines below `---` include `Primary drive:` and `Drives:`.
- [ ] **AC-4** (Req 2): `ReflectBuilderImpl.build()` perceptionContext contains a `---` separator line. Stable content (Aspirations, Execution result, Drive changes applied, Current goal, Plan status) is above `---`. Dynamic content (Drives with current values) is below `---`.
- [ ] **AC-5** (Req 2): `PerceptionBuilderImpl.build()` perceptionContext contains a `---` separator line. Stable content (Name, Tendencies, Room, Objects, Agents present, relationship context) is above `---`. Dynamic content (Primary drive, Drives, social context messages, system feedback) is below `---`.
- [ ] **AC-6** (Req 3): `formatDrives` in `PlanBuilderImpl` rounds values — `drives: { energy: 19.998 }` produces `energy=20`, not `energy=19.998333333333335`.
- [ ] **AC-7** (Req 3): `formatDrives` in `ReflectBuilderImpl` rounds values — same behavior as AC-6.
- [ ] **AC-8** (Req 3): `formatDrives` in `PerceptionBuilderImpl` rounds values — same behavior as AC-6.
- [ ] **AC-9** (Req 4): `OpenAICompatibleLLMClient.buildUserMessage()` output does NOT contain the substring `"Cognitive tools:"`.
- [ ] **AC-10** (Req 5): `OpenAICompatibleLLMClient.buildUserMessage()` output does NOT contain affordance labels as a text list (affordances appear only as tool definitions in the `tools` parameter).
- [ ] **AC-11** (Req 8): All existing tests in `packages/cognition/tests/` pass without modification (test expectations that assert on specific perceptionContext ordering or cognitive tool text must be updated to match the new format — these are test-maintenance changes, not behavior changes).
- [ ] **AC-12** (Req 8): Integration test confirms agent still brews coffee and energy increases after optimization (existing integration test or smoke test).

## Constraints

- **Package boundaries**: Only `packages/cognition` (builders, LLM client) may be modified. The `LLMContextPayload` interface in `packages/cognition/src/index.ts` may keep the `cognitiveTools` field (it's used internally) but its rendering must be suppressed. No changes to `packages/engine` or `packages/memory`.
- **No semantic loss**: The LLM must still receive all information it had before — drive labels, drive values (rounded), room, objects, execution results, goals, plan status. Only ordering and formatting precision change.
- **Rounding scope**: `Math.round` applies ONLY to the user message display. The `AgentInternalState.drives` object, engine decay calculations, and any comparisons must continue to use full-precision floats.
- **Separator format**: The `---` separator must be on its own line, preceded and followed by a newline, so it is a clear boundary token for KV cache prefix matching.
- **Social context ordering**: In the Plan and Perception builders, `Agents present` and relationship context lines are stable for a given room state and should go above `---`. Social context messages (incoming messages from other agents) are dynamic and go below `---`.
- **System feedback**: `System feedback` and `stuck` warnings are dynamic (change per tick) and go below `---`.
- **Compound actions / object dependencies**: These are stable for a given room state and go above `---`.
- **Persona**: Persona text in system prompts is stable per agent — no change needed. Persona context lines in user messages (Name, Tendencies) are stable and go above `---`.
- **Guardrail directive**: The `GUARDRAIL_FORCING_DIRECTIVE` appended to the system prompt when `!hasPlan && forcingEnabled` is an acceptable exception to full system prompt stability — it changes only on plan completion boundary, not every tick.
- **What NOT to do**: Do not change the `tools` array sent to the LLM API. Do not change tool schemas. Do not change the PPER orchestration loop. Do not change the engine or drive decay logic. Do not change `AgentInternalState` types.
