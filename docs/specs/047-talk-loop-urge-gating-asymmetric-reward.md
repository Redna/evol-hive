# Feature: The Talk Loop Fix — Urge-Gated Social Urgency & Asymmetric Social Reward

> Issue: [#176](https://github.com/Redna/evol-hive/issues/176) — "bug: the talk loop — self-reinforcing
> talk_to via own-social reward, immune to urge decay (443 monologues in one run)". In the spec-046
> validation run (30 min, cc=3), 451 social events included 443 Tomas→Maren monologues; Tomas's social
> drive sat pinned at 100 while the urge model correctly computed "don't talk" (urge ≈ 0.05 vs the
> 0.45 surface threshold) — and Tomas talked anyway. Root cause is two stacked mechanisms: (1) the
> urgency path (spec 024 directive + talk_to-first ranking) never consults the urge model, and (2)
> `talk_to` grants +10 own social for a monologue, identical to a real exchange, so the
> decay→urgent→talk→saturated loop is self-sustaining forever.

## Context
- Architecture: [§3 — Agent State Schema](../architecture/03-agent-state-schema.md) (drives, relationships, reciprocity counters), [§6 — PPER Loop](../architecture/06-pper-loop.md) (perceive-phase dynamic section, where the directive and hints render), [§8 — Cognitive Tools](../architecture/08-cognitive-tools.md) (`talk_to` execution path)
- Related specs: [024 — Social Tool Invocation Fix](024-social-tool-invocation-fix.md) (the "IMPORTANT: … Call talk_to …" directive), [033 — Conversations as Perceivable Temporal Objects](033-conversations-identity-evolution.md) (conversation objects, turns, open-or-contribute — the "same thread" evidence for a real exchange), [034 — Drive→Affordance Hints](034-drive-affordance-hints-hunger-chain.md) (matcher; `social` deliberately excluded — the 018/024 system owns it), [044 — Social Urge Model](044-social-urge-model.md) (urge formula, reciprocity factor, `SOCIAL_URGE_SURFACE_THRESHOLD`, `SOCIAL_URGE_RECIPROCITY_DECAYED`, `moveTalkToFirst` ranking shift), [046 — talk_to Target Resolution](046-talk-to-target-resolution-sentiment-passthrough.md) (target resolution choke point; its tests must not regress)
- Package: `cognition` (perception-builder directive/hint gating, tool-list ranking, `executeTalkTo` reward split), `shared` (new constants/types), `engine` (conversation-manager exchange-completion hook + assembly wiring of the deferred-restore callback)
- Issue: [#176](https://github.com/Redna/evol-hive/issues/176)

### Evidence summary (from the issue)

| Signal | Value |
| --- | --- |
| Social events in run | 451 (443 Tomas→Maren monologues) |
| Tomas's social trajectory | 94 → 92 → 100 pinned for the rest of the run |
| Other affordances Tomas performed | 1 (`take_tool`); plans degenerated to wait-steps |
| Urge model verdict | unanswered ≈ 370 → reciprocity floor 0.2 → urge ≈ 0.05 (< 0.45) |
| What Tomas did anyway | "Morning, Maren. Need a hand…?" every few cycles, whole run |

### Root cause (two stacked mechanisms)

1. **The urgency path never consults the urge model.** When social drops below the hint threshold,
   the spec 024 directive fires ("IMPORTANT: … Call talk_to … directly") and the tool list ranks
   `talk_to` first. Spec 044's urge can *boost* `talk_to` when urge is high, but a decayed urge only
   removes the boost — the urgency-driven ranking stands. One imperative line beats one informational
   hint.
2. **Monologues satisfy the social drive.** `talk_to` grants +10 own social regardless of whether the
   target ever responds (`cognitive-tool-executor.ts`, `applyDriveChanges(agentId, { social: 10 })`).
   Talking to an unresponsive agent is mechanically identical to a real exchange, so the loop is
   self-sustaining: decay → urgent → talk → +10 → saturated → decay.

## Requirements

### R1 — Urge-gated urgency directive (perception-builder)

When agents are present AND the social urge model has computed urges for every present agent AND
every such urge is decayed (reciprocity factor < `SOCIAL_URGE_RECIPROCITY_DECAYED` with
`sentCount > 0`, i.e. below the surface threshold specifically *because of* learned
non-responsiveness), the spec 024 directive line ("IMPORTANT: Other agents are present. Call talk_to,
…") MUST NOT be rendered. It is replaced by a no-outlet line, e.g. "No one in the room is responsive —
consider another activity or help." The directive still renders when urge is healthy for at least one
present target, or when urges have not been computed (feature-off backward compat).

### R2 — Urge-gated social-drive hint (perception-builder)

The spec 018 social-drive hint ("You feel a strong need for social interaction. Consider using
talk_to or help…") is governed by the same gate as R1: when the urge toward all present targets is
decayed, the hint is suppressed in favor of the same no-outlet line. The spec 044 urge hint ("{name}
rarely answers — maybe let them be.") continues to render per-target as today.

### R3 — Urge-gated `talk_to` ranking (perception-builder)

`moveTalkToFirst` (spec 044 Decision 5) is a no-op when the urge toward every present agent is decayed
per R1's condition: `talk_to` keeps its natural position in the tool list instead of being promoted as
the social-urgency answer. The tool remains available — the LLM keeps the decision (spec 044: influence,
not force) — it is simply no longer urgency-ranked.

### R4 — Consecutive-unanswered cap in ranking (perception-builder)

The matcher/tool-list layer enforces the cap the urge model already computes: when an agent has ≥
`SOCIAL_TALK_CAP` (= 3) consecutive unanswered `talk_to` messages toward a specific target
(`sentCount − receivedCount ≥ cap` for that relationship), `talk_to` toward that target is not
urgency-promoted (excluded from `moveTalkToFirst` promotion and from social-urgency hint
recommendations). Per-target, not global: a fresh target with a healthy urge is still rankable.

### R5 — Asymmetric social reward (cognitive-tool-executor)

`talk_to` own-social reward becomes asymmetric:
- On send (a potential monologue): grant a token amount of `+2` own social
  (`SOCIAL_MONOLOGUE_REWARD = 2`).
- On a **real exchange** — the target contributes ≥ 1 turn to the same conversation thread — the
  sender is retroactively topped up to the full current restore (`+8` remainder,
  `SOCIAL_EXCHANGE_BONUS = 8`; total 10, matching today's behavior). The drive semantically means
  *need for exchange*, not need for emission.

### R6 — Exchange-completion detection & deferred restore (engine)

`ConversationManagerImpl` exposes an optional exchange-completion callback (wired in `assembly.ts`):
when a turn lands in a conversation by agent T, every other participant S whose only contributions so
far are unanswered messages (S never received a turn from T in that thread) and who has not already
been topped up for that thread receives the deferred restore (R5's `+8`) via an injected drive-apply
callback. The restore is idempotent — at most once per (sender, conversation) pair — and never
re-granted on repeated contributions or thread rejoin. Engine-side drive application uses the existing
`AgentManager` drive path; no new drive plumbing is invented.

### R7 — Shared constants & documentation

New exported constants live in `shared` next to the spec 044 urge constants, with doc comments
cross-referencing this spec and issue #176: `SOCIAL_TALK_CAP = 3`,
`SOCIAL_MONOLOGUE_REWARD = 2`, `SOCIAL_EXCHANGE_BONUS = 8`. Existing spec 044 constants
(`SOCIAL_URGE_SURFACE_THRESHOLD`, `SOCIAL_URGE_RECIPROCITY_DECAYED`, reciprocity floor/decay) are
reused — no threshold duplication.

## Requirements → Acceptance Criteria mapping

| Requirement | AC(s) |
| --- | --- |
| R1 | AC-1, AC-3 |
| R2 | AC-3 |
| R3 | AC-1 |
| R4 | AC-1, AC-5 |
| R5 | AC-2, AC-4 |
| R6 | AC-2, AC-6 |
| R7 | AC-7 |

## Acceptance Criteria

- [ ] **AC-1** (issue AC-1): With reciprocity decayed (e.g. a target with ≥ 3 unanswered messages,
  reciprocity at floor), a socially-urgent agent does NOT spam `talk_to`: an integration simulation
  run with a non-responsive target yields ≤ ~10 talk events per pair for the whole run (vs 443 in the
  issue's evidence run). Covers R1–R4 together (directive suppressed, hint suppressed, ranking not
  promoted, cap enforced).
- [ ] **AC-2** (issue AC-2): A real exchange restores social as today — sender ends at +10 total
  (+2 on send, +8 when the target contributes to the same thread). Assert the drive delta across the
  two events in a unit/integration test. Covers R5, R6.
- [ ] **AC-3** (issue AC-3): The 044 urge hint and the 024 directive stop contradicting each other:
  with urge decayed toward all present agents, the "IMPORTANT: … Call talk_to …" directive is absent
  from the built context, the no-outlet line is present, and the per-target "rarely answers" line is
  present. Covers R1, R2.
- [ ] **AC-4**: A monologue grants exactly +2 own social (drive snapshot before/after
  `executeTalkTo` with a target that never replies) — no full restore. Covers R5.
- [ ] **AC-5**: The consecutive-unanswered cap (N = 3) is enforced in ranking: with
  `sentCount − receivedCount ≥ 3` toward a target, `talk_to` is not moved to the front of the tool
  list, while a different target with a healthy urge still can be. Covers R4.
- [ ] **AC-6**: The deferred restore is idempotent: a target contributing 1..N turns to a thread where
  the sender previously monologued grants the +8 exactly once per (sender, conversation); re-contributions,
  leave/rejoin, and multi-sender threads never double-grant. Covers R6.
- [ ] **AC-7** (issue AC-4): No regression — full suite green (`pnpm -r run test`), plus typecheck,
  lint, format:check; all spec 046 (#173) resolution tests pass unchanged. Covers R7 and backward
  compat (urges-not-computed → behavior identical to today).
- [ ] **AC-8**: With urge decayed toward all present, the rendered perception contains the no-outlet
  guidance line and contains no directive or hint instructing the agent to call `talk_to` (prompt-snapshot
  test of the perception builder). Covers R1, R2.

## Constraints

- **Package boundaries**: `shared` (constants, urge/conversation types if extended), `engine`
  (conversation-manager callback + assembly wiring), `cognition` (perception-builder, tool ranking,
  cognitive-tool-executor reward). No changes to `memory`, `training`, or the visualizer.
- **Influence, not force (spec 044 philosophy)**: `talk_to` is never removed from the tool list and
  never hard-blocked. Gating affects only (a) whether urgency prompts render, (b) ranking promotion,
  and (c) how much social the action restores. The LLM can still choose to talk; the economy simply
  stops paying it to monologue.
- **KV-cache safety (spec 021)**: all new/changed lines live in the dynamic section only. The stable
  prefix must not change.
- **Determinism**: the gate, cap, and reward asymmetry are pure deterministic functions of existing
  state (reciprocity counters, conversation turns). No randomness, no LLM calls, no scheduler changes.
- **Reuse, don't duplicate**: thresholds come from the spec 044 constants; the cap condition derives
  from the same `sentCount`/`receivedCount` counters the urge model consumes (single source of truth).
  Do not add a second reciprocity computation.
- **No drive-system changes**: decay rates (spec 019) and the 0–100 drive scale are untouched; only
  the `talk_to` grant path and the deferred top-up change.
- **Spec 046 must not regress**: target resolution, sentiment passthrough, and the 046 test suite are
  untouched semantics — the reward split happens after resolution succeeds.
- **What NOT to do**: do not suppress the directive based on the social drive value alone (that is the
  current bug — drive urgency must be gated by urge decay); do not grant the deferred restore from
  cognition-side per-agent state (it must be engine-side and thread-scoped, or multi-agent runs will
  double-count); do not count a target's message in a *different* conversation as "the exchange" —
  the thread (conversation object) is the unit.
