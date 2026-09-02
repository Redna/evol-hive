# Implementation Notes — Spec 024 (Social Tool Invocation Fix, Issue #98)

## What was built

### Cognition layer (`@evol-hive/cognition`)

All changes are confined to two files in the cognition package:

#### `packages/cognition/src/pper/plan-builder.ts`

- **Req 1 — Social tools first (Plan phase)**: `buildPlanTools()` now accepts
  an `isSocialPrimary` boolean. When `hasAgentsPresent` is true and social is
  NOT the primary drive, the tool ordering is
  `[talkToTool, observeAgentTool, helpTool, ignoreTool, formulatePlanTool,
  queryMemoryTool, updateInternalStateTool, ...affordanceTools]`. When no
  agents are present, the ordering is unchanged.

- **Req 2 — Social urgency demotes `formulate_plan` to last**: When
  `hasAgentsPresent` is true AND `primaryDriveLabel` contains "social"
  (case-insensitive), `formulatePlanTool` is moved to the very end:
  `[social, queryMemory, updateInternalState, ...affordance, formulatePlan]`.

- **Req 3 — Stronger social directive in user message**: When
  `hasAgentsPresent` is true, a directive line is added to the dynamic section
  of `perceptionContext`:
  `"IMPORTANT: Other agents are present. Call talk_to, observe_agent, help, or
  ignore directly to interact with them. Do not use formulate_plan for social
  actions."`

- **Req 4 — Strengthened social drive hint**: When `hasAgentsPresent` is true
  AND social is the primary drive, the old hedging hint ("You feel a strong
  need… Consider using…") is replaced by an imperative:
  `"Your social drive is your most urgent need. Call talk_to or help NOW to
  interact with another agent in this room. Do not formulate a plan first."`

- **Req 7 — Conditional social directive in system prompt**:
  `buildSystemPrompt()` now accepts an optional `hasAgentsPresent` parameter.
  When true, the directive
  `"When other agents are present and your social drive is urgent, call
  talk_to, observe_agent, help, or ignore directly — do not use formulate_plan
  for social actions."` is appended after the "You must formulate a plan…"
  sentence. When false/undefined, the system prompt is byte-identical to the
  pre-024 implementation (KV cache preserved for the no-agents case).

  The `hasAgentsPresent` constant was hoisted above the `buildSystemPrompt()`
  call to avoid a temporal-dead-zone error.

#### `packages/cognition/src/pper/perception-builder.ts`

- **Req 5 — Social tools first (Perception/Action phase)**: When
  `hasAgentsPresent` is true, social tools are prepended to the tools array
  (before cognitive and affordance tools) in both the normal and masked paths:
  `[talkToTool, observeAgentTool, helpTool, ignoreTool, ...rest]`.

- **Req 6 — Social directive in user message**: When `hasAgentsPresent` is
  true, a directive (without the formulate_plan clause, since the Perception
  phase does not include formulate_plan by default) is added to the dynamic
  section:
  `"IMPORTANT: Other agents are present. Call talk_to, observe_agent, help, or
  ignore directly to interact with them."`

### Tests

- **`packages/cognition/tests/spec-024-social-tool-invocation-fix.test.ts`**
  (new): 28 tests covering AC-1 through AC-22, including integration tests
  (AC-20, AC-21) and backward-compatibility tests (AC-22).

- **`packages/cognition/tests/spec-018-social.test.ts`** (updated): AC-48
  test updated per Req 10 to expect the strengthened social hint instead of the
  old hedging hint (the old hint is replaced when social is the primary drive).

### Documentation

- **`docs/specs/INDEX.md`**: Spec 024 status changed from 📝 Drafted to 🔍 In
  Review.

## What was NOT changed (per spec constraints)

- No changes to `packages/shared/`, `packages/engine/`, `packages/memory/`, or
  `examples/`.
- No changes to `openai-client.ts` (tool call loop, `COGNITIVE_TOOL_NAMES`).
- No changes to `CognitiveToolExecutor` interface or `CognitiveToolExecutorImpl`.
- No new npm dependencies.
- No new types, interfaces, or schemas.
- The existing social context lines in the stable section ("Agents present:
  …", "You can call talk_to…") are retained — the new directives are additive.
- The frozen system prompt prefix for the no-agents case is preserved (spec 021
  KV cache optimization intact when agents are absent).

## Test results

- All 25 cognition test files pass (550 tests pass, 1 skipped, 26 todo).
- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, and `pnpm build` all pass.