---
name: evol-hive-slice
description: 'Break a spec or issue into tracer-bullet legs (vertical slices) with blocking edges, and use expand-contract for wide refactors. Use when a spec is ready to implement and needs decomposition, when planning a multi-leg chain, or when asked "how do we build this in legs". Quiz the user on granularity and dependencies before publishing; produces leg packets.'
---

# Slice (evol-hive)

Turns a spec into the legs a chain will run. The unit of slicing is the
**vertical slice**, not the layer.

## Vertical slices

- Each slice is a **narrow but complete** path through every layer (schema →
  logic → tests): vertical, never "all tests first, then all code".
- A completed slice is **demoable/verifiable on its own**.
- Sized to fit **one fresh context window** (one leg).

## Blocking edges

Give each slice the slices that must complete before it can start; "None (can
start immediately)" otherwise. Work the **frontier** — the slices whose blockers
are all done.

## Wide refactors — expand–contract

A mechanical change whose blast radius fans across the whole codebase (rename a
column, retype a shared symbol, an interface like `invalidatePlan`) cannot be a
vertical slice. Sequence it:

1. **Expand** — add the new form beside the old so nothing breaks.
2. **Migrate** — move call sites over in batches sized by blast radius (per
   package / per directory); each batch is its own slice blocked by the expand,
   and CI stays green batch to batch because the old form still exists.
3. **Contract** — delete the old form once no caller remains, blocked by every
   migrate batch.

If even the batches cannot stay green alone, keep the sequence but put them on a
shared integration branch, and promise green only at a final
integrate-and-verify slice.

## Quiz the user (human gate)

Present the breakdown: for each slice, **Title** / **Blocked by** / **What it
delivers**. Ask: granularity right? blocking edges correct (does each slice only
depend on slices that genuinely gate it)? merge or split any? Iterate until
approved. Do not publish an unapproved breakdown.

## Publish (leg packets)

- One issue/leg per slice, **blockers first**, refer by **name** (not bare ids).
- Each leg packet carries: charter (issue # + spec path + branch), scope (which
  requirements, and which are the next leg's), constraints (the invariants —
  enum = legality, byte-identity, no retry), verify (exact commands + pass
  counts), memory (the briefing note id), handoff (what the next leg inherits).
- Prefactor first: "make the change easy, then make the easy change."
