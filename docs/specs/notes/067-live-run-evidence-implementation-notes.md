# 067 — A Live Run Must Leave Evidence — implementation notes (leg 1)

- **Spec:** `docs/specs/067-live-run-evidence.md`
- **Leg 1 of 2:** R1, R3 and the R4 sink guards (AC-1, AC-2, AC-3, AC-4, AC-8, AC-9, AC-10)
- **Leg 2 (not started):** R2 / AC-5..7, AC-11 — the run summary

## Provenance — this leg's implementation was completed by the dispatcher after its subagent died

Leg 1 ran as a tracked subsession, did the **work**, and then stopped mid-command:
its last output was `Now the full matrix. Rebuild then test from root:` — it never ran
the matrix, never wrote these notes, and never committed. It left **11 uncommitted
files** (7 modified, 4 new) on `fix/067-leg1-sample-sink` with no commit.

The dispatcher therefore finished the leg: reviewed the diff for scope and environment
specificity, **established the red-first evidence the leg never reported**, ran the
matrix, wrote this note, and committed. Recorded because "a subagent reported success"
and "a subagent stopped talking" are different states, and only the commit shows which
happened — the branch existed and looked healthy while containing nothing.

## What shipped

**The decision is now a pure function, not an inline ternary** —
`packages/assembly/src/sample-sink.ts`, `resolveSampleSink(config) → {kind:'file',directory}
| {kind:'memory',directory:null}`:

- a **spending** run (`USE_REAL_LLM=true`) always gets a file sink, defaulting to
  `session-logs`, and an unset/**blank/whitespace** directory cannot demote it to memory;
- a **cheap** run keeps the in-memory sink unless a directory is configured explicitly.

That is the whole defect from the spec in one place: `assembly.ts` previously chose
`options.sessionLogDir ? file : memory`, so a spending run with no directory silently
discarded every sample it produced.

- `examples/visualizer-demo.ts` — resolves and passes the System-1 options on the real-LLM
  path (`SYSTEM1_SESSION_LOG_DIR` overrides the `session-logs` default) and **announces the
  destination before `core.gameLoop.start()`**, so the operator sees where evidence lands
  before anything is spent.
- `scripts/live-sim.mts` — configures the sink for the child, prints it in the banner, and
  **refuses to launch a spending run whose evidence directory is blank** (AC-3). The #269
  behaviours are intact: 30-minute budget with explicit `kill -CONT` to continue, refusal to
  run unbounded without `SIM_UNBOUNDED=1`, SIGCONT-then-SIGTERM process-group cleanup.
- `AGENTS.md` / `docs/DELIVERY_PROCEDURE.md` — the stale unconditional claim *"live sims
  write outcome samples to `session-logs/`"* is replaced with which paths write samples and
  how a path opts in. Its being stale is exactly why nobody checked.

## Red-first evidence (established by the dispatcher, not reported by the leg)

The leg never captured red output, so it was reconstructed: the source changes were stashed
(tests kept), giving **pre-change `main` + the new tests**:

| suite | red | green |
| --- | --- | --- |
| `packages/assembly/tests/spec-067-sample-sink.test.ts` | 7 failed \| 1 passed | 8 passed |
| `packages/cli/tests/spec-067-live-sim-evidence.test.ts` | 7 failed \| 2 passed | 9 passed |
| `examples/tests/spec-067-visualizer-evidence.test.ts` | 7 failed | 7 passed |
| | **21 failed \| 3 passed** | **24 passed** |

The failures name the missing capability behaviourally, not as import noise — e.g.
*"defaults a real-LLM run to the session-logs directory"*, *"passes the default session-logs
directory to the child and prints it"*, *"refuses a real-LLM run whose evidence directory is
blank, before launching"*, *"AGENTS.md drops the stale unconditional claim"*, *"prints the
destination before core.gameLoop.start()"*. The assembly suite's red is the capability being
absent (the resolver does not exist on `main`); the other two are integration behaviour.

## Verification (all re-run on the finished branch)

`pnpm build` clean then the full matrix: shared **399**, memory **101**, visualizer **125**,
engine **942**, cognition **1252**, assembly **100** (was 89), examples **260** (was 253),
cli **141** (was 132). `pnpm typecheck` **0 errors**, `pnpm lint` clean, `npx prettier --check`
clean on all six touched files. No LLM and no network in any test; no `dist/` staged.

## Honest limitations

- **Leg 2's work is absent by design** (R2 / AC-5..7, AC-11): no run summary is written yet, so
  a stopped run still cannot be judged without reading its log. The sink now keeps the data;
  the summary is what makes it legible.
- **The sink decision is enforced at assembly and at the launcher, but a future run path could
  still pass `sessionLogDir` explicitly as blank** — the resolver treats blank as "not
  configured" and would give a spending run the default rather than refusing; the *launcher* is
  what refuses. A path that bypasses the launcher inherits the default, not a refusal.
- **`session-logs/` was not pruned or migrated.** There are 107 files from earlier runs; this
  leg adds no retention policy (explicitly out of scope).
- **Provenance caveat, restated**: the implementation is the subagent's; the verification,
  notes and commit are the dispatcher's. Nothing here was merged on the subagent's word alone.

## Handoff — leg 2

R2 / AC-5..7, AC-11: write a **machine-readable run summary** beside the samples on normal stop
**and on Ctrl-C**, containing duration, tick count, plans attempted/succeeded, conversations,
reflections, memory writes, steps executed vs skipped, precondition rejections, model, budget,
sample count and samples path — asserted by **parsing** it, not by grepping prose. The
launcher's signal path already exists (#269), and `scripts/live-sim.mts` now already knows the
evidence directory, which is where the summary belongs.
