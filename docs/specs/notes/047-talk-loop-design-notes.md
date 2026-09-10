# Design Notes — Spec 047 (Talk Loop Fix: Urge-Gated Urgency & Asymmetric Social Reward) — Issue #176

> YAAM note: the YAAM daemon (raw-TCP JSON-RPC on `127.0.0.1:37227`, port from
> `.yaam/daemon.port`) exposes only `search` (probed `rpc.discover`,
> `workspace_initialize`/`workspace_init`/`initialize_workspace`/`workspace_create`,
> `note_write`/`note_append` — all `Method not found`, same finding as the spec 045/046
> notes). `yaam_search` was used for code discovery ("talk_to social drive restore 10",
> "urge reciprocity decayed directive IMPORTANT", "conversation contribute turn speaker
> thread"). Workspace `feature-047-talk-loop-urge-gating-asymmetric-reward` design
> decisions are therefore recorded here per the notes-directory convention; this file is
> itself YAAM-indexed and discoverable via `yaam_search`.

## Code findings (from `yaam_search` + grep, feeding the spec)

1. **The +10 is unconditional**: `packages/cognition/src/tools/cognitive-tool-executor.ts`,
   `executeTalkTo` → `this.stateDataProvider.applyDriveChanges(agentId, { social: 10 })` —
   granted on every successful send, independent of the conversation result and of whether
   the target ever replies. This is mechanism (2) of the loop.
2. **The urgency path is urge-blind**: `packages/cognition/src/pper/perception-builder.ts`
   pushes the spec 024 directive ("IMPORTANT: Other agents are present. Call talk_to, …")
   whenever `hasAgentsPresent` — no urge consultation. `moveTalkToFirst` (spec 044
   Decision 5) promotes `talk_to` unconditionally; a decayed urge only removes the
   spec-044 *boost*, the promotion stands. This is mechanism (1).
3. **The urge model is already correct**: `shared/social-urge.ts` — urge ≈ 0.05 computed
   from `sentCount − receivedCount` via `computeReciprocityFactor` (floor 0.2), vs
   `SOCIAL_URGE_SURFACE_THRESHOLD = 0.45`; `SOCIAL_URGE_RECIPROCITY_DECAYED = 0.7`. The
   fix must *gate* the urgency path with these existing signals, not recompute them.
4. **Thread-scoped evidence exists**: `ConversationManagerImpl.contribute` appends turns
   with `agentId`; participants are resolved keys (spec 046). "Real exchange" =
   target's turn in the same conversation object. The manager is engine-side and can host
   the completion hook; `assembly.ts` already wires conversation/social managers and has
   the drive path (`AgentManager` → `driveSystem.applyChanges`).

## Design decisions

- **D1 — Gate, don't block (spec 044 philosophy preserved).** `talk_to` stays in the tool
  list in all states. Gating affects only prompt rendering (directive/hint suppression +
  no-outlet line), ranking promotion (`moveTalkToFirst` no-op), and reward size. The LLM
  keeps the decision; the economy stops paying for monologues.
- **D2 — Suppression condition = decayed toward ALL present, urge-computed only.** The
  directive is suppressed only when every present agent has a computed urge that is
  reciprocity-decayed (`reciprocityFactor < SOCIAL_URGE_RECIPROCITY_DECAYED` &&
  `sentCount > 0`). No urges computed (feature unwired) → current behavior, zero-risk
  backward compat. Mixed rooms (one healthy target) keep the directive.
- **D3 — Cap enforced where ranking happens, not in the tool executor.** The
  consecutive-unanswered cap (N=3, `SOCIAL_TALK_CAP`) lives in the perception-builder
  ranking layer, per-target. It reuses the same counters as the urge model — no second
  reciprocity computation. The executor stays cap-free (the LLM can still force it; it
  just won't be ranked or paid for it).
- **D4 — Reward split: +2 on send, +8 on exchange completion (total 10).** Keeps AC-2
  ("restores social as today" for real exchanges) while making monologues economically
  inert. Constants `SOCIAL_MONOLOGUE_REWARD = 2`, `SOCIAL_EXCHANGE_BONUS = 8` in `shared`
  next to the 044 constants.
- **D5 — Deferred restore is engine-side, thread-scoped, idempotent.** Hook on
  `ConversationManagerImpl` (wired in `assembly.ts` with the drive-apply callback): when
  the target contributes to a thread, earlier monologue-only participants get +8 once per
  (sender, conversation). Cognition-side bookkeeping was rejected: per-agent cognition
  state can't see other agents' contributions and would double-count in multi-agent runs.
- **D6 — Dynamic section only (KV-cache, spec 021).** New/changed perception lines render
  in the dynamic section; the stable prefix is untouched.

## Open questions for review

- Should the no-outlet line name alternative affordances generically ("consider another
  activity or help") or stay fully non-prescriptive? Drafted with the former; easy to soften.
- Should the deferred +8 expire if the thread closes unanswered? Drafted: no expiry —
  the sender simply never receives it (monologue stays +2). An expiry adds state for no
  behavioral gain.
