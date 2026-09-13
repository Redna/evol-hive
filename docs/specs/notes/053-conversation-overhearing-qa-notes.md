# QA Verification Notes — Spec 053 (PR #194 coverage audit)

> YAAM note: recorded here per the notes-directory convention. This
> environment has no YAAM daemon running (`~/.yaam/` holds only `models/`;
> no `daemon.port` file, so the raw newline-delimited JSON-RPC `search` on
> `127.0.0.1:<.yaam/daemon.port>` used in the spec 048 pass was unavailable,
> and no `yaam_search` CLI/MCP tool is reachable). The requested
> `yaam_search("feature-")` could therefore not be executed; this file is
> itself YAAM-indexed and discoverable via `yaam_search` once the daemon
> runs. Same finding class as the spec 045/046/040/048 notes
> (`note_write` → `Method 'note_write' not found` (-32601)).

## Scope

Independent QA verification of PR #194 (spec 053 — Room-Perceivable
Conversation Content, issue #192). Steps executed: PR body + full diff read;
spec `docs/specs/053-conversation-overhearing.md` acceptance criteria mapped
to tests; YAAM workspace-note search attempted; all gates re-run;
**coverage gaps closed with 13 new tests**; QA report posted on the PR
([comment](https://github.com/Redna/evol-hive/pull/194#issuecomment-5652364841));
issue #192 labeled `Status: In Review/QA`.

## AC → test coverage map (verified)

| AC                                               | Status                   | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------ | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AC-1 (R1 passive overheard + render below `---`) | ✅ COVERED (gap closed)  | Unit: engine `spec-053-overheard-conversations.test.ts` (provider scan, co-location-only gate), cognition `spec-053-overheard-perception.test.ts` (display names, agent-ID fallback, below-separator-only, feature-off silence). **Gap found & closed:** no test drove the production path end to end → new `packages/assembly/tests/spec-053-overheard-e2e.test.ts`: real `talk_to` executor → real `ConversationManagerImpl` → real `SocialManager` → real `core.bridges.perception` → real `PerceptionServiceImpl` → real `PerceptionBuilderImpl`; pins the rendered `INFORMATION: Overheard — agent-a to agent-b: "…"` line and dynamic-section-only placement. |
| AC-2 (R3 observe full history)                   | ✅ COVERED (gap closed)  | Unit: engine observe-turns/participants/eligibility trio, shared type contract, updated spec-033 superseded-contract test. **E2E added:** observe through the production manager (2-turn window oldest-first, observer not a participant, no `contribute`).                                                                                                                                                                                                                                                                                                                                                                                                         |
| AC-3 (R4 room walls + R5 participant exclusion)  | ✅ COVERED (gap closed)  | Unit: engine different-room absence + participant exclusion. **QA addition extends the chain:** both gates re-asserted through `SocialManager` → `PerceptionDataProviderImpl`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| AC-4 (R2 cap=3, latest-first)                    | ✅ COVERED               | Unit: engine 8→3 latest-first + 1→1; shared constant (=3, ≤ 8-turn window); cognition render order.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| AC-5 (R5 participant view + spec-021 stable)     | ✅ COVERED (gap closed)  | Unit: engine participant exclusion; cognition `---` byte-identity split. **E2E added:** participants' rendered perception carries no overheard lines while the addressee's pending-address line is intact; initiator receives neither channel.                                                                                                                                                                                                                                                                                                                                                                                                                      |
| AC-6 (superseded-note on spec 033 R3)            | ✅ VERIFIED (doc AC)     | Diff inspection: 033 R3 superseded-note + observe annotation present, no other 033 text rewritten, INDEX.md row added.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| AC-7 (R6 `[overheard]` diagnostic)               | ✅ COVERED (gap closed)  | Unit: direct + perceive→plan-seam + silence + never-throws + cap evidence. **Gap found & closed:** per-conversation counts exercised with a single conversation only → added multi-conversation format/order tests (`conv-A\|rendered=3\|available=8, conv-B\|rendered=1\|available=1`, provider order, empty-lines entry filtered).                                                                                                                                                                                                                                                                                                                                |
| AC-8 (live-run awareness)                        | 📋 LIVE (soft, per spec) | Documented soft criterion — run evidence, not CI. Unchanged by this pass.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| AC-9 (no LLM, no persistence, all tests pass)    | ✅ PASS (gap closed)     | Diff inspection: no `ConversationObject` schema change, no `SAVE_FORMAT_VERSION` bump, no `DynamicWorldSnapshot` touch. **E2E added:** zero LLM calls asserted via spies on all four `LLMClient` methods across `talk_to` + bystander perceive + render. Full suite re-run below.                                                                                                                                                                                                                                                                                                                                                                                   |

## Gaps found and closed (this QA pass)

1. **R1 pass-through wiring untested (engine):** the analogous spec-044
   method (`getConversationsAwaitingAgentReply`) is tested at all three
   wiring layers (manager / `SocialManager` / `core.bridges.perception`),
   but the overheard scan had engine-manager coverage only. Added 5 tests
   to `packages/engine/tests/spec-053-overheard-conversations.test.ts`:
   SocialManager delegation, unwired-manager `?? []` legacy fallbacks on
   both hops, provider-level surface, room-wall + participant exclusion
   through the full chain.
2. **No production-assembly E2E:** the cognition suite renders
   fake-provider data only. Added
   `packages/assembly/tests/spec-053-overheard-e2e.test.ts` (6 tests),
   mirroring the spec-043/050 assembly pattern (real `core.bridges.perception`
   - real perceive/build render).
3. **AC-7 per-conversation counts single-conversation only:** added 2
   multi-conversation diagnostic tests to
   `packages/cognition/tests/spec-053-overheard-perception.test.ts`.

Committed as 1a1c7a3 (`test(spec-053): QA coverage pass …`) on
`feature/053-conversation-overhearing`, pushed to the PR branch.

## Gates (re-run on this branch, after the QA additions)

- `pnpm test`: **2,688 passed / 0 failed** (shared 367, visualizer 48,
  memory 101, cognition 1016, engine 855, assembly 72, examples 214,
  cli 15; skips/todos as before). +13 over the PR's own 31-test evidence.
- `pnpm typecheck`: green (all 8 packages, exit 0).
- `pnpm lint`: green (exit 0).
- `pnpm format:check`: green (after prettier on the three touched test files;
  the assembly E2E file needed one reformat pass).

Note: the PR's spec-022 stale default-assertion fix (8269741) verified
implicitly — `spec-022-performance-tuning.test.ts` passes with the cc=3
default on this branch.

## Actions taken

- QA report posted on PR #194 (comment 5652364841).
- Issue #192: added label `Status: In Review/QA` (kept existing
  `Status: Ready for Dev`).
- This notes file (YAAM-indexed per the notes-directory convention).
