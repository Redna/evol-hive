# Design Decisions — Feature 043: Conversation Perception Bridge (Spec 043, Issue #158)

## Decision 1: Perception-side bridge only — zero changes to the spec 033 lifecycle
**Why:** The ConversationManager (spec 033) already maintains everything the LLM needs: rolling
turn window, per-participant sentiment, derived roles, open→active→closed lifecycle. The one-turn
failure is purely a visibility problem — none of that state reaches the LLM context. Reusing the
machinery keeps the fix small, keeps spec 033's tested surface untouched (AC-5), and follows the
repo's decoupling principle (the LLM sees context, not protocols).

**Alternative considered:** Rebuild conversation awareness as a new cognition-side subsystem.
Rejected — duplicate state, sync bugs between engine and cognition, and it discards validated
lifecycle/consolidation code.

## Decision 2: Engine attaches a per-agent conversation snapshot to PerceptionResult; cognition renders it
**Why:** `PerceptionBuilderImpl.build` consumes only a `PerceptionResult` — it has no engine access.
The engine's perception assembly already wires the ConversationManager (spec 033, affordance
eligibility), so it is the natural place to compute the snapshot. Cognition stays pure formatting
(deterministic, no LLM on the perception path). This mirrors the ADR-0001 bridge pattern: engine
implements, cognition consumes via `shared` types.

**Alternative considered:** Hand cognition a `ConversationBridge` reference and query it during
prompt build. Rejected — spreads engine state access through the prompt path and makes the builder
impure/hard to test.

## Decision 3: Conversation context is dynamic-section-only (spec 021 stable-prefix rules)
**Why:** Turns, topics, and conversation membership change per tick and are per-agent — placing
them in `stableLines` would invalidate the KV-cache stable prefix that spec 021 established. The
"Active conversations" lines render after the `---` separator, exactly like `socialContext`
messages do today. The state-aware `talk_to` description (R3) is likewise per-agent dynamic.

**Alternative considered:** Put conversation object names in the stable section (they look like
objects-present). Rejected — conversation identity and turns churn every tick; the stable prefix
must remain deterministic for a given room + static object set only.

## Decision 4: Reuse spec 033 R3's participant/observer privacy boundary for non-participants
**Why:** Spec 033 already defines what non-participants may see (`observe` → topic + participants,
never turns). The perception snapshot reuses exactly that shape (`ConversationObserveResult`
fields) so there is one privacy rule with two consumers, and no new leak surface for turn text.

**Alternative considered:** Show last-turn summaries to everyone in the room (ambient eavesdropping).
Rejected — weakens the established boundary, invites social-fog regressions (spec 039), and inflates
prompt tokens for bystanders who get no actionable affordance from turn text.

## Decision 5: State-aware `talk_to` description via per-agent clone, not mutation of the shared const
**Why:** `talkToTool` is a static export in `shared` used by every agent and test. The
perception-builder already assembles a per-agent tools array; cloning the definition and overriding
`description` when an open conversation exists is additive, keeps the base untouched, and gives the
LLM an in-tool nudge toward contributing instead of re-greeting (the issue's root symptom #3).

**Alternative considered:** New `contribute_to_conversation` tool. Rejected — spec 033 Decision 2
keeps `talk_to` as the single entry point (open-or-contribute is deterministically resolved); a
second tool doubles the decision surface for small LLMs.

## Decision 6: Measurability via engine events, not cognition instrumentation
**Why:** The engine already emits the run's event stream (`events.jsonl`); one event per conversation
turn (agent, conversation, turnCount, role) makes reply rate, initiator follow-ups, and multi-turn
conversation counts computable post-hoc with zero coupling into the LLM path. Live validation (AC-4)
needs these numbers to prove the fix (currently 0 replies across 5 runs).

**Alternative considered:** A cognition-side metrics collector. Rejected — split-brain metrics across
the engine/cognition boundary and extra plumbing for data the engine already owns.

## Decision 7: Consolidation memories carry the actual exchanged turns (R5)
**Why:** With the window populated by real multi-turn exchanges, the close-time `interaction`
memory (spec 033 R5) can include both sides' texts — this is the durable record that feeds
retrieval and dream-training (spec 035). The rolling window already holds exactly what's needed at
close time; no extra storage (bounded-state rule preserved — full history still exists only in the
consolidation memory).

**Alternative considered:** Keep the role/sentiment summary only. Rejected — it reproduces the
current single-turn consolidation and starves dream-training of dialogue data, which the issue
explicitly calls out.
