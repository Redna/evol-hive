# QA Notes — Spec 046 (talk_to Target Resolution & Sentiment Passthrough) — PR #174 coverage audit

> YAAM note: the daemon (raw-TCP JSON-RPC on `127.0.0.1:<.yaam/daemon.port>`)
> exposes a single `search` method (`{"text": …}` — probed `query` →
> `Invalid search request: missing field 'text'`; `note_write`/`note_append`
> etc. remain `Method not found`, same finding as the spec 045/040 notes).
> Findings are recorded here per the notes-directory convention; this file is
> itself YAAM-indexed and discoverable via `yaam_search`.

## Scope

QA pass over PR #174 ("spec: draft spec for issue #173 — spec 046"), issue
#173. PR #174 is a **spec-only draft** (single commit, merged as 52303f4): the
working tree carried the pre-implementation state the spec documents — no
`resolveAgentId` anywhere in `packages/`, `openai-client.ts:662` dropped the
`sentiment` tool arg, `perception-builder.ts:84` rendered display names only,
`ConversationManagerImpl.open()` added unvalidated participants. Therefore
**zero of AC-1..AC-10 mapped to existing tests** at audit time. Following the
repo's own precedent (spec 045 QA session, commit e622d54 "close remaining
deterministic AC coverage gaps"), the QA pass implemented R1–R6 per the spec
and pinned every AC with tests. Result: implementation PR **#175** (branch
`feature/173-talk-to-target-resolution-impl`, commits fc8d814 / d22ae51 /
9d2562f), issue #173 labeled `Status: In Review/QA`.

## AC → test coverage map (all deterministic — no LLM anywhere)

| AC | Status | Evidence |
|----|--------|----------|
| AC-1 (display-name talk_to → REAL participants; R7-sweep survival) | ✅ COVERED | `examples/tests/spec-046-talk-to-target-resolution.test.ts` (production executor, participants `['agent-alice','agent-bob']`, `tick(openedAt+1)` keeps status `open`); engine suite sweep basis; cognition unit pins resolved-ID dispatch |
| AC-2 (queue key = real ID; awaiting-reply + rendered pending-address line) | ✅ COVERED | examples E2E: `getConversationsAwaitingAgentReply('agent-bob')` → 1 with the actual message; `dequeueSocialMessages` keyed by real ID; rendered perception quotes the message; phantom key `'Bob'` asserted to receive nothing |
| AC-3 (reply extends SAME thread, open → active) | ✅ COVERED | examples E2E: reply via display name `'Alice'` → same `convId`, 2 turns, `active`, turnCounts 1/1 |
| AC-4 (real target's `receivedCount` increments) | ✅ COVERED | examples E2E (both ledgers after the exchange) + cognition unit (`receivedCount: 1` on the resolved-ID write) |
| AC-5 (sentiment arg mapping in the mid-loop) | ✅ COVERED | cognition `spec-046-target-resolution.test.ts` — fetch-mock harness: `'negative'`/`'positive'` pass through; missing/`'angry'` → `'neutral'`; also updated the spec-018 AC-33 assertion (3-arg → 4-arg with `'neutral'` default) |
| AC-6 (`Agents present: Bob (agent-bob) (idle)`; above `---`; structure unchanged) | ✅ COVERED | examples E2E (rendered payload, stable/dynamic split, directive line unchanged) + plan-builder renders IDs too; pinned strings updated: `spec-018-social.test.ts` ×2 (AC-41/AC-47), `examples/tests/coffee-shop.test.ts` ×1 (fed-format; mock parser is prefix-only) |
| AC-7 (sibling tools resolve; no phantom keys) | ✅ COVERED | cognition units: `observe_agent`/`help`/`ignore` display-name → real ID in every relationship write; unresolvable siblings → failure with ZERO writes |
| AC-8 (unresolvable → structured failure listing present agents; no writes) | ✅ COVERED | examples E2E: `'Zed'` → failure, message contains `Present agents: … Bob (agent-bob)` (engine-built refusal surfaced verbatim — the `modify_scene` Req 17 pattern; R3-hardened `openOrContribute` writes nothing), zero conversation/relationship/queue writes. Cognition unit pins the surfacing + the no-conversation-bridge fallback message. Sibling-tool failures point at the perception line (which names IDs post-R4) — noted as a deliberate, documented nuance |
| AC-9 (bare ConversationManagerImpl tolerance; interface unchanged) | ✅ COVERED | engine `spec-046-target-resolution.test.ts`: `openOrContribute('agent-alice','Bob')` → real participants; unresolvable → `success:false` + present-agents message + nothing written; display-name self-target → self-talk failure; `contribute` speaker-key resolution; `ConversationBridge` pinned unchanged against `shared/src/types/conversation.ts` |
| AC-10 (suite green; 033/044/045 unmodified; exact-ID unchanged) | ✅ COVERED | spec 033/044/045 suites pass **unmodified**; exact-ID regression at unit + production level; legacy bridges without `resolveAgentId` keep raw passthrough (runtime `typeof` guard — AC-10 is why the method guard exists) |

## Implementation summary (R1–R6, PR #175)

- **R1** `shared`: `SocialActionBridge.resolveAgentId(requesterAgentId, nameOrId): string | null`
  (the ONE interface method the spec allows). `engine` `SocialManager`:
  exact-ID passthrough (active state only — despawn deletes state) →
  case-insensitive `profile.name` match over active agents preferring the
  requester's room → `null` on ambiguity/no match.
- **R2** `cognition` `CognitiveToolExecutorImpl`: `resolveSocialTarget` choke
  point before ANY dispatch, for all four social tools; unresolvable talk_to
  targets surface the engine's refusal (present agents listed) and write
  nothing; telemetry `[social] … talk_to→<real-id>`.
- **R3** `engine` `ConversationManagerImpl`: `resolveParticipantKey` (exact ID →
  unique case-insensitive name) in `openOrContribute`/`contribute`;
  `unresolvableTargetMessage` lists present agents with IDs; no phantom
  participant can ever be created. `ConversationBridge` interface untouched.
- **R4** `cognition` `perception-builder` + `plan-builder`: `Name (agent-id) (activity)`
  rendering; stable-section placement preserved (spec 021).
- **R5** `cognition` `openai-client.ts` mid-loop `talk_to` branch: sentiment
  validated against the spec 033 enum, `'neutral'` default, passed as the 4th
  `executeTalkTo` arg.
- **R6**: no `examples/` wiring changes; legacy `+5/+2` fallback intact.

## Gates (final run, all green)

- `pnpm build` ✅ · `pnpm test` **2,364 passed / 0 failed** (170 files; 38 new
  spec-046 tests: engine 15, cognition 13, examples 10)
- `pnpm typecheck` ✅ · `pnpm lint` ✅ · `pnpm format:check` ✅

## Housekeeping / follow-ups

1. INDEX.md: spec 046 row added → 🔍 In Review (PRs #174 + #175); totals 61→62,
   In Review 17→18 (the spec draft PR had not added the row).
2. Issue #173 labeled `Status: In Review/QA` (tests pass, coverage complete).
   The stale `Status: Ready for Dev` label remains on the (closed) issue —
   left untouched as out of the QA instruction's scope; harmless but worth a
   sweep next label audit.
3. **Manual live-run follow-up (unchanged from the spec)**: re-validate spec
   045's open ACs + spec 043 pending-address rendering + #167 reply rate with
   a real LLM once #175 merges; record evidence on #173/#167.
4. QA report posted on PR #174 (coverage map + verdict); implementation PR
   #175 carries the code, tests, and INDEX row.

## Verification pass — PR #175 re-run (2026-09-10, QA)

Independent re-verification of PR #175 from a clean checkout of its head
(`440f797`, confirmed == `headRefOid`):

- **Gates re-run**: `pnpm build` ✅ (required first in a fresh env —
  `@evol-hive/shared` entry unresolvable until built; workspace artifact,
  not a PR defect) · `pnpm test` **2,364 passed / 0 failed** (170 files —
  matches the claim exactly) · `pnpm typecheck` ✅ · `pnpm lint` ✅.
- **38 spec-046 tests confirmed passing**: engine 15 / cognition 13 /
  examples 10, matching the PR body.
- **AC-1..AC-10 all mapped** — full coverage table posted as a QA report on
  PR #175 (comment 5617243449). AC-10's "033/044/045 unmodified" verified via
  `git diff --stat 8c66f2a..HEAD`: no spec-033/044/045 test files touched;
  only the AC-6-mandated pin updates (`spec-018-social` ×2, `coffee-shop` ×1).
- **R5 spot-check**: sentiment enum-validation + `'neutral'` default confirmed
  at `openai-client.ts:663–669`.
- **Issue #173**: `Status: In Review/QA` label already present (re-added
  idempotently); stale `Status: Ready for Dev` remains on the closed issue —
  still pending the next label sweep.
- **YAAM**: daemon exposes `search` only (`note_write`/`rpc.methods` →
  `Method not found`, consistent with the 045/040 findings); `search` works —
  this file is indexed and discoverable. Findings recorded here per the
  notes-directory convention.