# Design Decisions — Feature 044: Social Address Reflex (Spec 044, Issue #160)

## Decision 1: Marker on the participant, set at `openOrContribute` — the single choke point for turns
**Why:** The issue's proposed design names `ConversationManager.openOrContribute` as the marker
point, and the code confirms it is the only path through which a turn addressed at *other current
participants* lands (new conversations and contributions both flow through it; `join`/`contribute`
are self-directed). Marking there means every future conversation surface (043's snapshot, events,
consolidation) sees a consistent "who is being addressed" fact with zero additional wiring.

**Alternative considered:** Mark at the `talk_to` cognitive-tool executor in cognition. Rejected —
cognition must not hold engine-side social state (ADR-0001), and the executor path bypasses
`join`/`contribute` semantics the manager already normalizes.

## Decision 2: Soft trigger = force the cycle at drive-threshold strength; never force the plan
**Why:** The scheduler already forces cycles on `HardTriggerFlags` (spec 035) — drive-threshold
crossings force a react *decision* but the plan stays LLM-authored. That is exactly the issue's
"soft, like drive-threshold crossings": the reply never waits on the target's own motivation, yet
no forced-reply action bypasses the PPER loop. A hard alarm (injected reply action / interruption
path) would discard plan validation, guardrails, and outcome labeling — and AC-2 only needs *a*
reply step in the plan, which the guaranteed address line (R2) makes the natural outcome.

**Alternative considered:** Add a new field to `HardTriggerFlags` in `shared`. Rejected — AC-6
requires gate hard-trigger semantics untouched; the marker is consumed by the scheduler as an
additional forcing input alongside the gate decision, leaving the shared contract (and spec 035's
tests) untouched.

## Decision 3: Round-robin priority instead of a separate fast lane
**Why:** AC-2 says the forced cycle must not wait on the round-robin slot. With
`maxConcurrentCycles=1` and a cursor-based scan, "force" alone still waits for the cursor to reach
the target. Evaluating address-marked agents *before* the cursor scan (same tick, concurrency
respected) gives a same-tick reply trigger while keeping the existing fairness machinery intact for
everyone else — no new scheduler concept, one ordered check.

**Alternative considered:** Pause the running cycle to interleave the reply. Rejected — a cycle is
an in-flight LLM transaction (Perceive→Plan→Execute→Reflect) with outcome labeling; interrupting it
corrupts spec 040/041's labeling dominos and risks double-execution.

## Decision 4: Decay is owned by the conversation lifecycle, not a timer on the marker
**Why:** The issue asks for stale-marker decay "with the conversation lifecycle" (spec 033 already
has idle timeout at `idleTimeoutTicks=120`, leave-close, despawn-close). Hooking marker removal
into those close paths (plus "addresser no longer a participant") reuses validated code and makes
the invariant simple to assert: a marker can never outlive its conversation — no independent TTL to
drift out of sync.

## Decision 5: Events as first-class metric surface (extends 043 R4)
**Why:** Reply rate 0 across 5 runs is the motivating evidence; AC-5 must be *measurable*. A
`conversation_addressed` event at mark time and a `conversation_reply` event at the reply give the
metrics pipeline a direct signal without re-deriving turn attribution from per-turn events — the
pair (addressed → reply within the conversation) is exactly the reply-rate numerator/denominator.

## Decision 6: Address line rendered by cognition on top of 043's snapshot — marker guarantees, not replaces
**Why:** Spec 043 already renders the "Active conversations" section; the address line is an
addition keyed off the marker (guaranteed presence + freshness: it cannot go stale or missing while
the marker exists). Keeping one rendering path avoids two divergent conversation views of the same
conversation (the spec 042 lesson: divergent renderers rot).
