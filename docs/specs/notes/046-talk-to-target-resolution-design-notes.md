# Design Notes — Spec 046 (talk_to Target Resolution & Sentiment Passthrough) — Issue #173

> YAAM note: this environment's YAAM daemon (raw-TCP JSON-RPC on `127.0.0.1:46697`,
> port from `.yaam/daemon.port`) exposes a single `search` method — probed
> `workspace_initialize`, `workspace_init`, `initialize_workspace`, `note_write`,
> `note_append`, `rpc.discover`: all `Method not found` (same finding as the spec 045
> notes). `yaam_search` was used for code discovery ("talk_to name resolution",
> "sentiment executeTalkTo tool call loop", "agents present perception line kv cache").
> Design decisions are therefore recorded here per the notes-directory convention; this
> file is itself YAAM-indexed and discoverable via `yaam_search`.

## Design decisions

1. **Executor-side normalization is the primary fix (R2), not perception-only or
   engine-only.** The phantom-key disease has four infected sinks: conversation
   participants, relationship entries, the message queue, and `[social]` telemetry.
   A perception-only fix (render IDs) depends on the LLM actually passing IDs;
   an engine-only fix (`ConversationManagerImpl` tolerance) still leaves
   `queueMessage('agent-alice','Bob',…)` and relationship writes keyed to the raw
   string. Normalizing once in `CognitiveToolExecutorImpl` before dispatch fixes all
   four sinks at a single choke point. Perception IDs (R4) and manager tolerance (R3)
   are defense-in-depth layers, not substitutes.

2. **Scope includes the sibling social tools** (`observe_agent`, `help`, `ignore`) even
   though the issue files `talk_to` only: they consume the same `targetAgentId` string
   from the same mid-loop path and suffer the identical phantom-key failure
   (`observe_agent→Bob` returns a miss; relationship/queue writes keyed to phantoms).
   One shared `resolveAgentId` helper makes fixing them free; AC-7 pins it.

3. **Resolution semantics (R1)**: exact-ID passthrough first (today's well-behaved
   behavior is preserved bit-for-bit — AC-10), then case-insensitive profile-name
   match over active agents preferring the requester's room (co-location is what
   `Agents present` describes, so a room-local match is almost always the intended
   target). Ambiguous duplicates → `null` → structured failure listing present agents
   (Req 17 self-correction), never silent guessing.

4. **Sentiment passthrough (R5) is client-side arg mapping, not a schema change.** The
   executor signature already accepts `sentiment?: ConversationSentiment` (spec 033)
   and defaults to `'neutral'` — only `openai-client.ts`'s mid-loop `talk_to` branch
   drops it (line ~662). Fix is: extract, validate against the enum, default on
   absence/invalid, pass as 4th arg. Unit test pins the mapping (AC-5). The
   single-request fallback path is unaffected (it returns args to the caller, no
   executor).

5. **KV-cache check for R4**: adding `(agent-bob)` to the `Agents present:` line keeps
   the line a pure function of room membership + activity; it stays above the `---`
   boundary and its structure/order is unchanged, so the spec 021 stable-section
   guarantee holds. Prompt-pinning tests (e.g. spec 018 AC-41
   `expect(...).toContain('Agents present: Bob (idle)')`) must be updated — this is
   an intentional, pinned-string change, not a cache regression.

6. **ConversationManager tolerance (R3) deliberately does NOT extend the
   `ConversationBridge` interface** — the manager already holds `agentManager`, so
   resolution is internal. Unresolvable keys return `success: false` instead of
   creating a phantom participant (AC-9), flipping today's silent-phantom behavior.

7. **Out of scope / not done**: no `examples/` changes (spec 045's wiring is correct —
   verified via PR #172); no changes to the R7 sweep, close-time consolidation, tool
   schemas' shape, or the PPER loop. Live-run re-validation of spec 045's open ACs is
   a manual follow-up to be recorded on #173/#167 after implementation.
