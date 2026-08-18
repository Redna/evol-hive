/**
 * Spec 016 coverage tests — Cognitive Guardrails
 * ===============================================
 * PR #57 is a **spec-only PR** that introduces the specification document
 * `docs/specs/016-cognitive-guardrails.md` (16 requirements, 26 acceptance
 * criteria) and `.pi/notes/016-design-decisions.md` (7 design decisions).
 * No implementation code is included in this PR.
 *
 * This file serves two purposes:
 *
 * 1. **Spec document validation** — Active tests that verify the spec file
 *    exists, is well-formed, has the correct number of requirements and
 *    acceptance criteria, and that `docs/specs/INDEX.md` is updated.
 *
 * 2. **AC test scaffolds** — `it.todo()` stubs for each of the 26 acceptance
 *    criteria. These are pending tests that will be activated (converted to
 *    real tests) when the implementation PR lands. They serve as a verifiable
 *    checklist ensuring no AC is forgotten during implementation.
 *
 * Coverage summary:
 *   - AC-1 through AC-26: all scaffolded as `it.todo`
 *   - Spec document structure: 6 active tests
 *   - Design decisions file: 2 active tests
 *   - INDEX.md update: 3 active tests
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const REPO_ROOT = resolve(__dirname, '../../..');
const SPEC_PATH = join(REPO_ROOT, 'docs/specs/016-cognitive-guardrails.md');
const INDEX_PATH = join(REPO_ROOT, 'docs/specs/INDEX.md');
const DESIGN_DECISIONS_PATH = join(REPO_ROOT, '.pi/notes/016-design-decisions.md');

function readFile(path: string): string {
  return readFileSync(path, 'utf-8');
}

function fileExists(path: string): boolean {
  return existsSync(path);
}

// ─── Spec Document Validation ───────────────────────────────────────────────

describe('Spec 016 — Document structure', () => {
  it('spec file exists at docs/specs/016-cognitive-guardrails.md', () => {
    expect(fileExists(SPEC_PATH)).toBe(true);
  });

  it('spec file has the correct title', () => {
    const content = readFile(SPEC_PATH);
    expect(content).toContain('# Feature: Cognitive Guardrails');
    expect(content).toContain('Affordance Masking');
    expect(content).toContain('Contextual Forcing');
    expect(content).toContain('Plan Validation');
  });

  it('spec file contains 16 requirements', () => {
    const content = readFile(SPEC_PATH);
    // Requirements are numbered 1-16 with "### " prefix or numbered list items
    const reqMatches = content.match(/^\d+\.\s\*\*/gm);
    expect(reqMatches).not.toBeNull();
    expect(reqMatches!.length).toBeGreaterThanOrEqual(16);
  });

  it('spec file contains exactly 26 acceptance criteria', () => {
    const content = readFile(SPEC_PATH);
    const acMatches = content.match(/- \[ \] AC-\d+:/g);
    expect(acMatches).not.toBeNull();
    expect(acMatches!.length).toBe(26);
  });

  it('spec file references the correct architecture section (§10)', () => {
    const content = readFile(SPEC_PATH);
    expect(content).toContain('§10');
    expect(content).toContain('10-cognitive-guardrails');
  });

  it('spec file references the correct issue (#54)', () => {
    const content = readFile(SPEC_PATH);
    expect(content).toContain('#54');
  });

  it('spec file lists all three packages: shared, cognition, engine', () => {
    const content = readFile(SPEC_PATH);
    expect(content).toContain('`shared`');
    expect(content).toContain('`cognition`');
    expect(content).toContain('`engine`');
  });
});

// ─── Design Decisions File Validation ───────────────────────────────────────

describe('Spec 016 — Design decisions', () => {
  it('design decisions file exists at .pi/notes/016-design-decisions.md', () => {
    expect(fileExists(DESIGN_DECISIONS_PATH)).toBe(true);
  });

  it('design decisions file contains 7 decisions', () => {
    const content = readFile(DESIGN_DECISIONS_PATH);
    const decisionMatches = content.match(/^## Decision \d+:/gm);
    expect(decisionMatches).not.toBeNull();
    expect(decisionMatches!.length).toBe(7);
  });
});

// ─── INDEX.md Validation ────────────────────────────────────────────────────

describe('Spec 016 — INDEX.md update', () => {
  it('INDEX.md contains spec 016 row', () => {
    const content = readFile(INDEX_PATH);
    expect(content).toContain('016');
    expect(content).toContain('Cognitive Guardrails');
    expect(content).toContain('Affordance Masking');
  });

  it('INDEX.md updates §10 architecture coverage', () => {
    const content = readFile(INDEX_PATH);
    expect(content).toContain('§10');
    expect(content).toContain('016');
  });

  it('INDEX.md updates spec count summary', () => {
    const content = readFile(INDEX_PATH);
    expect(content).toContain('Total specs:');
    expect(content).toMatch(/Total specs:\s+17/);
  });
});

// ─── AC Scaffolds (pending until implementation) ────────────────────────────
//
// Each `it.todo` below corresponds to one acceptance criterion from the spec.
// When the implementation PR lands, convert these to real `it()` tests with
// assertions. This ensures every AC is tracked and none are forgotten.

describe('Spec 016 — Acceptance Criteria scaffolds (pending implementation)', () => {
  // ── Shared Layer ACs ──────────────────────────────────────────────────────

  it.todo(
    'AC-1: defaultGuardrailConfig() returns { affordanceMasking: true, contextualForcing: true, planValidation: true }',
  );

  it.todo(
    'AC-2: defaultEngineConfig() returns an EngineConfig with guardrailsEnabled: true and guardrails: defaultGuardrailConfig()',
  );

  it.todo('AC-3: EngineConfig interface includes a guardrails: GuardrailConfig field');

  it.todo(
    'AC-4: PlanValidationResult type is exported from shared and matches { valid: boolean; reason?: string }',
  );

  it.todo('AC-5: GUARDRAIL_FORCING_DIRECTIVE constant equals the spec string');

  it.todo('AC-6: GUARDRAIL_DEVIATION_FEEDBACK_TEMPLATE constant equals the spec string');

  // ── Cognition Layer — GuardrailEngineImpl Unit ACs ────────────────────────

  it.todo(
    'AC-7: GuardrailEngineImpl.maskAffordances(affordances, false) returns [] when affordanceMasking === true',
  );

  it.todo(
    'AC-8: GuardrailEngineImpl.maskAffordances(affordances, true) returns affordances unchanged regardless of config',
  );

  it.todo(
    'AC-9: GuardrailEngineImpl.maskAffordances(affordances, false) returns affordances unchanged when affordanceMasking === false',
  );

  it.todo(
    'AC-10: GuardrailEngineImpl.validateAction("brew_coffee", planWithCurrentStepTargetBrewCoffee) returns { valid: true }',
  );

  it.todo(
    'AC-11: GuardrailEngineImpl.validateAction("sleep", planWithCurrentStepTargetBrewCoffee) returns { valid: false, reason: "Action \'sleep\' deviates from your plan. Use reflect to reconsider." }',
  );

  it.todo(
    'AC-12: GuardrailEngineImpl.validateAction("formulate_plan", anyPlan) returns { valid: true } — cognitive tools are never rejected',
  );

  it.todo(
    'AC-13: GuardrailEngineImpl.validateAction("brew_coffee", null) returns { valid: true } — no plan means no validation',
  );

  it.todo(
    'AC-14: GuardrailEngineImpl.validateAction("brew_coffee", plan) returns { valid: true } when planValidation === false',
  );

  // ── Cognition Layer — Integration ACs (Perceive / Plan / Execute) ────────

  it.todo(
    'AC-15: When agent has no plan and affordance masking is enabled, PerceptionResult.prunedAffordances is an empty array',
  );

  it.todo(
    'AC-16: When agent has a plan and affordance masking is enabled, PerceptionResult.prunedAffordances is unchanged from classifier output',
  );

  it.todo(
    'AC-17: When agent has no plan and contextual forcing is enabled, Plan phase LLMContextPayload.systemPrompt contains GUARDRAIL_FORCING_DIRECTIVE',
  );

  it.todo(
    'AC-18: When agent has no plan and contextual forcing is enabled, Perception/Action-choice LLMContextPayload.systemPrompt contains GUARDRAIL_FORCING_DIRECTIVE',
  );

  it.todo(
    'AC-19: When agent has no plan and affordance masking is enabled, Perception/Action-choice LLMContextPayload.tools contains only cognitive tool definitions (no chooseActionTool)',
  );

  it.todo(
    'AC-20: When plan validation detects a deviation, ExecuteResult has success: false, deviationRejected: true, and error containing deviation feedback',
  );

  it.todo(
    'AC-21: When Execute phase rejects an action due to plan validation, setSystemFeedback is called with the deviation reason and the affordance is NOT executed',
  );

  it.todo(
    'AC-22: When ExecuteResult.deviationRejected === true, the orchestrator routes to the Reflect phase (does not record a cycle failure or abort)',
  );

  // ── Engine Layer ACs ──────────────────────────────────────────────────────

  it.todo(
    'AC-23: When guardrailsEnabled === false on the engine config, no GuardrailEngine is created and all three guardrails are inactive',
  );

  it.todo(
    'AC-24: Engine config loader reads ENGINE_GUARDRAILS_AFFORDANCE_MASKING, ENGINE_GUARDRAILS_CONTEXTUAL_FORCING, and ENGINE_GUARDRAILS_PLAN_VALIDATION from env vars with default true',
  );

  it.todo(
    'AC-25: PerceptionDataProvider interface includes an optional getAgentState(agentId: string): AgentInternalState | null method',
  );

  it.todo(
    'AC-26: When all three guardrails are disabled via individual flags (all false) but guardrailsEnabled === true, no masking, forcing, or validation occurs',
  );
});

// ─── Existing Scaffolding Verification ──────────────────────────────────────
//
// These tests verify that the existing scaffolding (interface definitions,
// type stubs) mentioned in the spec is already present in the codebase.
// The spec explicitly references these as "already existing" — confirming
// they are in place validates the spec's assumptions.

describe('Spec 016 — Existing scaffolding verification', () => {
  it('GuardrailConfig type already exists in shared/cognition types', () => {
    // The GuardrailConfig interface is defined in packages/shared/src/types/cognition.ts
    // and should be re-exported from the shared package.
    // We verify by reading the source file.
    const cognitionTypesPath = join(REPO_ROOT, 'packages/shared/src/types/cognition.ts');
    expect(fileExists(cognitionTypesPath)).toBe(true);
    const content = readFile(cognitionTypesPath);
    expect(content).toContain('export interface GuardrailConfig');
    expect(content).toContain('affordanceMasking: boolean');
    expect(content).toContain('contextualForcing: boolean');
    expect(content).toContain('planValidation: boolean');
  });

  it('GuardrailEngine interface already exists in cognition', () => {
    const indexPath = join(REPO_ROOT, 'packages/cognition/src/index.ts');
    expect(fileExists(indexPath)).toBe(true);
    const content = readFile(indexPath);
    expect(content).toContain('export interface GuardrailEngine');
    expect(content).toContain('maskAffordances');
    expect(content).toContain('validateAction');
  });

  it('guardrailsEnabled already exists on EngineConfig', () => {
    const engineTypesPath = join(REPO_ROOT, 'packages/shared/src/types/engine.ts');
    expect(fileExists(engineTypesPath)).toBe(true);
    const content = readFile(engineTypesPath);
    expect(content).toContain('guardrailsEnabled: boolean');
  });

  it('guardrails implementation file exists (implemented)', () => {
    const guardrailsPath = join(REPO_ROOT, 'packages/cognition/src/guardrails/index.ts');
    expect(fileExists(guardrailsPath)).toBe(true);
    const content = readFile(guardrailsPath);
    // The implementation now exports GuardrailEngineImpl.
    expect(content).toContain('GuardrailEngineImpl');
    expect(content).toContain('export {}');
  });
});
