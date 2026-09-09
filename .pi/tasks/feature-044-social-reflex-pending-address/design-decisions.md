# Design Decisions — Feature 044: Social Reflex / Pending-Address Marker (Spec 044, Issue #160)

## Decision 1: The marker lives on `ConversationParticipant` in `shared`, not in a separate registry
**Why:** `ConversationManagerImpl` already owns the only authoritative conversation state, and
`ConversationObject` (participants included) already flows through export/restore persistence
(spec 033 R10), the smart-object mirror, and the spec 043 perception snapshot. Storing
`addressedBy: { agentId, conversationId, tick }` on the participant gives the marker the same
lifecycle, persistence, and mirroring for free — one source of truth.

**Alternative considered:** A side-table in the scheduler or a new engine-level marker store.
Rejected — split-brain state that must be manually kept in sync with conversation lifecycle and
persistence (exactly the sync-bug class spec 043 Decision 1 avoided by reusing spec 033 machinery).

## Decision 2: The trigger is a scheduler-side soft trigger — never a new `HardTriggerFlags` field
**Why:** The issue (and its AC-6) draw a hard line: gate hard-trigger semantics stay untouched, and
"hard-trigger semantics would bypass the gate entirely". Spec 035's `HardTriggerFlags` +
`hasHardTrigger` + gate head + gating tests are a frozen trainable contract (feature-schema
versioning); adding a fifth flag would perturb the trained feature space. Instead, the scheduler
consults a separate soft-trigger query (pending-address marker on a live conversation) that:
(a) never idles an addressed agent — mirroring the existing belt-and-braces forcing path, with the
gate still consulted and the outcome still recorded so the trainable head keeps its label stream;
(b) schedules addressed agents ahead of the round-robin cursor (AC-2: "without waiting on the
round-robin slot").

**Alternative considered:** Add `pendingAddress` to `HardTriggerFlags`. Rejected — violates AC-6,
changes the spec 035 feature contract, and is stronger than the issue wants ("soft is the right
strength").

## Decision 3: "Soft" means the trigger guarantees a *cycle*, never an *action*
**Why:** The issue's own wording: "a greeting deserves a response, but the agent may still fold it
into other work". The forced cycle runs the normal PPER pipeline — the LLM plans freely, the
address line + state-aware `talk_to` description (spec 043 R3) make the reply the obvious next
step, and plan validation (§10) applies to the reply as to any action. A "hard alarm" that directly
executes a reply would bypass the gate, the plan, and the guardrails — explicitly rejected. This
is the same strength class the issue anchors to (drive-threshold crossings force a cycle; they do
not dictate its content).

**Alternative considered:** Injecting a forced `talk_to` plan step or a System 0 reflex action.
Rejected — hard-alarm semantics; breaks the System 1 gates / System 2 plans split and the
guardrails' deviation path.

## Decision 4: Priority lane stays inside `maxConcurrentCycles` capacity
**Why:** AC-2 requires the addressed agent's cycle to start on the next scheduler pass without
waiting on the round-robin cursor — but unbounded queue-jumping would let a conversation storm
starve non-social agents and break the fairness guarantee the scheduler documents. Addressed agents
are scanned first each tick and claim free slots ahead of the cursor; if no slot is free they are
first claim on the next one. Round-robin fairness for everyone else is unchanged (AC-6).

**Alternative considered:** Reserve a dedicated slot for addressed agents. Rejected — silently
raises effective concurrency and complicates the `isThinking`/`activeCycles` accounting.

## Decision 5: Clearing and decay are tied to the conversation lifecycle, with freshness re-stamping
**Why:** The marker is a *claim on the target*, so it must die exactly when the claim dies: the
target contributes (acknowledged — the primary path), the conversation closes (idle timeout /
last participant leaves or despawns), or the claimant disappears from the conversation (leave,
co-location sweep, despawn — the "A left the room" stale case). Re-contributions by the claimant
re-stamp `tick`, so the perception line is always fresh rather than replaying an old greeting.
No separate TTL timer — the conversation's existing 120-tick idle timeout IS the decay.

**Alternative considered:** A tick-based TTL on the marker independent of the conversation.
Rejected — duplicates the lifecycle the manager already sweeps every tick; two decay clocks would
drift (e.g., marker dies while the conversation is still open and waiting).

## Decision 6: Address/acknowledge events extend spec 043 R4's metric stream
**Why:** The acceptance bar is quantitative (reply rate > 0, was 0 across 5 runs; ≥3 conversations
with ≥2 turns). Emission belongs in the engine (it owns marker transitions) on the same
`events.jsonl` run stream spec 043 R4 established — `conversation_addressed` per newly-marked
participant per turn, `conversation_acknowledged` on contribution-clears — so reply rate =
acknowledged ÷ addressed is computable post-hoc with zero cognition coupling.

**Alternative considered:** Deriving reply rate from spec 043's per-turn events alone (role +
turnCount). Rejected — it cannot distinguish "A kept monologuing" from "B actually answered" at
the address level; the address/ack pair measures exactly the reflex this spec adds.

## Decision 7: Spec 043 is a hard prerequisite — drafted, not landed
**Why:** Repo check at draft time: spec 043 is 📝 Drafted in INDEX (only the spec doc merged via
PR #159); the perception snapshot, bridge method, and address-line rendering surface do not exist
in code yet. R2's rendering and AC-2's payload assertion are therefore spec'd against 043's
contracts and must be implemented after 043 lands, per the issue's dependency note.
