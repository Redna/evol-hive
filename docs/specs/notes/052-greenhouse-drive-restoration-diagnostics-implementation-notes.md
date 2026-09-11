# Spec 052 — Greenhouse Drive Restoration Diagnostics: Implementation Notes

> Feature branch: `feature/052-greenhouse-drive-restoration-diagnostics` · PR [#190](https://github.com/Redna/evol-hive/pull/190) · Issue [#183](https://github.com/Redna/evol-hive/issues/183)
> Session breadcrumb — updated as work progresses. Deterministic ACs (1–4, 8) closed in the TDD commits
> (`df5849d` failing tests first → `7f63469` implementation → `02681a1` config pins → `ea563c3` format).
> This session's remaining scope: the live-run ACs **AC-5 / AC-6 / AC-7** (Req 5 protocol).

## Environment note (why this session could run the live validation)

The spec's Req 5 protocol assumes a local Ollama endpoint
(`USE_REAL_LLM=true SCENE_DURATION_MS=1800000 npx tsx examples/dynamic-world-sim.ts`).
This session has no local Ollama, but the harness exposes `OLLAMA_API_KEY` for **Ollama Cloud**
(OpenAI-compatible `https://ollama.com/v1` — verified HTTP 200 on `/v1/models`). The
`OpenAICompatibleLLMClient` (spec 006) already takes `LLM_BASE_URL` + `LLM_API_KEY` (Bearer),
so the run was redirected to cloud with no code changes:

```
USE_REAL_LLM=true \
LLM_BASE_URL=https://ollama.com/v1 LLM_API_KEY=$OLLAMA_API_KEY LLM_MODEL=gemma4:31b \
SCENE_DURATION_MS=1800000 ENGINE_MAX_CONCURRENT_LLM=3 \
npx tsx examples/dynamic-world-sim.ts
```

Embeddings stay the in-repo mock (`USE_REAL_EMBEDDINGS` unset — no ONNX artifact in this
environment); classifier pruning behavior under the mock embedder is deterministic and matches
what the deterministic AC-1 tests pin. `gemma4:31b` is the model the sim header recommends for
this scene; it appears in the cloud catalog and smoke-validated tool-calling cleanly.

## Smoke validation (before the 30-min run)

2-min smoke (`SCENE_DURATION_MS=120000`), 2026-09-11T19:54Z:
- 123 `[drive-hint]` lines, 27 `[state]` samples, ~269K tokens, clean exit, zero transport errors.
- Final sample: **no drive at 0 anywhere** — gardener e=64 h=61 s=67 co=97 cu=97; iris e=51 h=41
  s=54 co=51 cu=46; apprentice e=41 h=36 s=53 co=46 cu=56.
- Greenhouse restorers visible in enum at urgency (`afterPrune=12 afterMask=12`, `prunedAway=[]`).

## 30-min validation run (Req 5 protocol)

- Started 2026-09-11T19:58:08Z, log `/tmp/run052/full.log` (evidence excerpts to be committed).
- Early cycles confirm: apprentice-1 (greenhouse) at hunger=40 sees `rest_among_seedlings`,
  `eat_herbs`, `pick_herbs` in the post-prune enum and chose `eat_herbs` — the R2 exemption is
  live (`prunedAway=[]`); `[drive-hint]`/`[wait-guard]` lines are the AC-6/AC-7 instruments.

## Results

_(to be filled when the run completes — final `logState()` sample, `[drive-hint]` diagnosis table,
`[wait-guard]` rejection counts, AC-5/6/7 verdicts)_

## Breadcrumbs for the next session

- Tests/typecheck/lint/build verified green this session before the run (pnpm -r test: all suites
  pass; `pnpm typecheck`, `pnpm lint`, `pnpm build` clean).
- INDEX.md already marks spec 052 `🔍 In Review` with PRs #189/#190 (commit `04a56e3`).
- PR #190 is OPEN, MERGEABLE, only GitGuardian CI (pass); review approval pending.
- Remaining after the live run: attach evidence to #183, refresh PR body AC-5/6/7 statuses,
  commit these notes.