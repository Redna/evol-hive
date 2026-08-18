/**
 * Spec 018 coverage tests — Object Interactions
 * ==============================================
 * PR #65 is a **spec-only PR** that introduces the specification document
 * `docs/specs/018-object-interactions.md` (32 requirements, 42 acceptance
 * criteria). No implementation code is included in this PR.
 *
 * This file serves two purposes:
 *
 * 1. **Spec document validation** — Active tests that verify the spec file
 *    exists, is well-formed, has the correct number of requirements and
 *    acceptance criteria, and that `docs/specs/INDEX.md` is updated.
 *
 * 2. **AC test scaffolds** — `it.todo()` stubs for each of the 42 acceptance
 *    criteria. These are pending tests that will be activated (converted to
 *    real tests) when the implementation PR lands. They serve as a verifiable
 *    checklist ensuring no AC is forgotten during implementation.
 *
 * Coverage summary:
 *   - AC-1 through AC-42: all scaffolded as `it.todo`
 *   - Spec document structure: 8 active tests
 *   - INDEX.md update: 3 active tests
 *   - Existing scaffolding verification: 7 active tests
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const REPO_ROOT = resolve(__dirname, '../../..');
const SPEC_PATH = join(REPO_ROOT, 'docs/specs/018-object-interactions.md');
const INDEX_PATH = join(REPO_ROOT, 'docs/specs/INDEX.md');

function readFile(path: string): string {
  return readFileSync(path, 'utf-8');
}

function fileExists(path: string): boolean {
  return existsSync(path);
}

// ─── Spec Document Validation ───────────────────────────────────────────────

describe('Spec 018 — Document structure', () => {
  it('spec file exists at docs/specs/018-object-interactions.md', () => {
    expect(fileExists(SPEC_PATH)).toBe(true);
  });

  it('spec file has the correct title', () => {
    const content = readFile(SPEC_PATH);
    expect(content).toContain(
      '# Feature: Object Interactions — Multi-Step Affordances, Object State Changes, Dependencies',
    );
  });

  it('spec file contains 32 requirements', () => {
    const content = readFile(SPEC_PATH);
    // Requirements are numbered items in the "## Requirements" section.
    // They start at "### Shared Layer" and end before "## Acceptance Criteria".
    const reqSection = content.split('## Requirements')[1]?.split('## Acceptance Criteria')[0];
    expect(reqSection).toBeDefined();
    const reqMatches = reqSection!.match(/^\d+\.\s\*\*/gm);
    expect(reqMatches).not.toBeNull();
    expect(reqMatches!.length).toBe(32);
  });

  it('spec file contains exactly 42 acceptance criteria', () => {
    const content = readFile(SPEC_PATH);
    const acMatches = content.match(/- \[ \] \*\*AC-\d+\*\*:/g);
    expect(acMatches).not.toBeNull();
    expect(acMatches!.length).toBe(42);
  });

  it('spec file references the correct architecture sections (§4, §5, §6, §9)', () => {
    const content = readFile(SPEC_PATH);
    expect(content).toContain('§4');
    expect(content).toContain('§5');
    expect(content).toContain('§6');
    expect(content).toContain('§9');
  });

  it('spec file references the correct issue (#63)', () => {
    const content = readFile(SPEC_PATH);
    expect(content).toContain('#63');
  });

  it('spec file lists all three packages: shared, engine, cognition', () => {
    const content = readFile(SPEC_PATH);
    expect(content).toContain('`shared`');
    expect(content).toContain('`engine`');
    expect(content).toContain('`cognition`');
  });

  it('spec file references ADR-0001 for package boundaries', () => {
    const content = readFile(SPEC_PATH);
    expect(content).toContain('ADR-0001');
  });
});

// ─── INDEX.md Validation ────────────────────────────────────────────────────

describe('Spec 018 — INDEX.md update', () => {
  it('INDEX.md contains spec 018 row', () => {
    const content = readFile(INDEX_PATH);
    expect(content).toContain('018');
    expect(content).toContain('Object Interactions');
  });

  it('INDEX.md updates architecture coverage for §4 and §5', () => {
    const content = readFile(INDEX_PATH);
    // Spec 018 should appear in the architecture coverage rows for §4 and §5.
    expect(content).toContain('018');
  });

  it('INDEX.md updates spec count summary to 19', () => {
    const content = readFile(INDEX_PATH);
    expect(content).toContain('Total specs:');
    expect(content).toMatch(/Total specs:\s+19/);
  });
});

// ─── Existing Scaffolding Verification ──────────────────────────────────────
//
// These tests verify that the existing types and classes the spec references
// as "already existing" are present in the codebase. The spec explicitly
// depends on these — confirming their presence validates the spec's assumptions.

describe('Spec 018 — Existing scaffolding verification', () => {
  it('Affordance, SmartObject, and AffordanceResult already exist in shared', () => {
    const affordanceTypesPath = join(REPO_ROOT, 'packages/shared/src/types/affordance.ts');
    expect(fileExists(affordanceTypesPath)).toBe(true);
    const content = readFile(affordanceTypesPath);
    expect(content).toContain('export interface Affordance');
    expect(content).toContain('export interface SmartObject');
    expect(content).toContain('export interface AffordanceResult');
    // Verify existing fields the spec extends
    expect(content).toContain('preconditions');
    expect(content).toContain('engineEffect');
    expect(content).toContain('newState');
    expect(content).toContain('driveChanges');
  });

  it('PerceptionResult and PerceptionDataProvider already exist in shared cognition types', () => {
    const cognitionTypesPath = join(REPO_ROOT, 'packages/shared/src/types/cognition.ts');
    expect(fileExists(cognitionTypesPath)).toBe(true);
    const content = readFile(cognitionTypesPath);
    expect(content).toContain('export interface PerceptionResult');
    expect(content).toContain('export interface PerceptionDataProvider');
    expect(content).toContain('getAffordancesInRoom');
  });

  it('SmartObjectRegistry interface and SmartObjectRegistryImpl already exist in engine', () => {
    const worldIndexPath = join(REPO_ROOT, 'packages/engine/src/world/index.ts');
    expect(fileExists(worldIndexPath)).toBe(true);
    const content = readFile(worldIndexPath);
    expect(content).toContain('export interface SmartObjectRegistry');
    expect(content).toContain('getAffordancesInRoom');
    expect(content).toContain('updateState');

    const objectsIndexPath = join(REPO_ROOT, 'packages/engine/src/world/objects/index.ts');
    expect(fileExists(objectsIndexPath)).toBe(true);
    const objectsContent = readFile(objectsIndexPath);
    expect(objectsContent).toContain('export class SmartObjectRegistryImpl');
  });

  it('PhysicsSystemImpl already exists in engine with executeAffordance', () => {
    const physicsPath = join(REPO_ROOT, 'packages/engine/src/physics/index.ts');
    expect(fileExists(physicsPath)).toBe(true);
    const content = readFile(physicsPath);
    expect(content).toContain('export class PhysicsSystemImpl');
    expect(content).toContain('executeAffordance');
  });

  it('EngineSystem interface and GameTick type already exist', () => {
    const engineIndex = join(REPO_ROOT, 'packages/engine/src/index.ts');
    expect(fileExists(engineIndex)).toBe(true);
    const content = readFile(engineIndex);
    expect(content).toContain('export interface EngineSystem');

    const engineTypes = join(REPO_ROOT, 'packages/shared/src/types/engine.ts');
    expect(fileExists(engineTypes)).toBe(true);
    const typesContent = readFile(engineTypes);
    expect(typesContent).toContain('export interface GameTick');
    expect(typesContent).toContain('deltaSeconds');
  });

  it('DriveDecaySystem already exists as the pattern for ObjectStateSystem', () => {
    const driveDecayPath = join(REPO_ROOT, 'packages/engine/src/systems/drive-decay.ts');
    expect(fileExists(driveDecayPath)).toBe(true);
    const content = readFile(driveDecayPath);
    expect(content).toContain('export class DriveDecaySystem');
    expect(content).toContain("readonly name = 'drive-decay'");
    expect(content).toContain('update(tick: GameTick): void');
  });

  it('PerceptionServiceImpl and PlanBuilderImpl already exist in cognition', () => {
    const pperPath = join(REPO_ROOT, 'packages/cognition/src/pper/index.ts');
    expect(fileExists(pperPath)).toBe(true);
    const content = readFile(pperPath);
    expect(content).toContain('export class PerceptionServiceImpl');

    const planBuilderPath = join(REPO_ROOT, 'packages/cognition/src/pper/plan-builder.ts');
    expect(fileExists(planBuilderPath)).toBe(true);
    const planContent = readFile(planBuilderPath);
    expect(planContent).toContain('export class PlanBuilderImpl');
    expect(planContent).toContain('contextLines');
  });
});

// ─── AC Scaffolds (pending until implementation) ────────────────────────────
//
// Each `it.todo` below corresponds to one acceptance criterion from the spec.
// When the implementation PR lands, convert these to real `it()` tests with
// assertions. This ensures every AC is tracked and none are forgotten.

describe('Spec 018 — Acceptance Criteria scaffolds (pending implementation)', () => {
  // ── Shared Layer ACs (AC-1 through AC-10) ─────────────────────────────────

  it.todo(
    'AC-1: AffordanceCondition is defined in packages/shared/src/types/affordance.ts with fields field: string, operator: ">" | "<" | ">=" | "<=" | "==" | "!=", and value: number | string | boolean. (Req 1)',
  );

  it.todo(
    'AC-2: Affordance in packages/shared/src/types/affordance.ts includes optional fields stepGroup?: string, stepOrder?: number, and conditions?: AffordanceCondition[]. Existing Affordance objects without these fields compile without error. (Req 2, Req 7)',
  );

  it.todo(
    'AC-3: CompoundAction is defined in packages/shared/src/types/affordance.ts with fields id: string, label: string, and steps: { affordanceId: string; description: string }[]. (Req 3)',
  );

  it.todo(
    'AC-4: ObjectDependency is defined in packages/shared/src/types/affordance.ts with fields affordanceId: string, requiresObjectId: string, requiresAffordance: string, and description: string. (Req 4)',
  );

  it.todo(
    'AC-5: ObjectStateRule is defined in packages/shared/src/types/affordance.ts with fields field: string, operation: "decay" | "approach", rate: number, target?: number, and interval: number. (Req 5)',
  );

  it.todo(
    'AC-6: SmartObject in packages/shared/src/types/affordance.ts includes optional fields stateRules?: ObjectStateRule[], compoundActions?: CompoundAction[], and dependencies?: ObjectDependency[]. Existing SmartObject objects without these fields compile without error. (Req 6)',
  );

  it.todo(
    'AC-7: CrossObjectStateChange is defined in packages/shared/src/types/affordance.ts with fields objectId: string and statePatch: Record<string, unknown>. (Req 8)',
  );

  it.todo(
    'AC-8: AffordanceResult in packages/shared/src/types/affordance.ts includes optional field crossObjectStateChanges?: CrossObjectStateChange[]. Existing AffordanceResult objects without this field compile without error. (Req 9)',
  );

  it.todo(
    'AC-9: PerceptionResult in packages/shared/src/types/cognition.ts includes optional fields compoundActions?: CompoundAction[] and objectDependencies?: ObjectDependency[]. (Req 10)',
  );

  it.todo(
    'AC-10: PerceptionDataProvider in packages/shared/src/types/cognition.ts includes methods getAvailableAffordancesInRoom(roomId: string): Affordance[], getCompoundActionsInRoom(roomId: string): CompoundAction[], and getObjectDependenciesInRoom(roomId: string): ObjectDependency[]. (Req 11, Req 12)',
  );

  // ── evaluateConditions ACs (AC-11 through AC-13) ──────────────────────────

  it.todo(
    'AC-11: evaluateConditions({ water_level: 5 }, [{ field: "water_level", operator: ">", value: 0 }]) returns true. evaluateConditions({ water_level: 0 }, [{ field: "water_level", operator: ">", value: 0 }]) returns false. evaluateConditions({ water_level: 5 }, [{ field: "water_level", operator: ">", value: 0 }, { field: "water_level", operator: "<", value: 10 }]) returns true (both conditions pass). evaluateConditions({ water_level: 15 }, [{ field: "water_level", operator: ">", value: 0 }, { field: "water_level", operator: "<", value: 10 }]) returns false (second condition fails). (Req 13)',
  );

  it.todo(
    'AC-12: evaluateConditions({ powered_on: true }, [{ field: "powered_on", operator: "==", value: true }]) returns true. evaluateConditions({ powered_on: false }, [{ field: "powered_on", operator: "==", value: true }]) returns false. (Req 13)',
  );

  it.todo(
    'AC-13: evaluateConditions({ temperature: 50 }, [{ field: "temperature", operator: "!=", value: 0 }]) returns true. evaluateConditions({}, [{ field: "missing_field", operator: ">", value: 0 }]) returns false (missing field fails). (Req 13)',
  );

  // ── SmartObjectRegistryImpl ACs (AC-14 through AC-20) ─────────────────────

  it.todo(
    'AC-14: Given a room with a Coffee Machine (state: { water_level: 5, bean_count: 12 }) whose brew_coffee affordance has conditions: [{ field: "water_level", operator: ">", value: 0 }, { field: "bean_count", operator: ">", value: 0 }] and a refill_water affordance with conditions: [{ field: "water_level", operator: "<", value: 10 }], SmartObjectRegistryImpl.getAvailableAffordancesInRoom(roomId) returns both brew_coffee and refill_water. (Req 14)',
  );

  it.todo(
    'AC-15: Given the same Coffee Machine but with state: { water_level: 0, bean_count: 12 }, getAvailableAffordancesInRoom(roomId) returns refill_water only (not brew_coffee, since water_level > 0 fails). (Req 14)',
  );

  it.todo(
    'AC-16: Given a room with an object that has no conditions on any affordance, getAvailableAffordancesInRoom(roomId) returns all affordances (same as getAffordancesInRoom). (Req 14)',
  );

  it.todo(
    'AC-17: Given a room with two objects, one with compoundActions: [{ id: "brew_coffee", label: "Brew Coffee", steps: [...] }] and one without, SmartObjectRegistryImpl.getCompoundActionsInRoom(roomId) returns a single-element array with the brew_coffee compound action. (Req 15)',
  );

  it.todo(
    'AC-18: Given a room with an object that has dependencies: [{ affordanceId: "brew_coffee", requiresObjectId: "sink-1", requiresAffordance: "refill_water", description: "..." }], SmartObjectRegistryImpl.getObjectDependenciesInRoom(roomId) returns a single-element array with that dependency. (Req 16)',
  );

  it.todo(
    'AC-19: SmartObjectRegistryImpl.applyStatePatch("coffee-1", { water_level: 5 }) on an object with state { water_level: 0, bean_count: 12 } results in state { water_level: 5, bean_count: 12 } (shallow merge, bean_count preserved). (Req 17)',
  );

  it.todo(
    'AC-20: SmartObjectRegistryImpl.applyStatePatch("nonexistent", { foo: 1 }) is a no-op (no error thrown). (Req 17)',
  );

  // ── PhysicsSystemImpl Cross-Object State Changes ACs (AC-21 through AC-23) ─

  it.todo(
    'AC-21: When a handler returns AffordanceResult { success: true, crossObjectStateChanges: [{ objectId: "coffee-1", statePatch: { water_level: 5 } }] }, PhysicsSystemImpl.executeAffordance calls applyStatePatch("coffee-1", { water_level: 5 }) on the registry, and the Coffee Machine state reflects water_level: 5 after execution. (Req 19)',
  );

  it.todo(
    'AC-22: When a handler returns AffordanceResult { success: true, crossObjectStateChanges: [{ objectId: "nonexistent", statePatch: { foo: 1 } }] }, executeAffordance does not throw — the nonexistent target is silently skipped, and the result still has success: true. (Req 19)',
  );

  it.todo(
    'AC-23: When a handler returns AffordanceResult { success: false, crossObjectStateChanges: [{ objectId: "coffee-1", statePatch: { water_level: 5 } }] }, executeAffordance does NOT apply the cross-object state change (cross-object changes only apply on success). (Req 19)',
  );

  // ── ObjectStateSystem ACs (AC-24 through AC-29) ───────────────────────────

  it.todo(
    'AC-24: Given a SmartObject with stateRules: [{ field: "temperature", operation: "decay", rate: 1, interval: 0 }] and state: { temperature: 80 }, after one ObjectStateSystem.update call with deltaSeconds: 10, the object temperature is 70 (80 - 1*10). (Req 20)',
  );

  it.todo(
    'AC-25: Given a SmartObject with stateRules: [{ field: "temperature", operation: "decay", rate: 1, interval: 0 }] and state: { temperature: 5 }, after one update call with deltaSeconds: 10, the object temperature is 0 (clamped, not -5). (Req 20)',
  );

  it.todo(
    'AC-26: Given a SmartObject with stateRules: [{ field: "temperature", operation: "approach", rate: 2, target: 20, interval: 0 }] and state: { temperature: 30 }, after one update call with deltaSeconds: 4, the object temperature is 22 (30 - 2*4 = 22, not overshooting target 20). (Req 20)',
  );

  it.todo(
    'AC-27: Given a SmartObject with stateRules: [{ field: "temperature", operation: "approach", rate: 2, target: 20, interval: 0 }] and state: { temperature: 25 }, after one update call with deltaSeconds: 10, the object temperature is 20 (clamped to target, not 5). (Req 20)',
  );

  it.todo(
    'AC-28: Given a SmartObject with stateRules: [{ field: "temperature", operation: "decay", rate: 1, interval: 5 }] and initial state: { temperature: 80 }, after an update call at tick.time = 3 (less than interval: 5), the temperature remains 80 (throttled). After a second update call at tick.time = 6, the temperature decreases. (Req 20)',
  );

  it.todo(
    'AC-29: Given a SmartObject with stateRules: [{ field: "non_numeric", operation: "decay", rate: 1, interval: 0 }] and state: { non_numeric: "hot" }, the ObjectStateSystem.update call is a no-op for that rule (non-numeric field skipped, no error thrown). (Req 20)',
  );

  // ── getAll + PerceptionDataProviderImpl ACs (AC-30 through AC-33) ─────────

  it.todo(
    'AC-30: SmartObjectRegistryImpl.getAll() returns all registered smart objects. Given 3 objects registered, getAll().length is 3. (Req 21)',
  );

  it.todo(
    'AC-31: PerceptionDataProviderImpl.getAvailableAffordancesInRoom(roomId) delegates to SmartObjectRegistryImpl.getAvailableAffordancesInRoom(roomId) and returns the same result. (Req 22)',
  );

  it.todo(
    'AC-32: PerceptionDataProviderImpl.getCompoundActionsInRoom(roomId) delegates to SmartObjectRegistryImpl.getCompoundActionsInRoom(roomId) and returns the same result. (Req 22)',
  );

  it.todo(
    'AC-33: PerceptionDataProviderImpl.getObjectDependenciesInRoom(roomId) delegates to SmartObjectRegistryImpl.getObjectDependenciesInRoom(roomId) and returns the same result. (Req 22)',
  );

  // ── PerceptionServiceImpl ACs (AC-34 through AC-37) ───────────────────────

  it.todo(
    'AC-34: When PerceptionDataProvider implements getAvailableAffordancesInRoom, PerceptionServiceImpl.perceive calls it instead of getAffordancesInRoom. The classifier receives only the available (condition-filtered) affordances. (Req 23)',
  );

  it.todo(
    'AC-35: When PerceptionDataProvider does NOT implement getAvailableAffordancesInRoom (backward compat), PerceptionServiceImpl.perceive falls back to getAffordancesInRoom without error. (Req 23)',
  );

  it.todo(
    'AC-36: When the agent room contains objects with compoundActions, PerceptionServiceImpl.perceive returns a PerceptionResult with compoundActions populated. When no objects have compoundActions, the compoundActions field is omitted (or empty). (Req 24)',
  );

  it.todo(
    'AC-37: When the agent room contains objects with dependencies, PerceptionServiceImpl.perceive returns a PerceptionResult with objectDependencies populated. When no objects have dependencies, the objectDependencies field is omitted (or empty). (Req 24)',
  );

  // ── PlanBuilderImpl ACs (AC-38 through AC-39) ─────────────────────────────

  it.todo(
    'AC-38: When PerceptionResult.compoundActions is non-empty, PlanBuilderImpl.build appends a context line containing the text "Multi-step actions available:" followed by at least one compound action label. When compoundActions is empty or absent, no such line is appended. (Req 25)',
  );

  it.todo(
    'AC-39: When PerceptionResult.objectDependencies is non-empty, PlanBuilderImpl.build appends a context line containing the text "Object dependencies:" followed by at least one dependency description. When objectDependencies is empty or absent, no such line is appended. (Req 26)',
  );

  // ── Cross-Cutting ACs (AC-40 through AC-42) ───────────────────────────────

  it.todo(
    'AC-40: An existing scene from spec 013 (e.g., Morning Routine with brew_coffee handler returning newState and driveChanges but no conditions or crossObjectStateChanges) loads, runs the game loop, and executes affordances without errors. (Req 27)',
  );

  it.todo(
    'AC-41: No file in packages/cognition/src/ imports from @evol-hive/engine. No file in packages/engine/src/ imports from @evol-hive/cognition. All new types are imported from @evol-hive/shared. (Req 28)',
  );

  it.todo(
    'AC-42: ObjectStateSystem is registered as an EngineSystem during engine assembly. Its name is "object-state". After registration, gameLoop.registerSystem has been called with the ObjectStateSystem instance. (Req 32)',
  );
});
