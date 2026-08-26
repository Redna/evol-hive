/**
 * Spec 022 coverage tests — Scene Authoring (Declarative)
 * ==========================================================
 * PR #92 is a **spec-only PR** that introduces the specification document
 * `docs/specs/022-scene-authoring-declarative.md` (19 requirements, 19
 * acceptance criteria). No implementation code is included in this PR.
 *
 * This file serves two purposes:
 *
 * 1. **Spec document validation** — Active tests that verify the spec file
 *    exists, is well-formed, has the correct number of requirements and
 *    acceptance criteria, references the correct architecture sections and
 *    issue, and that `docs/specs/INDEX.md` is updated.
 *
 * 2. **AC test scaffolds** — `it.todo()` stubs for each of the 19 acceptance
 *    criteria. These are pending tests that will be activated (converted to
 *    real tests) when the implementation PR lands. They serve as a verifiable
 *    checklist ensuring no AC is forgotten during implementation.
 *
 * 3. **Existing scaffolding verification** — Active tests that confirm the
 *    existing types and functions the spec depends on (SceneDefinition,
 *    SmartObject, Affordance, AgentProfile, loadScene, EngineCore,
 *    AffordanceRegistry, scene-helpers) are present and have the expected
 *    fields. The spec explicitly requires these to remain unchanged.
 *
 * Coverage summary:
 *   - AC-1 through AC-19: all scaffolded as `it.todo`
 *   - Spec document structure: 8 active tests
 *   - INDEX.md update: 3 active tests
 *   - Existing scaffolding verification: 9 active tests
 *   - Backward compatibility verification: 4 active tests
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const REPO_ROOT = resolve(__dirname, '../../..');
const SPEC_PATH = join(REPO_ROOT, 'docs/specs/022-scene-authoring-declarative.md');
const INDEX_PATH = join(REPO_ROOT, 'docs/specs/INDEX.md');

function readFile(path: string): string {
  return readFileSync(path, 'utf-8');
}

function fileExists(path: string): boolean {
  return existsSync(path);
}

// ─── Spec Document Validation ───────────────────────────────────────────────

describe('Spec 022 — Document structure', () => {
  it('spec file exists at docs/specs/022-scene-authoring-declarative.md', () => {
    expect(fileExists(SPEC_PATH)).toBe(true);
  });

  it('spec file has the correct title', () => {
    const content = readFile(SPEC_PATH);
    expect(content).toContain(
      '# Feature: Scene Authoring — Declarative Tools for Defining Rooms, Objects, Agents',
    );
  });

  it('spec file contains 19 requirements', () => {
    const content = readFile(SPEC_PATH);
    const reqSection = content.split('## Requirements')[1]?.split('## Acceptance Criteria')[0];
    expect(reqSection).toBeDefined();
    const reqMatches = reqSection!.match(/\*\*Req \d+/g);
    expect(reqMatches).not.toBeNull();
    expect(reqMatches!.length).toBe(19);
  });

  it('spec file contains exactly 19 acceptance criteria', () => {
    const content = readFile(SPEC_PATH);
    const acMatches = content.match(/- \[ \] \*\*AC-\d+\*\*:/g);
    expect(acMatches).not.toBeNull();
    expect(acMatches!.length).toBe(19);
  });

  it('spec file references the correct architecture sections (§2, §3, §4)', () => {
    const content = readFile(SPEC_PATH);
    expect(content).toContain('§2');
    expect(content).toContain('§3');
    expect(content).toContain('§4');
  });

  it('spec file references the correct issue (#90)', () => {
    const content = readFile(SPEC_PATH);
    expect(content).toContain('#90');
  });

  it('spec file lists the correct packages: shared, engine, and CLI', () => {
    const content = readFile(SPEC_PATH);
    expect(content).toContain('`@evol-hive/shared`');
    expect(content).toContain('`@evol-hive/engine`');
    expect(content).toContain('CLI');
  });

  it('design-decisions.md references ADR-0001 for package boundaries', () => {
    const ddPath = join(REPO_ROOT, '.pi/tasks/feature-022-scene-authoring/design-decisions.md');
    expect(fileExists(ddPath)).toBe(true);
    const content = readFile(ddPath);
    expect(content).toContain('ADR-0001');
  });
});

// ─── INDEX.md Validation ────────────────────────────────────────────────────

describe('Spec 022 — INDEX.md update', () => {
  it('INDEX.md contains spec 022 row', () => {
    const content = readFile(INDEX_PATH);
    expect(content).toContain('022');
    expect(content).toContain('Scene Authoring');
  });

  it('INDEX.md references issue #90 for spec 022', () => {
    const content = readFile(INDEX_PATH);
    expect(content).toContain('#90');
  });

  it('INDEX.md updates spec count summary to at least 23', () => {
    const content = readFile(INDEX_PATH);
    expect(content).toContain('Total specs:');
    expect(content).toMatch(/Total specs:\s+(23|2[4-9]|[3-9][0-9])/);
  });
});

// ─── Existing Scaffolding Verification ──────────────────────────────────────
//
// These tests verify that the existing types and functions the spec references
// as "already existing" are present in the codebase. The spec explicitly
// requires these to remain unchanged (Req 18, Req 19, AC-19).

describe('Spec 022 — Existing scaffolding verification', () => {
  it('SceneDefinition interface exists in packages/shared/src/types/world.ts with required fields', () => {
    const worldTypesPath = join(REPO_ROOT, 'packages/shared/src/types/world.ts');
    expect(fileExists(worldTypesPath)).toBe(true);
    const content = readFile(worldTypesPath);
    expect(content).toContain('export interface SceneDefinition');
    expect(content).toContain('id:');
    expect(content).toContain('name:');
    expect(content).toContain('rooms:');
    expect(content).toContain('objects:');
    expect(content).toContain('agents:');
  });

  it('Room interface exists with id, name, description, connections, objectIds', () => {
    const worldTypesPath = join(REPO_ROOT, 'packages/shared/src/types/world.ts');
    const content = readFile(worldTypesPath);
    expect(content).toContain('export interface Room');
    expect(content).toContain('id:');
    expect(content).toContain('name:');
    expect(content).toContain('description:');
    expect(content).toContain('connections:');
    expect(content).toContain('objectIds:');
  });

  it('SmartObject interface exists in packages/shared/src/types/affordance.ts with required fields', () => {
    const affordanceTypesPath = join(REPO_ROOT, 'packages/shared/src/types/affordance.ts');
    expect(fileExists(affordanceTypesPath)).toBe(true);
    const content = readFile(affordanceTypesPath);
    expect(content).toContain('export interface SmartObject');
    expect(content).toContain('id:');
    expect(content).toContain('name:');
    expect(content).toContain('type:');
    expect(content).toContain('state:');
    expect(content).toContain('affordances:');
    expect(content).toContain('roomId:');
    // Optional fields per spec 018
    expect(content).toContain('stateRules');
    expect(content).toContain('compoundActions');
    expect(content).toContain('dependencies');
  });

  it('Affordance interface exists with id, label, engineEffect, preconditions, effects, conditions, stepGroup, stepOrder', () => {
    const affordanceTypesPath = join(REPO_ROOT, 'packages/shared/src/types/affordance.ts');
    const content = readFile(affordanceTypesPath);
    expect(content).toContain('export interface Affordance');
    expect(content).toContain('engineEffect');
    expect(content).toContain('preconditions');
    expect(content).toContain('effects');
    // Spec 018 additions referenced by Req 6
    expect(content).toContain('conditions');
    expect(content).toContain('stepGroup');
    expect(content).toContain('stepOrder');
  });

  it('AffordanceCondition interface exists with field, operator, value', () => {
    const affordanceTypesPath = join(REPO_ROOT, 'packages/shared/src/types/affordance.ts');
    const content = readFile(affordanceTypesPath);
    expect(content).toContain('export interface AffordanceCondition');
    expect(content).toContain('field:');
    expect(content).toContain('operator:');
    expect(content).toContain('value:');
  });

  it('AgentProfile interface exists in packages/shared/src/types/agent.ts with all spec-referenced fields', () => {
    const agentTypesPath = join(REPO_ROOT, 'packages/shared/src/types/agent.ts');
    expect(fileExists(agentTypesPath)).toBe(true);
    const content = readFile(agentTypesPath);
    expect(content).toContain('export interface AgentProfile');
    expect(content).toContain('id:');
    expect(content).toContain('name:');
    expect(content).toContain('description:');
    expect(content).toContain('traits:');
    expect(content).toContain('initialDrives:');
    expect(content).toContain('backstory');
    expect(content).toContain('longTermGoals');
    expect(content).toContain('behavioralTendencies');
    expect(content).toContain('speechStyle');
    expect(content).toContain('relationships');
    expect(content).toContain('startRoomId');
  });

  it('loadScene function exists in packages/engine/src/assembly.ts with (core, scene) signature', () => {
    const assemblyPath = join(REPO_ROOT, 'packages/engine/src/assembly.ts');
    expect(fileExists(assemblyPath)).toBe(true);
    const content = readFile(assemblyPath);
    expect(content).toContain('export function loadScene(core: EngineCore, scene: SceneDefinition)');
  });

  it('EngineCore interface and createEngineCore function exist in assembly.ts', () => {
    const assemblyPath = join(REPO_ROOT, 'packages/engine/src/assembly.ts');
    const content = readFile(assemblyPath);
    expect(content).toContain('export interface EngineCore');
    expect(content).toContain('export function createEngineCore');
  });

  it('AffordanceRegistry interface exists with registerHandler and getHandler', () => {
    const worldIndexPath = join(REPO_ROOT, 'packages/engine/src/world/index.ts');
    expect(fileExists(worldIndexPath)).toBe(true);
    const content = readFile(worldIndexPath);
    expect(content).toContain('export interface AffordanceRegistry');
    expect(content).toContain('registerHandler');
    expect(content).toContain('getHandler');
  });
});

// ─── Backward Compatibility Verification ────────────────────────────────────
//
// The spec requires (Req 18, AC-18) that existing example scenes remain
// unmodified. These tests verify the example files still exist.

describe('Spec 022 — Backward compatibility (existing example scenes)', () => {
  it('examples/coffee-shop.ts exists and exports COFFEE_SHOP_SCENE', () => {
    const path = join(REPO_ROOT, 'examples/coffee-shop.ts');
    expect(fileExists(path)).toBe(true);
    const content = readFile(path);
    expect(content).toContain('COFFEE_SHOP_SCENE');
  });

  it('examples/minimal-scene.ts exists', () => {
    const path = join(REPO_ROOT, 'examples/minimal-scene.ts');
    expect(fileExists(path)).toBe(true);
  });

  it('examples/morning-routine.ts exists', () => {
    const path = join(REPO_ROOT, 'examples/morning-routine.ts');
    expect(fileExists(path)).toBe(true);
  });

  it('examples/office-day.ts exists', () => {
    const path = join(REPO_ROOT, 'examples/office-day.ts');
    expect(fileExists(path)).toBe(true);
  });

  it('examples/scene-helpers.ts exists and exports registerAffordanceHandlers', () => {
    const path = join(REPO_ROOT, 'examples/scene-helpers.ts');
    expect(fileExists(path)).toBe(true);
    const content = readFile(path);
    expect(content).toContain('export function registerAffordanceHandlers');
  });
});

// ─── Design Decisions & Workspace Files ─────────────────────────────────────

describe('Spec 022 — Task workspace files', () => {
  it('workspace.json exists at .pi/tasks/feature-022-scene-authoring/', () => {
    const path = join(REPO_ROOT, '.pi/tasks/feature-022-scene-authoring/workspace.json');
    expect(fileExists(path)).toBe(true);
    const content = readFile(path);
    expect(content).toContain('feature-022-scene-authoring');
    expect(content).toContain('"specIssue": 90');
    expect(content).toContain('"specFile": "docs/specs/022-scene-authoring-declarative.md"');
  });

  it('design-decisions.md exists at .pi/tasks/feature-022-scene-authoring/', () => {
    const path = join(REPO_ROOT, '.pi/tasks/feature-022-scene-authoring/design-decisions.md');
    expect(fileExists(path)).toBe(true);
    const content = readFile(path);
    expect(content).toContain('Design Decisions');
    // Verify at least some key decisions are documented
    expect(content).toContain('YAML');
    expect(content).toContain('JSON Schema');
    expect(content).toContain('AffordanceHandlerPlugin');
    expect(content).toContain('doorway');
  });
});

// ─── AC Scaffolds (pending until implementation) ────────────────────────────
//
// Each `it.todo` below corresponds to one acceptance criterion from the spec.
// When the implementation PR lands, convert these to real `it()` tests with
// assertions. This ensures every AC is tracked and none are forgotten.

describe('Spec 022 — Acceptance Criteria scaffolds (pending implementation)', () => {
  // ── Scene Definition Format ACs (AC-1 through AC-4) ──────────────────────

  it.todo(
    'AC-1: A JSON Schema file (packages/shared/src/schemas/scene-schema.json) exists and validates the structure of SceneDefinition — rooms, objects, agents, and all sub-fields. (Req 1, Req 5)',
  );

  it.todo(
    'AC-2: A YAML file with rooms containing id, name, description, connections, objectIds passes schema validation. (Req 2)',
  );

  it.todo(
    'AC-3: A YAML file with objects containing id, name, type, state, roomId, affordances (with id, label, engineEffect, preconditions, effects), stateRules, compoundActions, dependencies passes schema validation. (Req 3, Req 6)',
  );

  it.todo(
    'AC-4: A YAML file with agents containing id, name, description, traits, initialDrives, backstory, longTermGoals, behavioralTendencies, speechStyle, relationships, startRoomId passes schema validation. (Req 4)',
  );

  // ── Scene Loader ACs (AC-5 through AC-11) ────────────────────────────────

  it.todo(
    'AC-5: loadSceneFile("path/to/scene.yaml") returns a SceneDefinition object whose rooms, objects, and agents match the YAML content. (Req 7)',
  );

  it.todo(
    'AC-6: loadSceneFile("path/to/scene.json") returns a valid SceneDefinition from a JSON file. (Req 7)',
  );

  it.todo(
    'AC-7: Loading a file with a missing required field (e.g., no name on a room) throws a SceneValidationError containing the file path and a human-readable error message with a JSON Pointer path (e.g., /rooms/0/name). (Req 8)',
  );

  it.todo(
    'AC-8: The SceneDefinition returned by loadSceneFile can be passed directly to loadScene(core, scene) without any adaptation layer or field renaming. (Req 9)',
  );

  it.todo(
    'AC-9: After loading a scene file and calling auto-registration, all affordances listed in the YAML have registered engineEffect handlers in the AffordanceRegistry. Verified by checking affordanceRegistry.getHandler(effectId) !== null for every affordance in the scene. (Req 10)',
  );

  it.todo(
    'AC-10: A custom HandlerPlugin registered for objectType: "custom_device" provides handlers that are auto-registered when the loaded scene contains an object with type: "custom_device". (Req 11)',
  );

  it.todo(
    'AC-11: When a room declares connections: ["living_room"] but no doorway object exists in objectIds, the loader auto-generates a doorway-<roomId> smart object with a go_to_living_room affordance. The generated object appears in the returned SceneDefinition.objects. (Req 12)',
  );

  // ── Scene Editor (CLI) ACs (AC-12 through AC-16) ─────────────────────────

  it.todo(
    'AC-12: Running `npx evol-hive validate-scene examples/coffee-shop.scene.yaml` exits with code 0 and prints a success message. (Req 15, Req 17)',
  );

  it.todo(
    'AC-13: Running `npx evol-hive validate-scene` on a malformed YAML file exits with code 1 and prints validation errors with field paths. (Req 15)',
  );

  it.todo(
    'AC-14: Running `npx evol-hive create-scene` and answering the interactive prompts produces a .scene.yaml file that passes validate-scene. (Req 14)',
  );

  it.todo(
    'AC-15: Running `npx evol-hive run-scene examples/coffee-shop.scene.yaml` builds the engine, starts the game loop, and prints at least one agent state snapshot before exiting. (Req 16)',
  );

  it.todo(
    'AC-16: examples/coffee-shop.scene.yaml exists and is the declarative equivalent of the COFFEE_SHOP_SCENE in examples/coffee-shop.ts — same rooms, objects, and agents. (Req 17)',
  );

  // ── Backward Compatibility ACs (AC-17 through AC-19) ─────────────────────

  it.todo(
    'AC-17: All existing tests pass (pnpm -r run test exits 0) without modifying any existing test file. (Req 18, Req 19)',
  );

  it.todo(
    'AC-18: The existing TypeScript example scenes (coffee-shop.ts, minimal-scene.ts, morning-routine.ts, office-day.ts) remain unmodified and their entry points still run. (Req 18)',
  );

  it.todo(
    'AC-19: The SceneDefinition interface in packages/shared/src/types/world.ts is unchanged — no new required fields added, no existing fields removed. (Req 18)',
  );
});