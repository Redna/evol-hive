# Feature: Dialogue Completion — Urge Observability, Persona-Seed Audit, Fresh-Address Salience & the Own-Cycle Reply Window

> Issue: [#167](https://github.com/Redna/evol-hive/issues/167) — "Dialogue completion: urge observability +
> reply-rate diagnosis (reply rate still 0 across runs)". Specs 043 (perception bridge) + 044 (urge model)
> are merged and #165 wires the conversation bridge into live sims, but the reply rate remains **0 across
> all runs** — Maren received 3 greetings in the urge-model run and responded to none. Silence is allowed
> by design (spec 044: influence, not force), but we cannot yet distinguish legitimate low talkativeness
> from a diagnosable weakness. The user-approved structural suspect: `idleTimeoutTicks: 120` (~2 sim-seconds
> at the 60 fps tick) closes an idle conversation before the addressed agent's next cycle can reply under
> cc=3 cadence (cycles 20–60s apart) — the reply window is structurally ~2s wide, and the pending-address
> marker decays with the conversation lifecycle. The 2 observed A→B→A exchanges in the 046/047 runs happened
> within concurrent-cycle windows — luck, not design; this spec makes them structural.

## Context
- Architecture: [§3 — Agent State Schema](../architecture/03-agent-state-schema.md) (AgentInternalState optional-field family; relationships), [§6 — PPER Loop](../architecture/06-pper-loop.md) (the perceive→plan seam where the diagnostic lands; dynamic perception section), [§8 — Cognitive Tools](../architecture/08-cognitive-tools.md) (`talk_to` execution path)
- Related specs: [044 — Social Urge Model](044-social-urge-model.md) (R1 persona seed + `deriveSocialTalkativenessSeed`, R4a pending-address lines, R4b urge hint lines, "influence not force"), [043 — Conversation Perception Bridge](043-conversation-perception-bridge.md) (pending-address surface via `getConversationsAwaitingAgentReply`), [045 — Assembly Conversation Wiring](045-assembly-conversation-wiring.md) (live-sim conversation path), [047 — Talk Loop Fix](047-talk-loop-urge-gating-asymmetric-reward.md) (`SOCIAL_TALK_CAP`, decayed-hint rendering), [033 — Conversations as Perceivable Temporal Objects](033-conversations-identity-evolution.md) (conversation lifecycle: `lastActivity`, idle timeout, close-time consolidation), [048 — Drive-Economy Rebalance for cc=3](048-drive-economy-rebalance-cc3.md) (the cc=3 cadence measurements this spec builds on), [040 — Idle-Tick Memory Suppression](040-idle-tick-memory-suppression.md) (untouched), [021 — KV-Cache Prompt Optimization](021-kv-cache-prompt-optimization.md) (dynamic-section discipline)
- Package: `shared` (new constants, `PendingAddressInfo` age fields, `AgentInternalState` optional fields), `engine` (PPEScheduler cycle bookkeeping, `ConversationManagerImpl` idle-timeout rework + close diagnostic), `cognition` (perceive→plan diagnostic line, perception-builder fresh-address promotion), `examples` (explicit persona seeds in `dynamic-world.ts`)
- Issue: [#167](https://github.com/Redna/evol-hive/issues/167)

### Evidence summary (from the issue + run analyses)

| Signal | Value |
| --- | --- |
| Population reply rate | 0 across all runs post-044/045 |
| Maren in the urge-model run | 3 greetings received, 0 replies |
| 046/047-run A→B→A exchanges | 2, both inside concurrent-cycle windows (luck, not design) |
| `idleTimeoutTicks` | 120 ticks = ~2 sim-seconds (fps 60) |
| cc=3 cycle cadence | 20–60s between an agent's own cycles (1200–3600 ticks) — spec 048 |
| Maren seed inference | traits `['patient', 'methodical']` match **no** keyword in `deriveSocialTalkativenessSeed` → neutral 0.5, despite persona text implying quiet ("measures success in harvests rather than words") |

The diagnosis gap: urge hints and pending-address lines currently live only in the LLM's context —
unauditable from run logs. We cannot tell "the hint never rendered" from "the hint rendered and the LLM
chose silence", and we cannot tell "legitimately low talkativeness" from "the window closed before a reply
was possible". Observability comes first; the timeout fix then makes replies structurally possible.

## Design Decisions

**Decision 1 — The diagnostic lives at the perceive→plan seam in the orchestrator, not inside the
perception-builder.** `PPEROrchestratorImpl.runCycle` already holds the assembled `PerceptionResult`
(including `pendingAddresses` and `socialUrges`) right after the perceive phase, and the orchestrator is
the established home of console diagnostics (`[plan-failed]`, `[PPERScheduler]`). One `console.log` line
per cycle — prefixed `[social-urge]` for grep-ability — covers everything the issue asks for: rendered-line
classification AND the raw factor breakdown, which the rendered lines alone do not carry. Logging inside
`perception-builder` would scatter one log call per rendered line (or duplicate the classification logic)
and mix I/O into a pure formatting function.

**Decision 2 — Cycle cadence is measured, engine-side, as optional fields on `AgentInternalState`.**
The reply-window guarantee ("≥2 of B's own cycles since last activity") needs to know B's own-cycle
interval. `PPEScheduler.startCycle` is the single choke point where an agent's cycle actually begins — it
already flips `isThinking` and owns per-agent bookkeeping. We record `lastCycleTick` and an EMA
`meanCycleIntervalTicks` there (tick arithmetic only — no `Date.now()`, preserving engine determinism).
Optional fields ride the existing snapshot path (the spec 044 `spawnTick` pattern); legacy saves carry
`undefined` and fall back to today's behavior exactly.

**Decision 3 — The effective idle timeout is `max(floor, 2 × meanCycleInterval)` of the participants who
owe a reply.** This encodes the issue's "≥2 of B's cycles since last activity, or a wall-time floor,
whichever is larger" in measured rather than assumed cadence: the existing `ConversationConfig.idleTimeoutTicks`
(120) is repurposed as the wall-time floor, and the measured-interval term (factor 2 → the addressed agent
is guaranteed ≥2 own-cycle opportunities within the window by construction) dominates at cc=3, where
2 × 1200–3600 ticks = 2400–7200 ticks dwarfs the 120-tick floor. With no interval data (legacy saves,
never-cycled agents) the term falls back to a conservative default calibrated to the observed cc=3 upper
bound, so an unknown cadence widens rather than narrows the window — fail-open toward possible replies.

**Decision 4 — Fresh-address salience is deterministic line promotion inside the dynamic section.**
The pending-address line competes with farming drives in a long context; when the addressing turn is
recent (< `SOCIAL_PENDING_FRESH_TICKS`), the line renders **first** in the dynamic section with a `FRESH:`
prefix instead of its current position. This is still information, never a trigger (spec 044 R5 stands) —
the LLM keeps the decision, including staying silent. Promotion is a reordering within the dynamic section,
so the spec 021 KV-cache discipline is untouched.

**Decision 5 — Explicit seeds only where inference is wrong or ambiguous.** The audit (R2) confirms Tomas
(`'energetic'` → 0.8) and Iris (`'reserved'` → 0.25) infer correctly; only Maren is mis-served — her
traits and backstory contain no keyword hits, so she gets the neutral 0.5, which contradicts both her
characterization and the expected Tomas > Iris > Maren ordering. We add an explicit
`socialTalkativeness` to Maren's profile only, keeping trait inference as the default mechanism (spec 044
R1's contract) and documenting the audit in `docs/specs/notes/` per repo practice.

**Decision 6 — The pending-address marker keeps decaying with the conversation lifecycle.** When the
widened window still expires, the conversation closes and the marker disappears (spec 033/043 semantics).
Making markers survive closure is a larger behavioral question the issue does not ask for; the structural
fix is the window itself. The close diagnostic (R4) makes every such closure auditable so a future spec
can revisit marker persistence with data.

## Requirements

### R1 — Per-cycle urge/pending diagnostic line (cognition)

When a cycle's perception includes at least one present agent, `PPEROrchestratorImpl` emits exactly one
`console.log` line, prefixed `[social-urge]`, between the perceive and plan phases. The line carries:
agent id, current tick, the derived persona seed, each pending-address entry (conversation id, from-agent,
age in ticks, fresh flag per R3), and each per-target urge with its factor breakdown (persona, drive,
novelty, reciprocity) and rendered-line classification (`surfaced` / `decayed-hint` / `capped` /
`none` — matching what the perception-builder actually rendered for that target, including spec 047's
`SOCIAL_TALK_CAP` exclusion). Emitting the line whenever agents are present (even when nothing renders)
is the point: "no hint rendered" must be distinguishable from "hint rendered but ignored". The diagnostic
performs zero LLM calls, is wrapped so it can never break the cycle, and adds no other output (one line,
no full-context dumps).

### R2 — Seed-inference audit + explicit seed for Maren (examples + docs)

Audit `deriveSocialTalkativenessSeed` against the actual `dynamic-world.ts` persona texts and record the
result in a design-notes doc (`docs/specs/notes/049-dialogue-completion-design-notes.md`) with one table
row per agent: traits/backstory signals, inferred seed, whether inference is correct. Add an explicit
`socialTalkativeness` to Maren Holt's profile — chosen below Iris's inferred 0.25 so the shipped scene
realizes the expected ordering Tomas (0.8) > Iris (0.25) > Maren — and leave Tomas/Iris on inference
(Decision 5). The audit must state Maren's inference failure explicitly: `['patient', 'methodical']`
and her backstory contain no `TALKATIVE_KEYWORDS`/`RESERVED_KEYWORDS` hits, so inference returns the
neutral 0.5.

### R3 — Fresh-address salience (shared + cognition)

`PendingAddressInfo` gains optional `lastTurnTick` and `currentTick` (filled by the perceive service from
the conversation's last turn tick and `provider.getCurrentTick()` — pure data, same pattern as the urge
inputs). New shared constant `SOCIAL_PENDING_FRESH_TICKS = 3600` (60 sim-seconds ≈ the upper bound of the
observed cc=3 own-cycle cadence, i.e. "fresh" means "before the addressed agent's first realistic chance
to respond"). In the perception-builder: when `currentTick − lastTurnTick < SOCIAL_PENDING_FRESH_TICKS`,
the pending-address line renders as `FRESH: INFORMATION: …` **first** in the dynamic section; otherwise
today's position and wording are unchanged. Dynamic section only (spec 021); the urge hints and all other
lines are unaffected.

### R4 — Own-cycle reply window (shared + engine)

`AgentInternalState` gains optional `lastCycleTick?: number` and `meanCycleIntervalTicks?: number`.
`PPEScheduler.startCycle` updates both at cycle start: interval = current tick − `lastCycleTick` (first
observed interval seeds the EMA directly; subsequent intervals update it with a fixed deterministic EMA
factor). The EMA update is pure tick arithmetic — no wall-clock reads.

`ConversationManagerImpl.tick`'s idle check becomes: for each participant who owes a reply (every
participant other than the last-turn speaker; all participants if the conversation has no turns), compute
`2 × meanCycleIntervalTicks`, falling back to `DEFAULT_CYCLE_INTERVAL_TICKS = 3600` when the field is
`undefined`; the effective timeout is `max(config.idleTimeoutTicks, max of those terms)`. The conversation
closes only when `nowTick − lastActivity > effectiveTimeout`. Closure by idle timeout emits a one-line
`console.log` diagnostic prefixed `[conversation]` carrying the conversation id, idle ticks, effective
timeout, and each addressed participant's cycles-since-activity estimate. Legacy path: with
`meanCycleIntervalTicks` undefined on every participant, the effective timeout is
`max(config.idleTimeoutTicks, 2 × 3600)` — for the shipped examples this is the Decision 3 fail-open
default; spec 033's existing lifecycle tests (which drive ticks directly against the raw config) keep
passing via the `idleTimeoutTicks` floor semantics.

### R5 — No behavior change beyond the reply window

No forced cycles, no triggers, no scheduler cadence/gating changes (the R4 scheduler change is bookkeeping
only — two numbers written at the cycle start that already happens). The urge formula, thresholds, spec 047
gating, and spec 040 idle-tick suppression are untouched. The pending-address marker still disappears at
closure (Decision 6). Being addressed never forces a cycle; the LLM keeps the decision, including silence.

### R6 — Live-run measurement (issue AC-3)

After implementation, a 30-minute live run at `ENGINE_MAX_CONCURRENT_LLM=3` (built `dist/` — run
`pnpm build` first, spec 037 Evidence) must show: population reply rate > 0; at least one conversation
with ≥ 2 turns; per-agent reply rates ordered Tomas > Iris > Maren. Evidence (grepped `[social-urge]` and
`[conversation]` lines plus computed reply rates) is attached to issue #167.

## Acceptance Criteria

- [ ] **AC-1** (R1): Unit test — after A `talk_to`s co-located B, B's next cycle emits one `[social-urge]`
  line (captured via an injected log sink or console spy) containing B's persona seed, the pending entry
  (conversation id, from = A, age, fresh flag), and the urge entry for A with its four factor values and a
  rendered-line classification.
- [ ] **AC-2** (R1): Unit test — with agents present but no pending addresses and all urges below the
  surface threshold, exactly one `[social-urge]` line is still emitted per cycle (with classification
  `none`); with no agents present, no line is emitted; a throw inside diagnostic construction leaves the
  cycle outcome unchanged.
- [ ] **AC-3** (R2): The design-notes doc exists with the per-persona audit table; a unit test pins
  `deriveSocialTalkativenessSeed` over the three shipped profiles: Tomas 0.8, Iris 0.25, Maren equal to
  her explicit field (< 0.25), and asserts that with the explicit field removed Maren would infer 0.5
  (proving the seed is explicit, not inferred).
- [ ] **AC-4** (R3): Unit test — a pending address with `currentTick − lastTurnTick < SOCIAL_PENDING_FRESH_TICKS`
  renders the `FRESH: INFORMATION: …` line as the **first** dynamic line; the same pending address past the
  threshold renders today's line in today's position.
- [ ] **AC-5** (R3, R5): The fresh line never appears in `stableLines` (spec 021 assertion on the built
  prompt sections), and no scheduler/enqueue behavior changes when a fresh pending address exists.
- [ ] **AC-6** (R4): Unit test — B has `meanCycleIntervalTicks = 3600`; a conversation with
  `lastActivity = nowTick − 120` is **not** closed by the tick sweep (today's code closes it); at
  `lastActivity = nowTick − 7201` it closes with reason `idle timeout`.
- [ ] **AC-7** (R4): Unit test — with `meanCycleIntervalTicks` undefined on all participants, a
  conversation still closes once `nowTick − lastActivity` exceeds `2 × DEFAULT_CYCLE_INTERVAL_TICKS`, and
  the existing spec 033 `conversation-manager` lifecycle tests pass unmodified (the `idleTimeoutTicks`
  floor semantics are intact for directly-driven configs).
- [ ] **AC-8** (R4): Unit test — an idle-timeout closure emits one `[conversation]` line containing the
  conversation id, the idle tick count, and the effective timeout.
- [ ] **AC-9** (R5): Full suite green; `pper-scheduler.ts` diff is limited to the two-field bookkeeping
  write in `startCycle`; no test asserting cycle cadence, gating, or spec 040 suppression behavior changes.
- [ ] **AC-10** (R6): Live-run evidence per R6 is attached to issue #167 (reply rate > 0, ≥ 1 conversation
  with ≥ 2 turns, Tomas > Iris > Maren reply-rate ordering).

## Constraints
- **Package boundaries (ADR-0001):** `shared` (constants, `PendingAddressInfo` fields,
  `AgentInternalState` fields) ← `engine` (scheduler bookkeeping, conversation-manager timeout) and ←
  `cognition` (diagnostic line, fresh-address promotion) ← `examples` (explicit seed). No new cross-package
  edges; `shared` stays dependency-free.
- **Determinism:** the new engine paths are pure tick arithmetic — no `Date.now()`, no timers, no LLM
  calls. The EMA has a fixed, documented coefficient.
- **KV-cache discipline (spec 021):** the `FRESH:` line is per-agent, per-tick dynamic state — dynamic
  section only, never `stableLines`.
- **Persistence:** all new state is optional fields on existing snapshotted structures so v1/v2/v3 saves
  keep loading; `SAVE_FORMAT_VERSION` bumps only if the implementer finds a field that cannot ride the
  existing snapshot path (document if so).
- **Log hygiene:** diagnostics are one line each, prefixed (`[social-urge]`, `[conversation]`), never dump
  the full LLM context, and are wrapped so a logging failure can never break a cycle.
- **What NOT to do:** no forced cycles, no triggers, no scheduler cadence/gating changes (R5); no changes
  to the urge formula or its thresholds; no pending-address lines for closed conversations (Decision 6);
  no explicit seeds for Tomas/Iris where inference is already correct (Decision 5); no reuse of
  `matchDrivesToAffordances` for the social drive (spec 044 Decision 2); no edits to `dist/`; never block
  the synchronous game loop (`is_thinking` routing); always `pnpm build` before a live validation run
  (spec 037 Evidence).
