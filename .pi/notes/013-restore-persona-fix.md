# YAAM Workspace Note — fix/013-restore-persona-fields (PR #52)

## Task
Fix the broken build caused by PR #49 (spec 013, issue #45) accidentally clobbering the
AgentProfile persona fields and formatPersona() function from spec 012 (PR #48, issue #44).

## Root Cause
When PR #49 added `startRoomId` to `AgentProfile` in `packages/shared/src/types/agent.ts`,
it replaced the entire persona block (backstory, longTermGoals, behavioralTendencies,
speechStyle, relationships, PersonaText, formatPersona) with just the startRoomId line,
instead of adding startRoomId alongside the existing fields. This broke the cognition
package build because it imports formatPersona and references behavioralTendencies.

## What was built (PR #52, branch fix/013-restore-persona-fields)

### Shared layer
- Restored persona fields on AgentProfile: `backstory?`, `longTermGoals?`,
  `behavioralTendencies?`, `speechStyle?`, `relationships?` (spec 012, Req 1)
- Restored `PersonaText` type alias and `formatPersona()` function (spec 012, Req 3)
- Kept `startRoomId?` optional field (spec 013, Req 1)

### Single-file change
Only `packages/shared/src/types/agent.ts` was modified (+84 lines, -1 line).

## Test results
- 669 tests pass (94 shared + 17 memory + 288 cognition + 270 engine)
  - Including: 19 shared persona tests, 29 cognition persona tests, 12 engine persona tests
  - Including: 75 richer-scenes tests (spec 013)
- Typecheck: clean. Lint: clean. Format: clean. Build: succeeds.
- Both example scenes (morning-routine.ts, office-day.ts) run without errors.