# Design Decisions — Feature 050: Assembly Consolidation (Spec 050, Issue #166)

## Decision 1: New `@evol-hive/assembly` package — not `packages/cli`, not an engine/cognition merge
**Why:** The assembler must import `createEngineCore` (engine) and `createPPEROrchestrator` (cognition)
simultaneously. Per the §2 dependency graph, engine and cognition must never import each other, so the
assembler can only live at a layer ABOVE both. A new package with deps `{ shared, engine, cognition,
memory }` is the minimal composition root: it preserves ADR-0001 (acyclic graph, lean packages), gives
`examples/`, `packages/cli`, and `packages/visualizer` a legitimate library to consume, and makes the
"only place allowed to know both sides" rule enforceable by a workspace dependency check rather than
convention.

**Alternative considered:** Host in `packages/cli`. Rejected — `examples/` importing `@evol-hive/cli`
inverts the app/library direction, couples the visualizer (a future consumer) to CLI code, and makes
the CLI's own `run-scene` refactor circular.

**Alternative considered:** Give `engine` a peer dependency on `cognition` (engine-with-cognition-peer).
Rejected — inverts ADR-0001, couples the deterministic game loop to LLM code, and recreates the exact
drift surface this spec removes (wiring logic drifting into the engine package where examples can't see it).

## Decision 2: The assembler calls `createEngineCore` + `assembleGameLoop` internally; callers pass only config/env
**Why:** Every wire left "optional for the caller" is a dormant-machinery bug waiting to happen (#155,
#165 both had this shape). The invariant "a component existing in core but unwired by the default path
is a bug by definition" (issue R4) can only hold if there are no caller-side wires at all. Scene loading
and handler registration stay caller-side deliberately — they are scene DATA (`run-scene` takes a file
path; tests swap scenes), not wiring.

**Alternative considered:** Two-call API (`assembleEngine(config)` → `wireCognition(core)`), keeping the
current split as a public API. Rejected — the two-call split is precisely the drift mechanism: #165
happened because a caller forgot the second call. One call, fully wired.

## Decision 3: `EngineConfig.maxConcurrentLLM` is FORWARDED to the scheduler, not deleted
**Why:** The field is declared with a default of 8 and read by ~40 test/scene files, but
`defaultPPERSchedulerConfig()` only reads the `ENGINE_MAX_CONCURRENT_LLM` env var — the field is dead.
Deleting it would force a mechanical sweep of every test that sets it for zero behavioral gain.
Instead the assembler derives an override scheduler config from `config.maxConcurrentLLM` (env var
still wins, preserving spec 022 R4 semantics), and a new shared-types test asserts the scheduler
consumes it — turning the dead field live without breaking any caller.

**Alternative considered:** Remove the field entirely. Rejected — pure churn; every scene/test sets it
meaningfully, and the env override path already covers ops usage.

## Decision 4: Conversation bridge + urge surfaces wired by default, asserted by an assembler-level integration test
**Why:** #165's root cause was an *unwired* `conversationBridge` in a production assembly path that no
unit test covered (tests wired the bridge manually). The promoted assembler gets its own integration
test that constructs the stack through the DEFAULT path and asserts `conversationBridge ===
core.conversationManager`, `social.setConversationManager` identity, and non-empty
`getConversationsAwaitingAgentReply` after a `talk_to` — so default-path completeness is now a tested
property, not a review checklist item.

## Decision 5: Supersede, don't stack — merge #165 first, then delete its file
**Why:** #165 (spec 045, PR #172) is the immediate live-run unblock and is In Review; this spec's AC-1
deletes `examples/assembly.ts`, so spec 045's diff is transient scaffolding. Sequencing: merge #165
first (unblocks live conversation runs), implement 050 second, and mark 045's wiring lines as
superseded in its spec's post-notes. No conflict risk: 050 removes the file 045 patched, which git
surfaces as a delete-vs-modify at worst.
