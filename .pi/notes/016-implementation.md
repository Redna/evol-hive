# Implementation — Spec 016 (Cognitive Guardrails, Issue #54, PR #59)

## Date
2025-01-17

## PR
- **Number:** #59
- **Title:** feat: cognitive guardrails — affordance masking, contextual forcing, plan validation
- **Branch:** `feature/054-cognitive-guardrails`
- **Issue:** #54

## What Was Built

### Shared Layer (`@evol-hive/shared`)
- Added `guardrails: GuardrailConfig` field to `EngineConfig` interface
- Added `defaultGuardrailConfig()` → `{ affordanceMasking: true, contextualForcing: true, planValidation: true }`
- Added `defaultEngineConfig()` → full `EngineConfig` with guardrails + existing defaults (fps=60, etc.)
- Added `PlanValidationResult` interface: `{ valid: boolean; reason?: string }`
- Added `GUARDRAIL_FORCING_DIRECTIVE` and `GUARDRAIL_DEVIATION_FEEDBACK_TEMPLATE` string constants
- Added `deviationRejected?: boolean` to `ExecuteResult`
- Added optional `getAgentState?(agentId: string): AgentInternalState | null` to `PerceptionDataProvider`

### Cognition Layer (`@evol-hive/cognition`)
- Implemented `GuardrailEngineImpl` in `packages/cognition/src/guardrails/index.ts`:
  - `maskAffordances()`: returns `[]` when masking enabled + no plan; unchanged otherwise
  - `validateAction()`: cognitive tools always valid; no plan → valid; disabled → valid; checks current step `targetAffordance` match
- Updated `GuardrailEngine` interface to use `PlanValidationResult` return type
- `PerceptionServiceImpl`: accepts optional `GuardrailEngine`, applies masking after classifier pruning using `getAgentState` to determine `hasPlan`
- `PerceptionBuilderImpl`: accepts optional `{ hasPlan, forcingEnabled, maskingEnabled }`; appends `GUARDRAIL_FORCING_DIRECTIVE` to system prompt; hides `chooseActionTool` and sets `availableAffordances=[]` when masking active; includes ALL cognitive tools (including `formulate_plan`) when masking
- `PlanBuilderImpl`: accepts optional `{ hasPlan, forcingEnabled }`; appends forcing directive to system prompt
- `PlanServiceImpl`: accepts optional `GuardrailEngine`, passes guardrail flags to plan builder
- `ExecuteServiceImpl`: accepts optional `GuardrailEngine`, calls `validateAction()` before resolving affordance; on deviation: sets system feedback, sets thinking=false, returns `{ success: false, deviationRejected: true, error: reason }`
- `PPEROrchestratorImpl`: accepts optional `GuardrailEngine`, wires it to all three phase services; routes `deviationRejected` results to Reflect (not cycle failure)
- Updated `PlanBuilder` and `PerceptionBuilder` interfaces to accept optional guardrail options

### Engine Layer (`@evol-hive/engine`)
- `config/engine.config.ts`: implemented `loadEngineConfig()` reading `ENGINE_GUARDRAILS_ENABLED`, `ENGINE_GUARDRAILS_AFFORDANCE_MASKING`, `ENGINE_GUARDRAILS_CONTEXTUAL_FORCING`, `ENGINE_GUARDRAILS_PLAN_VALIDATION` (all default `true`)
- `PerceptionDataProviderImpl`: implemented `getAgentState()` delegating to `AgentManager.getState()`
- All three examples (`minimal-scene.ts`, `morning-routine.ts`, `office-day.ts`) updated to include `guardrails` in config and wire `GuardrailEngineImpl` to the orchestrator

## Test Coverage
- `packages/shared/tests/guardrails.test.ts` — 12 tests (AC-1 through AC-6, AC-25, ExecuteResult.deviationRejected)
- `packages/cognition/tests/guardrails.test.ts` — 30 tests (AC-7 through AC-22, AC-26)
- `packages/engine/tests/guardrails.test.ts` — 8 tests (AC-23, AC-24, AC-25 engine side, AC-26)
- Updated `packages/cognition/tests/spec-016-coverage.test.ts` — guardrails stub test updated for implementation

All 26 acceptance criteria covered by active tests.

## CI Results
- `pnpm test`: ✅ 821 passed, 1 skipped, 50 todo
- `pnpm typecheck`: ✅ Pass (all 4 packages)
- `pnpm lint`: ✅ Pass
- `pnpm format:check`: ✅ Pass
- `pnpm build`: ✅ Pass (all 4 packages)

## Design Decisions Followed
All 7 design decisions from `.pi/notes/016-design-decisions.md` were followed:
1. Single `GuardrailEngineImpl` class (not three strategy classes)
2. Affordance masking applied AFTER classifier pruning
3. Plan validation checks current step's `targetAffordance`
4. `deviationRejected` boolean field (not error string matching)
5. Contextual forcing in both Plan and Perception builders
6. All guardrail parameters optional for backward compatibility
7. Master toggle + individual flags