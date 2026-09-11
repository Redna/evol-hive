# Spec 051 Implementation Notes — Enum-Bound Conversation Targeting

> YAAM note (session record): this environment's YAAM daemon (raw-TCP JSON-RPC on
> `127.0.0.1:36165`, port from `.yaam/daemon.port`) exposes only `search` +
> `initialize` over TCP JSON-RPC (probed `rpc.discover`-style). Notes are written
> as `docs/specs/notes/*.md` files — they get indexed by the daemon's document
> adapter and are findable via `search`. Matches the convention recorded in
> `045-assembly-conversation-wiring-implementation-notes.md` and
> `047-talk-loop-design-notes.md`.

## Branch / PR

- Branch: `feature/051-enum-bound-talk-targets`. PR opened against `main` referencing
  this spec + issue #186: **PR #188**.
- Commits: `14ca9b4` (failing-first tests), `d814fd8` (implementation), `0936f5c` (prettier).

## Built (spec 051, issue #186)

### Shared layer (`@evol-hive/shared`)

- **`talkToToolFor(validTargetIds)` / `talkToSchemaFor(validTargetIds)`** (`src/schemas/llm-schemas.ts`,
  R1/AC-1) — per-cycle enum-bound `talk_to` factory mirroring `formulatePlanToolFor`:
  `targetAgentId` = `{ type: 'string', enum: [...valid] }` with the spec-mandated
  description "an agent ID from the enum (agents present right now, not past the
  unanswered cap)". `message`/`sentiment`/`required`/`additionalProperties` unchanged.
  Empty list → enum property omitted (spec 037/039 empty-value-space pattern; never an
  illegal empty enum) — builders omit the tool entirely in that case. The static
  `talkToTool`/`talkToSchema` remain exported unchanged (backward compat for tests
  asserting the old free-form shape).
- **`SocialActionBridge.enumerateTalkTargets?`** (`src/types/cognition.ts`, R3) — OPTIONAL
  method; the optionality is pinned by source-read tests in both shared and engine suites
  (AC-7 basis, same readFileSync pattern as the spec 046 engine test).
- **`isSocialTalkGapCapped(sentCount, receivedCount)`** (`src/types/social-urge.ts`, R2) —
  THE unanswered-gap cap arithmetic (`gap >= SOCIAL_TALK_CAP`), next to the constant.
  Cognition's `isSocialTalkCapped(assessment)` now delegates to it, and the engine's
  enumeration consumes it — literally one computation, two consumers (no second cap
  computation).
- **`SOCIAL_MONOLOGUE_REWARD` unchanged = 2** (R5/AC-9) — deferred decision tracked by R4
  telemetry; the existing spec-047 constants test keeps asserting it (plus a pin in the
  051 shared suite).

### Engine layer (`@evol-hive/engine`)

- **`SocialManager.enumerateTalkTargets(requesterAgentId)`** (`src/social/social-manager.ts`,
  R3) — co-located ACTIVE agents (via the existing `getAgentsInRoom`, so despawned agents
  and other-room agents are excluded) minus capped targets, reading the requester's own
  `relationships` map (`rel?.sentCount ?? 0` etc. — fresh pairs are uncapped). Unknown
  requester → `[]`; requester alone in a room → `[]`. Recovery is mechanical: the target's
  reply raises `receivedCount`, the gap drops below the cap, the target re-enters
  (Decision 2 — the gap IS the clock, no cooldown timer).

### Cognition layer (`@evol-hive/cognition`)

- **`pper/talk-enum.ts`** (new, R1/R2/R4): `computeTalkEnum(agentsPresent, assessments)` —
  pure value-space construction; present IDs minus `isSocialTalkCapped` targets; agents
  without an assessment stay VALID (feature-off/partial coverage degrades to the pre-051
  space restricted to perception). Also `logTalkEnumDiagnostic` — the `[talk-enum]`
  line (R4/AC-8): `[talk-enum] agent=<id> present=<n> valid=<n> excluded=[ids]`, emitted
  only when agents are present.
- **Perception-builder** (R1/AC-2): the social-tools block now builds `talk_to` via
  `talkToToolFor(talkEnum.valid)`; when the valid list is empty the tool is omitted while
  `observe_agent`/`help`/`ignore` render (AC-4). The spec 044 promotion and spec 047 gates
  are untouched (they operate on urgency, not the value space). The enum lives in the
  per-cycle tool-definition block, never in the stable prompt (KV-cache, spec 021) —
  asserted by a test.
- **Plan-builder** (R1/AC-2/AC-4): `buildPlanTools` gained a `talkValidTargets` param; the
  plan-phase `talk_to` is the same per-cycle factory, omitted when nothing is valid.
- **Executor** (`tools/cognitive-tool-executor.ts`, R3/AC-6/AC-7): after the spec 046
  resolution, `executeTalkTo` validates the RESOLVED target against
  `enumerateTalkTargets` (typeof guard — bridges without the method pass through
  bit-for-bit). Excluded target → structured failure
  `"You've sent too many unanswered messages to <name> (<id>) — give them space. They'll be
  available to talk to again after they reply."` and NOTHING is written — the check runs
  BEFORE the conversation `openOrContribute`, `queueMessage`, both `updateRelationship`
  calls, and the `SOCIAL_MONOLOGUE_REWARD` drive grant. The message carries both display
  name and resolved ID (unambiguous for Req 17 self-correction).
- **Orchestrator**: `logTalkEnumDiagnostic(agentId, perception)` called in the same
  try/catch seam as `logSocialUrgeDiagnostic` (spec 049 discipline — can never break a
  cycle). Spec 049 diagnostic tests keep passing (the `[talk-enum]` line is a separate
  prefix).

### One legitimated test update

- `examples/tests/spec-047-talk-loop-urge-gating.test.ts` AC-8 asserted "talk_to is still
  in the tool list" (influence-not-force) for an all-decayed room whose fixture is exactly
  3 unanswered monologues — i.e. all-CAPPED. Spec 051 intentionally supersedes that: the
  cap now closes the VALUE SPACE, so the assertion became "talk_to omitted, siblings
  render" (AC-4 contract). All other 047/049 assertions pass unmodified.

## Verification

- `pnpm test` — all 8 packages green (shared 28, memory 13, engine 65, cognition 53,
  assembly 4, visualizer 9, cli 4, examples 13 test files; 49 new spec-051 tests).
- `pnpm typecheck` / `pnpm lint` / `pnpm format:check` / `pnpm build` — clean.
- Note for future sessions: the workspace needs `pnpm --filter <pkg> build` for shared /
  memory / engine / cognition / assembly / visualizer dists before cognition + examples
  suites can resolve `@evol-hive/*` (fresh checkout artifact, not a regression).

## Open items

- **AC-10 (live)**: the 30-min live run (cc=3, same scene as spec 050) — Tomas's
  monologue count toward Maren ≤ 10, social not pinned at 100, no `[social]` line queued
  to an excluded target. Needs the live environment; QA owns it.
- **R5 (deferred)**: if the loop persists through valid-but-unanswered targets below the
  cap, a follow-up spec flips `SOCIAL_MONOLOGUE_REWARD` to 0 — the `[talk-enum]` +
  `[social-urge]` telemetry is the evidence base.

## Environment breadcrumbs

- YAAM daemon: raw-TCP JSON-RPC on `127.0.0.1:<daemon.port>`; only `search` works
  (`{"jsonrpc":"2.0","id":1,"method":"search","params":{"text":"...","limit":N}}` — note
  `text`, not `query`). Writes go through `docs/specs/notes/*.md` + git.
- PRs MUST be created with the PAT override (`GH_TOKEN=... gh pr create ...`) — the
  default App token gets CI blocked.