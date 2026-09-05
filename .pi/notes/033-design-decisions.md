# Design Decisions — Feature 033: Conversations as Perceivable Temporal Objects & Identity Evolution (Spec 033, Issue #128)

## Decision 1: Conversations are SmartObjects, not a parallel dialogue subsystem
**Why:** The issue's agreed design direction is "conversations become first-class perceivable temporal
objects — smart objects with affordances." A conversation as a `SmartObject` inherits the entire
existing stack for free: passive perception (§6.1 `objectsPresent`), classifier pruning (§5),
affordance-as-tools (spec 019), guardrail masking/rate-limiting (spec 016), co-location guard (spec 031),
persistence (spec 017/030), and the visualizer. A parallel "conversation manager" would duplicate all of
that and violate the architecture's central decoupling (§4: the LLM sees affordances, not protocols).

**Alternative considered:** Extend `SocialManager`/`MessageQueue` with threading. Rejected — the message
queue is deliberately a passive data structure (spec 018); threading state there would be invisible to
perception, so non-participants could never `join`, and the visualizer could never render it.

## Decision 2: talk_to maps to open-or-contribute (no new primary social tool)
**Why:** `talk_to` is already validated end-to-end (delivery, +10 social, relationship deltas — spec 018/024).
Keeping it as the single entry point preserves backward compatibility with existing scenes/tests and means
the LLM needs no new tool to *start* talking; the conversation object is the bookkeeping layer underneath.
Join/leave/observe are the only genuinely new affordances, and they exist on the conversation object, not
in the cognitive tool list — so the classifier and guardrails handle them with zero special cases.

**Alternative considered:** New `open_conversation` tool. Rejected — extra cognitive overhead for the LLM and
a second path to the same state transition; open-vs-contribute is resolvable deterministically from
co-location + existing-participant checks.

## Decision 3: Rolling window of ~8 turns on the object; full history only at close-time consolidation
**Why:** Same bug class as Redna/yaam#124 (daemon unbounded memory growth). The conversation object is a
long-lived engine entity; if turns accumulate it grows without bound across a session AND across
save/load. The window is all the LLM needs for turn-taking context (last ~8 turns), and the durable,
retrievable record is the close-time `interaction` memories — which fit the existing dual-track memory
architecture (§11) where they belong, with importance scoring and decay for free.

**Alternative considered:** Store full history on the object and truncate at save time. Rejected — the
unbounded growth would exist at runtime even if saves were bounded, and close-time is the only point where
"full history" is actually consumed.

## Decision 4: Sentiment gates trust, never hard-writes relationships from message text
**Why:** Today `talk_to` blindly applies +fam/+trust (spec 018). With sentiment-tagged turns we can make the
deltas a deterministic function of the aggregate — negative exchange ⇒ no trust gain — without putting an
LLM on the relationship-update path (constraint: no LLM on deterministic paths). The LLM's only role is
tagging sentiment at contribute time; the mapping aggregate→delta is pure TypeScript and unit-testable.

## Decision 5: AgentProfile stays immutable; the live self-model is a memory-store record
**Why:** The profile is the spawn seed and is embedded in scene definitions, persistence v1/v2 saves, and
persona formatting (spec 012). Making it mutable would silently change every consumer and break
byte-identical static-scene saves (spec 030 AC-11). Instead the *identity self-model* is a structured
memory node injected into prompts like other memories: it evolves via the guarded consolidation path and
round-trips through the existing memory persistence for free. The profile remains the fallback when no
self-model exists yet (backward compat with all existing agents).

**Alternative considered:** Mutable profile + versioned profile snapshots. Rejected — conflates spawn seed
with live state, breaks spec-012 contract, and duplicates what the memory store already provides.

## Decision 6: Identity deltas are LLM-proposed, guarded, bounded, and audited — never direct writes
**Why:** The threat model in the issue is explicit: "prompt injection via talk_to cannot instantly rewrite
identity." A message is untrusted input; it may at most *influence* the session-end consolidation pass.
Bounding (rate limit + max-N deltas per session) plus `identity_change` audit events keeps the evolution
measurable and reversible, and keeps the LLM off the deterministic write path (deltas are proposed by the
consolidation pass, validated by guardrails, applied by deterministic engine code).

## Decision 7: Verify-first for the "free wins" (co-location exit, guardrails, visualizer, group chats)
**Why:** The issue itself says these should be verified, not built — they are emergent from reusing the
smart-object stack. The spec therefore writes them as acceptance criteria (AC-5, AC-2, AC-10) with the
expectation that no new engine code is needed beyond wiring conversation objects into perception; if a
verify test fails, the fix is scoped as wiring, not a new mechanism.

## Decision 8: Prerequisite bug treated as verify-first with a regression test (R16)
**Why:** Code inspection at HEAD shows `Relationships` live in `AgentInternalState`, which is snapshotted in
`AgentSnapshot.state` and restored by `EnginePersistence.load()` — so the issue's claim ("relationships are
not in SaveState") appears stale relative to current main. Rather than blindly "adding" what may already
exist (and shipping a redundant format bump field), the spec requires a round-trip regression test across
save/load AND dormant respawn (AC-12); if a gap is confirmed, the fix lands inside the v3 bump. Honest
verification beats speculative re-implementation.

## Decision 9: SAVE_FORMAT_VERSION 2 → 3, MIN_SUPPORTED stays 1
**Why:** Conversations in `DynamicWorldSnapshot` and self-models in dormant snapshots are additive optional
fields, but the issue explicitly calls for a v3 bump and closed-conversation resumption changes load
semantics. Following the spec-030 precedent exactly: bump the constant, document the reason, keep v1/v2
saves loadable so existing saves don't break.

## Decision 10: Conversation object type lives in shared; engine owns lifecycle; cognition owns LLM passes
**Why:** ADR-0001 bridge pattern (mirrors `TopologyGuard`/`AffordanceGuard` in mutations.ts): the data shape
must be shared because both engine (lifecycle, persistence, visualizer) and cognition (sentiment tagging,
consolidation) consume it, but LLM orchestration belongs in cognition and never in the engine. This keeps
the dependency direction strict and LLM calls off deterministic paths.
