# 067 — A Live Run Must Leave Evidence — QA notes (leg 1, PR #271)

- **Spec:** `docs/specs/067-live-run-evidence.md`
- **PR:** #271 `fix(067) leg 1: a spending run cannot choose the memory sink` (`fix/067-leg1-sample-sink`)
- **Scope under review:** leg 1 — R1, R3, and the R4 sink guards (AC-1..4, AC-8..10)
- **Reviewer role:** QA Tester (tests only; no implementation change)
- **Design notes:** **absent** for 067. There is no `docs/specs/notes/067-*-design-notes.md`;
  the leg-1 record is `067-live-run-evidence-implementation-notes.md`. The spec's
  "Design Decisions" section (1–5) is the design input reviewed here.

## Verdict

Leg 1's acceptance criteria are verified. Every in-scope AC has at least one test that
fails behaviourally without the change, and the two end-to-end seams the PR left implicit
(announced directory → a child that actually writes samples; real demo path → parseable
JSONL on disk) are now covered. AC-5..7 remain the deliberate leg-2 gap.

**All tests pass: 3,326 passed / 0 failed across 8 packages.** `typecheck` 0 errors,
`lint` clean, `prettier --check` clean on every touched file.

## Coverage map (spec AC → test)

| AC | Requirement | Covering test(s) | Status |
| --- | --- | --- | --- |
| AC-1 (R1) | visualizer-demo passes a session-log dir on the real path (`session-logs` default, env override) | `examples/tests/spec-067-visualizer-evidence.test.ts` (resolver seam, source wiring); `examples/tests/real-llm-visualizer.test.ts` → "spec 067 … writes parseable evidence" (behavioural: real demo run writes to the configured dir) | ✅ |
| AC-2 (R1) | real-LLM start prints destination + model before the first cycle | `examples/…/spec-067-visualizer-evidence.test.ts` (source order); `real-llm-visualizer.test.ts` (captured `console.log` names dir + model on the live path); `packages/cli/tests/spec-067-live-sim-evidence.test.ts` (banner line, R3) | ✅ |
| AC-3 (R1) | launcher refuses a real-LLM run with no sink unless acknowledged; refusal names the reason | `packages/cli/tests/spec-067-live-sim-evidence.test.ts`: blank dir, **whitespace dir (added)**, `SIM_NO_EVIDENCE=1` ack, cheap-run pass-through; `packages/cli/tests/spec-067-evidence-e2e.test.ts` (**added**: no child starts on blank) | ✅ |
| AC-4 (R1) | `USE_REAL_LLM=false` keeps the in-memory sink, writes nothing | `packages/assembly/tests/spec-067-sample-sink.test.ts` (resolver + behavioural no-file); `spec-067-visualizer-evidence.test.ts` (`system1OptionsForRun(false)` → undefined, even with a dir) | ✅ |
| AC-5 (R2) | normal-stop run summary next to samples, parsed | **none — leg 2** | ⛔ leg 2 |
| AC-6 (R2) | summary still written on Ctrl-C | **none — leg 2** | ⛔ leg 2 |
| AC-7 (R2) | summary has every required field non-null for a stub run | **none — leg 2** | ⛔ leg 2 |
| AC-8 (R3) | docs state the rule and opting-in paths; stale unconditional claim gone | `packages/cli/tests/spec-067-live-sim-evidence.test.ts` (docs-guard over `AGENTS.md` + `docs/DELIVERY_PROCEDURE.md`) | ✅ |
| AC-9 (R4) | a test fails if a live-LLM path starts without a sink | `spec-067-sample-sink.test.ts` (spending run defaults to a file sink); `spec-067-evidence-e2e.test.ts` (**added**: launcher → child → JSONL on disk) | ✅ |
| AC-10 (R4) | a test fails if `USE_REAL_LLM=true` can select memory | `spec-067-sample-sink.test.ts` invariant over `undefined`/`''`/`'   '`/a path → always `file` | ✅ |
| AC-11 (R4) | stub-run samples parse as JSONL with the existing schema | `spec-067-evidence-e2e.test.ts` (**added**: parses a real child sample); `real-llm-visualizer.test.ts` (**added**: parses a real demo sample against the full schema field set) | ✅ |
| AC-12 | suite green, typecheck clean, prettier clean | this report | ✅ |

## Tests added (QA)

1. **`packages/cli/tests/spec-067-evidence-e2e.test.ts`** (new, integration/E2E across
   `scripts` ↔ `assembly`): spawns `scripts/live-sim.mts` with a stub child that honours
   `SYSTEM1_SESSION_LOG_DIR`, assembles a spending world, and records one sample. Asserts
   the announced directory is the directory the child used, the sample file exists, and the
   line parses with the existing schema (AC-9, AC-11). A second case asserts a blank
   (whitespace) evidence dir refuses before any child runs (AC-3).
2. **`examples/tests/real-llm-visualizer.test.ts`** — new `spec 067` describe: runs the
   real visualizer path against the existing scripted LLM server, captures the startup
   banner (model + destination) and then drives the scheduler until settled cycles write
   per-agent JSONL, which is parsed and checked against the sample schema (AC-1, AC-2,
   AC-11). Test-only hygiene: both live-cycle tests now stop the loop and settle in-flight
   appends before the temp sink dir is removed, so no swallowed late-write ENOENT leaks
   across tests under parallel load.
3. **`packages/assembly/tests/spec-067-sample-sink.test.ts`** — added the cheap-run
   blank/whitespace edge: `''`, `'   '`, `'\t'` are "not configured", so a cheap run stays
   in memory (AC-4/AC-9 contract).
4. **`packages/cli/tests/spec-067-live-sim-evidence.test.ts`** — added the one-line banner
   assertion (`model`, `budget`, `evidence` together, R3/AC-2) and the whitespace-only
   evidence-dir refusal (AC-3).

No implementation file was modified.

## Results

| package | tests |
| --- | --- |
| shared | 399 passed |
| memory | 101 passed |
| visualizer | 125 passed |
| engine | 942 passed |
| cognition | 1252 passed |
| assembly | 101 passed (was 100; +1 QA) |
| examples | 261 passed (was 260; +1 QA) |
| cli | 145 passed (was 141; +4 QA: 1 banner, 1 whitespace, 2 E2E) |
| **total** | **3326 passed, 0 failed** |

`pnpm test` exit 0; `pnpm typecheck` exit 0; `pnpm lint` exit 0; `prettier --check` clean on
all five spec-067 files. No LLM or network in any added test.

## Red-first

The added tests are behavioural, not tautological. On pre-change `main`:
`resolveSampleSink`/`DEFAULT_SESSION_LOG_DIR` do not exist (assembly import error → red);
the launcher banner has no `evidence=` token and does not read `SYSTEM1_SESSION_LOG_DIR`
(banner + E2E red); the demo passes no `system1` option, so the real path writes no JSONL
(examples E2E red).

## Gaps (cannot be tested in this PR)

- **AC-5, AC-6, AC-7 (R2 — the run summary)** are unimplemented by design in leg 1. There is
  no summary artifact to parse and no summary-on-signal path, so no test can be written
  without implementing leg 2. The leg-2 handoff in the implementation notes owns these.
- **AC-11's leg assignment is inconsistent in the notes.** The implementation notes list
  AC-11 under leg 2, but the spec places it under R4 (samples parse as JSONL), not R2
  (summary). It is testable now and is covered above; leg 2 should not re-do it.

## Observations / limitations (not blocking)

- **`resolveSampleSink` does not trim `defaultDir`.** `resolveSampleSink({ useRealLlm: true,
  defaultDir: '' })` returns `{ kind: 'file', directory: '' }` (the `defaultDir` is used
  verbatim, unlike `sessionLogDir`). No current caller passes `defaultDir` — `assembleSystem1`
  and `system1OptionsForRun` rely on the built-in default — so it is latent, not reachable.
  Worth a one-line `?.trim()` when the argument gains a caller; not tested so as not to
  enshrine the empty-string behaviour.
- **Launcher bypass inherits the default rather than a refusal** (already recorded by the
  implementation notes): the demo does the right thing by default; only `live-sim.mts`
  refuses. A future run path that skips the launcher is not guarded — deliberate.
- **Provenance** of the leg-1 implementation is documented in the implementation notes; this
  QA verification was done against the committed branch, not the subagent's word.

## Evidence

- Full matrix: `/tmp/test-final.log` equivalents — see Results above.
- QA notes committed with the tests on `fix/067-leg1-sample-sink`.

Per ADR-003, spec evidence lives in `docs/specs/notes/067-*-notes.md`.
