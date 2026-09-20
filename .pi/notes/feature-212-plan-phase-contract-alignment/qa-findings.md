# QA findings — feature-212 plan-phase contract alignment (PR #226)

## Scope

PR #226 implements the **"narrow" option** of issue #212 identified by the
spec-061 R5 probe: stop rendering plan-phase instructions that tell the model
to call a non-`formulate_plan` tool directly, and name a wrong-tool call
honestly (`[plan-invalid] reason=wrong-tool tool=<name>`). No spec file is
added; the reference is spec 061 R5.

## Verdict

QA PASS on coverage and gates: 7/7 audited criteria have tests, all suites
green, typecheck/lint/format clean. Commit `03c29d8`.

## Tests added

- `packages/cognition/tests/spec-212-qa-coverage.test.ts` (15): direct
  plan-renderer assertions; 4-scenario banned-phrase sweep over the whole
  assembled payload; `formulate_plan` legality pin; repair-seam wrong-tool
  naming (AC-5); exact `logPlanWrongTool` format; throwing-writer safety (AC-6).
- `examples/tests/spec-212-plan-phase-contract-alignment-e2e.test.ts` (3):
  production-stack E2E with the real `DYNAMIC_WORLD_SCENE`, real
  `PerceptionServiceImpl`, real `PlanBuilderImpl` — co-located social agent and
  the real hunger chain.
- `docs/specs/notes/212-plan-phase-contract-alignment-qa-notes.md`: full matrix.

## Gap (NOT fixed — reported on the PR)

`packages/cognition/src/pper/plan-builder.ts:139` still renders on the plan
surface whenever agents are present:

> `You can call talk_to, observe_agent, help, or ignore directly to interact with other agents.`

Same defect class the PR removes; the Developer's banned-phrase list misses the
`call … directly` form. Recommendation: rewrite it plan-shaped (match the
`social-directive` wording) and add the phrase to the sweep.

## Scope notes

- The live gate (spec 061 AC-2 / #214 AC-8) is issue-owned and not run here.
- `wrong-tool` is only reachable for cognitive tools when the executor is
  unwired; a wired executor loops (`LLMError`) — cf. issue #225 finding #7.

## QA run numbers

cognition 79 files / 1240 passed; examples 23 / 251; engine 72 / 905;
assembly 11 / 89; shared 34 / 399; memory 13 / 101; visualizer 9 / 48;
cli 4 / 15. `pnpm test` exit 0; typecheck + lint + format:check clean.
