---
name: evol-hive-build
description: 'Execute one evol-hive leg test-first (red-green-refactor) at pre-agreed seams, then run the verification matrix before committing. Use when implementing a ticket or leg, building a feature, fixing a bug, or making any code change in the monorepo. Fits the local-legs workflow in docs/DELIVERY_PROCEDURE.md.'
---

# Build a leg (evol-hive)

The doing half of the pipeline: one leg, one bounded job, test-first, verified
before it is committed.

## TDD loop

- **Red before green.** Write the failing test, then only enough code to pass it.
  No speculative features.
- **One slice at a time.** One seam, one test, one minimal implementation per
  cycle.
- **Test at pre-agreed seams only** — the public boundary, never internals.
  Confirm the seam before writing any test. Refactoring belongs to review, not
  the red-green loop.

## Anti-patterns (the tests worth deleting)

- **Implementation-coupled** — mocks internal collaborators or verifies through a
  side channel; the tell is it breaks when you refactor but behaviour is unchanged.
- **Tautological** — the assertion recomputes the expected value the way the code
  does (`expect(add(a, b)).toBe(a + b)`); expected values must come from an
  independent source of truth (a known-good literal, a worked example, the spec).
- **Horizontal slicing** — all tests first, then all implementation; tests the
  imagined shape, not the behaviour.

## evol-hive specifics

- Package direction is strict: `shared ← engine`, `shared ← memory`,
  `shared ← cognition`, `memory ← cognition`; `@evol-hive/assembly` is the sole
  composition root. Never import across a forbidden edge.
- Strict TS: `import type` for type-only imports, semicolons, single quotes,
  2-space indent, trailing commas, 100-col width. Never edit `dist/`.
- Diagnostics are zero-LLM `[tag]` stderr lines (spec-049 discipline) — add one
  rather than trusting prompt greps.

## Verification matrix (all before commit)

- spec-021 / spec-055 **goldens unmodified** (byte-identity is pinned to real fixtures)
- full package suite green (cognition ~1,209; engine 903; assembly 89; examples 248)
- `pnpm typecheck` clean — note it excludes `tests/`; a tests-inclusive run has
  ~703 known errors, do not chase them
- `npx prettier --check` on touched files
- `pnpm build` before any live run (live sims resolve workspace packages to
  `dist/`, not source — a stale dist silently runs old code)

## Leg mechanics

- Branch from current `main`; work in the main checkout. Commit per leg with a
  clear message. Do **not** push, merge, or open PRs from the leg.
- Record the outcome as a YAAM note (awaited; report the tool's message
  verbatim). A briefing is only useful if it carries non-charter context.
