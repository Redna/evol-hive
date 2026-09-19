---
name: evol-hive-review
description: 'Review a diff since a fixed point along two independent axes — Standards (repo conventions + a smell baseline) and Spec (does it do what the originating issue/spec asked) — and never rerank across them. Use when reviewing a PR, a leg branch, work-in-progress changes, or a spec against the code. Fits the PR merge gate and the spec gate in docs/DELIVERY_PROCEDURE.md.'
---

# Review (evol-hive)

A change can pass one axis and fail the other: code that follows every standard
but implements the wrong thing, or code that does exactly what the issue asked
but breaks the repo's conventions. **Report the two axes separately** — never
merge or rerank their findings.

## Standards axis

Repo conventions **always win** over the baseline below: strict TS + `import
type`, prettier, package direction (`shared ← engine/memory ← cognition`,
assembly is the sole composition root), no `dist/` edits, spec-049 diagnostics.

The **smell baseline** (each is a labelled heuristic, a judgement call, never a
hard violation — and a documented repo standard overrides it; skip anything
tooling already enforces):

- **Mysterious Name** · **Duplicated Code** · **Feature Envy** · **Data Clumps**
- **Primitive Obsession** · **Repeated Switches** · **Shotgun Surgery**
- **Divergent Change** · **Speculative Generality** · **Message Chains**
- **Middle Man** · **Refused Bequest**

## Spec axis

Against the originating spec (quote the line for each finding):

- requirements the spec asked for that are **missing or partial**
- behaviour in the diff that was **not asked for** (scope creep)
- requirements that look implemented but are **wrong**

## Process

1. **Pin the fixed point** (commit/branch/`main`/merge-base). Capture
   `git diff <fixed>...HEAD` (three-dot = against the merge-base) and
   `git log <fixed>..HEAD --oneline`.
2. **Identify the spec** — from commit messages → issue → `docs/specs/NNN`.
3. **Two independent passes** (or two subsessions), each reporting under 400
   words: one Standards, one Spec.
4. **Aggregate** under two headings, verbatim. End with a one-line summary:
   findings per axis, and the worst issue within each axis.

## Reviewing a spec (against the code)

Before approving a spec PR, verify its load-bearing claims in the code: the
module/block it names, the instrument its ACs depend on, the fixtures it pins
(e.g. spec-055's `GOLDEN_CONTEXT_NO_RECORD`), and the invariants it promises
(enum = legality, no retry, byte-identity). **Correct the ACs that don't match
reality** — unachievable ACs, wrong ordering — rather than approving drift.
