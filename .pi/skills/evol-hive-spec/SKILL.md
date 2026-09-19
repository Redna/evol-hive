---
name: evol-hive-spec
description: Draft an evol-hive spec from a foggy issue or conversation, written against the code so it does not drift. Use when an issue needs a spec before implementation, when a design is too big for one session, or when asked to "spec this". Produces docs/specs/NNN-*.md in the Requirements/ACs/Constraints skeleton and agrees the test seams with the user first. Fits the spec-driven workflow and the three human gates in docs/DELIVERY_PROCEDURE.md.
---

# Spec (evol-hive)

The #1 spec failure we measured: drafting from the issue + docs **without reading
the code**, so the spec drifts and needs correction every time. A spec is written
*against the code*. This skill encodes that.

## Process

1. **Name the destination.** One or two lines on what this spec is finding its
   way to (the feature, decision, or change). Fix scope first — it shapes every
   requirement and every AC.
2. **Explore the code.** Read the relevant packages (`shared`/`engine`/
   `cognition`/`memory`), the domain glossary (`CONTEXT.md` if present), and the
   ADRs in the area. This is the anti-drift step; skip it and the spec will drift.
3. **Agree the seams with the user first.** Highest seam possible; the ideal
   number is one. Prefer existing seams to new ones. Confirm with the user before
   writing anything — this is a human gate, not a formality.
4. **Draft in our skeleton** (below). Every AC must be **measurable**: a *live
   AC* (measurable from a 40-minute run, on the **tick axis**) for engine
   behaviour; a *code AC* otherwise. No gratuitous file paths or line numbers
   (they drift) — **but** diagnostic token names (e.g. `[plan-context]`) and env
   names are allowed: they are stable interface. Prototype-derived snippets are
   allowed when they encode a decision better than prose (state machine, reducer,
   schema, type shape); trim to the decision-rich part and note it came from a
   prototype.
5. **Fog of war.** Put questions you cannot yet phrase sharply under *Not yet
   specified* (don't pre-slice them); put work ruled beyond the destination under
   *Out of scope* (it never graduates — it returns only if the destination is
   redrawn).
6. **Publish.** `docs/specs/NNN-*.md` + an `INDEX.md` row. Open the spec PR — and
   write `Refs #NNN`, never `Closes/Fixes` (the spec PR must never close the
   issue; `architect.yml` enforces this too).
7. **Record.** A YAAM note with the destination and the key decisions, so the
   slicing and build legs retrieve the *why*, not a restatement of the spec.

## Skeleton

```markdown
# <NNN>: <name>

## Context
## Requirements
### R1 …
### R2 …
## Acceptance Criteria
- [ ] **AC-1** …   <!-- live AC for engine behaviour; code AC otherwise -->
## Constraints
## Decisions
## Out of scope
## Notes
```

## Domain glossary

When a term is ambiguous, pin it down in the glossary/`CONTEXT.md` **as the
decision lands**. Two sessions using different words for the same concept is how
specs drift and legs misbuild.
