# Implementation Notes — Spec 021 (KV Cache Prompt Optimization, Issue #86)

## What was built

### Cognition layer (`@evol-hive/cognition`)

- **`packages/cognition/src/pper/plan-builder.ts`** —
  - **Req 1**: Removed the dynamic `Your primary drive is: {label}.` sentence
    from `buildSystemPrompt()`. The system prompt is now fully stable for a
    given persona (the only variable is the persona text, which is stable per
    agent). Replaced with the static sentence "You must formulate a plan to
    satisfy your most urgent drive." The `buildSystemPrompt` function
    signature changed: it no longer takes `primaryDriveLabel` as a parameter.
  - **Req 2**: Reordered `perceptionContext` — stable content (Room, Objects,
    Agents present, relationship context, compound actions, object
    dependencies) is placed above a `---` separator; dynamic content (Primary
    drive, Drives, social context messages, social drive hint, system
    feedback, stuck warning) is below.
  - **Req 3**: `formatDrives()` now uses `Math.round()` before formatting
    drive values (e.g. `energy=19.998` → `energy=20`).

- **`packages/cognition/src/pper/reflect-builder.ts`** —
  - **Req 2**: Reordered `perceptionContext` — stable content (Aspirations,
    Execution result, Error, Drive changes applied, Failure reason, step
    skipped, Current goal, Plan status) is above `---`; dynamic content
    (Drives with current values) is below.
  - **Req 3**: `formatDrives()` now uses `Math.round()`.
  - **Req 7**: System prompt was already stable — no change needed.

- **`packages/cognition/src/pper/perception-builder.ts`** —
  - **Req 2**: Reordered `perceptionContext` — stable content (Name,
    Tendencies, Room, Objects, Agents present, relationship context) is above
    `---`; dynamic content (Primary drive, Drives, social context messages,
    social drive hint) is below.
  - **Req 3**: `formatDrives()` now uses `Math.round()`.

- **`packages/cognition/src/llm/openai-client.ts`** —
  - **Req 4**: `buildUserMessage()` no longer appends the
    `Cognitive tools:\n…` text block. Cognitive tool descriptions are sent
    as tool definitions via the `tools` API parameter. The `cognitiveTools`
    field on `LLMContextPayload` is retained for internal use but not
    rendered into user-visible prompt text. The user message now contains
    only the `perceptionContext`.

### Test layer (`packages/cognition/tests`)

- **`spec-021-kv-cache-prompt-optimization.test.ts`** (new) — 24 tests
  covering AC-1 through AC-10:
  - AC-1: PlanBuilderImpl system prompt excludes primaryDriveLabel; identical
    across calls with different labels.
  - AC-2: ReflectBuilderImpl system prompt is stable across different drive
    values.
  - AC-3/AC-4/AC-5: Each builder's perceptionContext contains a `---`
    separator; stable content above, dynamic content below.
  - AC-6/AC-7/AC-8: Each builder's `formatDrives` rounds values to integers.
  - AC-9/AC-10: `buildUserMessage()` output does not contain "Cognitive
    tools:" or affordance labels as text.

- **Test-maintenance updates (AC-11)**:
  - `plan.test.ts`: Updated the test that checked the system prompt for the
    primary drive label — now asserts the label is NOT in the system prompt
    (it's in the user message instead).
  - `openai-client.test.ts`: Updated the user message construction test to
    assert cognitive tools text is NOT present (was previously asserting it
    WAS present).
  - `spec-019-affordance-as-tools.test.ts`: Same cognitive tools text removal
    assertion update.

## Test Results

- Cognition: 491 passed, 1 skipped, 26 todo
- Engine: 488 passed, 122 todo
- Examples (coffee-shop integration): 77 passed
- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm build` all pass

## Design Decisions

### Separator format
The `---` separator is placed on its own line in the `perceptionContext`
string, preceded and followed by a newline (`\n---\n`). This makes it a clear
boundary token for KV cache prefix matching. Content above `---` is
deterministic for a given room + object set (stable prefix); content below
`---` includes all per-tick-mutating data.

### Rounding scope
`Math.round` applies ONLY to the user message display. The
`AgentInternalState.drives` object, engine decay calculations, and any
comparisons continue to use full-precision floats. The rounding is in the
`formatDrives` helper of each builder, which is the single point where drives
are rendered into prompt text.

### What was NOT changed
- The `tools` array sent to the LLM API (no changes to tool definitions or
  schemas).
- The PPER orchestration loop.
- The engine or drive decay logic.
- `AgentInternalState` types.
- `packages/engine` or `packages/memory`.

## PR
[#88](https://github.com/Redna/evol-hive/pull/88)