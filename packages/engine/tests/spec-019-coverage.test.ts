/**
 * Spec 019 coverage tests — Phase 4 Validation Scene (Coffee Shop)
 * =================================================================
 * PR #77 is a **spec-only PR** that introduces the specification document
 * `docs/specs/019-validation-scene-coffee-shop.md` (24 requirements, 25
 * acceptance criteria). No implementation code is included in this PR.
 *
 * This file serves two purposes:
 *
 * 1. **Spec document validation** — Active tests that verify the spec file
 *    exists, is well-formed, has the correct number of requirements and
 *    acceptance criteria, and that `docs/specs/INDEX.md` is updated.
 *
 * 2. **AC test scaffolds** — `it.todo()` stubs for each of the 25 acceptance
 *    criteria. These are pending tests that will be activated (converted to
 *    real tests) when the implementation PR lands. They serve as a verifiable
 *    checklist ensuring no AC is forgotten during implementation.
 *
 * Additionally, this file verifies that all existing subsystems the spec
 * references as "already existing" are present in the codebase. The spec
 * explicitly states "No new types or subsystems — purely integration assembly
 * using existing implementations from specs 005–018", so confirming their
 * presence validates the spec's assumptions.
 *
 * Coverage summary:
 *   - AC-1 through AC-25: all scaffolded as `it.todo`
 *   - Spec document structure: 8 active tests
 *   - INDEX.md update: 2 active tests
 *   - Existing scaffolding verification: 12 active tests
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const REPO_ROOT = resolve(__dirname, '../../..');
const SPEC_PATH = join(REPO_ROOT, 'docs/specs/019-validation-scene-coffee-shop.md');
const INDEX_PATH = join(REPO_ROOT, 'docs/specs/INDEX.md');

function readFile(path: string): string {
  return readFileSync(path, 'utf-8');
}

function fileExists(path: string): boolean {
  return existsSync(path);
}

// ─── Spec Document Validation ───────────────────────────────────────────────

describe('Spec 019 — Document structure', () => {
  it('spec file exists at docs/specs/019-validation-scene-coffee-shop.md', () => {
    expect(fileExists(SPEC_PATH)).toBe(true);
  });

  it('spec file has the correct title', () => {
    const content = readFile(SPEC_PATH);
    expect(content).toContain(
      '# Feature: Phase 4 Validation Scene — "Coffee Shop" Comprehensive Integration Example',
    );
  });

  it('spec file contains 24 requirements in the Requirements section', () => {
    const content = readFile(SPEC_PATH);
    // Requirements are numbered items in the "## Requirements" section.
    // They start at "### Scene Definition" and end before "## Acceptance Criteria".
    const reqSection = content.split('## Requirements')[1]?.split('## Acceptance Criteria')[0];
    expect(reqSection).toBeDefined();
    const reqMatches = reqSection!.match(/^\d+\.\s\*\*/gm);
    expect(reqMatches).not.toBeNull();
    expect(reqMatches!.length).toBe(24);
  });

  it('spec file contains exactly 25 acceptance criteria', () => {
    const content = readFile(SPEC_PATH);
    const acMatches = content.match(/- \[ \] AC-\d+:/g);
    expect(acMatches).not.toBeNull();
    expect(acMatches!.length).toBe(25);
  });

  it('spec file references the correct architecture sections (§1, §2, §4, §6, §8, §11)', () => {
    const content = readFile(SPEC_PATH);
    expect(content).toContain('§1');
    expect(content).toContain('§2');
    expect(content).toContain('§4');
    expect(content).toContain('§6');
    expect(content).toContain('§8');
    expect(content).toContain('§11');
  });

  it('spec file references the correct issue (#74)', () => {
    const content = readFile(SPEC_PATH);
    expect(content).toContain('#74');
  });

  it('spec file references the examples package', () => {
    const content = readFile(SPEC_PATH);
    expect(content).toContain('`examples`');
  });

  it('spec file references ADR-0001 for package boundaries', () => {
    const content = readFile(SPEC_PATH);
    expect(content).toContain('ADR-0001');
  });
});

// ─── INDEX.md Validation ────────────────────────────────────────────────────

describe('Spec 019 — INDEX.md update', () => {
  it('INDEX.md contains spec 019 row with correct title and status', () => {
    const content = readFile(INDEX_PATH);
    expect(content).toContain('019');
    expect(content).toContain('Phase 4 Validation Scene');
    expect(content).toContain('Coffee Shop');
    // Status should be Drafted (📝)
    expect(content).toContain('📝 Drafted');
  });

  it('INDEX.md references issue #74 for spec 019', () => {
    const content = readFile(INDEX_PATH);
    expect(content).toContain('#74');
  });
});

// ─── Existing Scaffolding Verification ──────────────────────────────────────
//
// The spec explicitly states "No new types or subsystems — purely integration
// assembly using existing implementations from specs 005–018". These tests
// verify that all subsystems the spec depends on are already present in the
// codebase. This validates the spec's core assumption.

describe('Spec 019 — Existing scaffolding: shared types', () => {
  it('CompoundAction, ObjectDependency, ObjectStateRule, CrossObjectStateChange, AffordanceCondition already exist in shared', () => {
    const affordanceTypesPath = join(REPO_ROOT, 'packages/shared/src/types/affordance.ts');
    expect(fileExists(affordanceTypesPath)).toBe(true);
    const content = readFile(affordanceTypesPath);
    expect(content).toContain('CompoundAction');
    expect(content).toContain('ObjectDependency');
    expect(content).toContain('ObjectStateRule');
    expect(content).toContain('CrossObjectStateChange');
    expect(content).toContain('AffordanceCondition');
  });

  it('SmartObject includes stateRules, compoundActions, and dependencies fields', () => {
    const affordanceTypesPath = join(REPO_ROOT, 'packages/shared/src/types/affordance.ts');
    const content = readFile(affordanceTypesPath);
    expect(content).toContain('stateRules');
    expect(content).toContain('compoundActions');
    expect(content).toContain('dependencies');
  });

  it('Affordance includes stepGroup, stepOrder, and conditions fields', () => {
    const affordanceTypesPath = join(REPO_ROOT, 'packages/shared/src/types/affordance.ts');
    const content = readFile(affordanceTypesPath);
    expect(content).toContain('stepGroup');
    expect(content).toContain('stepOrder');
    expect(content).toContain('conditions');
  });

  it('AffordanceResult includes crossObjectStateChanges field', () => {
    const affordanceTypesPath = join(REPO_ROOT, 'packages/shared/src/types/affordance.ts');
    const content = readFile(affordanceTypesPath);
    expect(content).toContain('crossObjectStateChanges');
  });
});

describe('Spec 019 — Existing scaffolding: engine subsystems', () => {
  it('createEngineCore, assembleGameLoop, and loadScene already exist in engine assembly', () => {
    const assemblyPath = join(REPO_ROOT, 'packages/engine/src/assembly.ts');
    expect(fileExists(assemblyPath)).toBe(true);
    const content = readFile(assemblyPath);
    expect(content).toContain('export function createEngineCore');
    expect(content).toContain('export function assembleGameLoop');
    expect(content).toContain('export function loadScene');
  });

  it('ObjectStateSystem already exists as an EngineSystem', () => {
    const objectStatePath = join(REPO_ROOT, 'packages/engine/src/systems/object-state.ts');
    expect(fileExists(objectStatePath)).toBe(true);
    const content = readFile(objectStatePath);
    expect(content).toContain('ObjectStateSystem');
    expect(content).toContain('update(tick: GameTick): void');
  });

  it('DriveDecaySystem already exists as an EngineSystem', () => {
    const driveDecayPath = join(REPO_ROOT, 'packages/engine/src/systems/drive-decay.ts');
    expect(fileExists(driveDecayPath)).toBe(true);
    const content = readFile(driveDecayPath);
    expect(content).toContain('DriveDecaySystem');
  });

  it('AutoSaveSystem already exists as an EngineSystem', () => {
    const autoSavePath = join(REPO_ROOT, 'packages/engine/src/systems/auto-save.ts');
    expect(fileExists(autoSavePath)).toBe(true);
    const content = readFile(autoSavePath);
    expect(content).toContain('AutoSaveSystem');
  });

  it('MemoryMaintenanceSystem already exists as an EngineSystem', () => {
    const memMaintPath = join(REPO_ROOT, 'packages/engine/src/systems/memory-maintenance.ts');
    expect(fileExists(memMaintPath)).toBe(true);
    const content = readFile(memMaintPath);
    expect(content).toContain('MemoryMaintenanceSystem');
  });

  it('EnginePersistenceImpl already exists in engine', () => {
    const persistencePath = join(REPO_ROOT, 'packages/engine/src/persistence/engine-persistence.ts');
    expect(fileExists(persistencePath)).toBe(true);
    const content = readFile(persistencePath);
    expect(content).toContain('EnginePersistenceImpl');
  });

  it('SocialManager already exists in engine', () => {
    const socialPath = join(REPO_ROOT, 'packages/engine/src/social/social-manager.ts');
    expect(fileExists(socialPath)).toBe(true);
    const content = readFile(socialPath);
    expect(content).toContain('SocialManager');
  });
});

describe('Spec 019 — Existing scaffolding: cognition subsystems', () => {
  it('OpenAICompatibleLLMClient already exists in cognition', () => {
    const llmPath = join(REPO_ROOT, 'packages/cognition/src/llm/openai-client.ts');
    expect(fileExists(llmPath)).toBe(true);
    const content = readFile(llmPath);
    expect(content).toContain('OpenAICompatibleLLMClient');
  });

  it('CognitiveToolExecutorImpl already exists in cognition', () => {
    const toolsPath = join(REPO_ROOT, 'packages/cognition/src/tools/cognitive-tool-executor.ts');
    expect(fileExists(toolsPath)).toBe(true);
    const content = readFile(toolsPath);
    expect(content).toContain('CognitiveToolExecutorImpl');
  });

  it('GuardrailEngineImpl already exists in cognition', () => {
    const guardrailsPath = join(REPO_ROOT, 'packages/cognition/src/guardrails/index.ts');
    expect(fileExists(guardrailsPath)).toBe(true);
    const content = readFile(guardrailsPath);
    expect(content).toContain('GuardrailEngineImpl');
  });
});

describe('Spec 019 — Existing scaffolding: memory subsystems', () => {
  it('InMemoryVectorStore, MemoryDecayService, and ReflectionLoop already exist in memory', () => {
    const vectorStorePath = join(
      REPO_ROOT,
      'packages/memory/src/store/in-memory-vector-store.ts',
    );
    expect(fileExists(vectorStorePath)).toBe(true);
    const vsContent = readFile(vectorStorePath);
    expect(vsContent).toContain('InMemoryVectorStore');

    const decayPath = join(
      REPO_ROOT,
      'packages/memory/src/retrieval/memory-decay-service.ts',
    );
    expect(fileExists(decayPath)).toBe(true);
    const decayContent = readFile(decayPath);
    expect(decayContent).toContain('MemoryDecayService');

    const reflectionPath = join(
      REPO_ROOT,
      'packages/memory/src/reflection/reflection-loop.ts',
    );
    expect(fileExists(reflectionPath)).toBe(true);
    const reflContent = readFile(reflectionPath);
    expect(reflContent).toContain('ReflectionLoop');
  });
});

describe('Spec 019 — Existing scaffolding: example scenes', () => {
  it('existing scene-helpers.ts, morning-routine.ts, and office-day.ts exist in examples', () => {
    expect(fileExists(join(REPO_ROOT, 'examples/scene-helpers.ts'))).toBe(true);
    expect(fileExists(join(REPO_ROOT, 'examples/morning-routine.ts'))).toBe(true);
    expect(fileExists(join(REPO_ROOT, 'examples/office-day.ts'))).toBe(true);
    expect(fileExists(join(REPO_ROOT, 'examples/minimal-scene.ts'))).toBe(true);
  });

  it('scene-helpers.ts exports registerAffordanceHandlers', () => {
    const helpersPath = join(REPO_ROOT, 'examples/scene-helpers.ts');
    const content = readFile(helpersPath);
    expect(content).toContain('export function registerAffordanceHandlers');
  });
});

// ─── AC Scaffolds (pending until implementation) ────────────────────────────
//
// Each `it.todo` below corresponds to one acceptance criterion from the spec.
// When the implementation PR lands, convert these to real `it()` tests with
// assertions. This ensures every AC is tracked and none are forgotten.

describe('Spec 019 — Acceptance Criteria scaffolds (pending implementation)', () => {
  // ── Scene Definition ACs (AC-1 through AC-4) ─────────────────────────────

  it.todo(
    'AC-1: The scene defines ≥4 rooms (kitchen, living_room, bathroom, garden) forming a connected graph (every room reachable from every other room). Room connections: kitchen ↔ living_room, living_room ↔ bathroom, living_room ↔ garden, kitchen ↔ garden. (Req 1)',
  );

  it.todo(
    'AC-2: The scene defines ≥3 agents (Alice, Bob, Carol) with distinct drive profiles where each agent\'s lowest drive is different (energy=15 for Alice, social=15 for Bob, curiosity=15 for Carol). (Req 2)',
  );

  it.todo(
    'AC-3: The scene defines ≥6 non-doorway smart objects (Coffee Machine, Sink, Bookshelf, Sofa, Toilet, Garden Bench, Flower Bed = 7 objects). (Req 3)',
  );

  it.todo(
    'AC-4: The Coffee Machine declares a CompoundAction with ≥3 steps (add_water → brew_coffee → pour_cup) and the affordances have matching stepGroup/stepOrder fields. (Req 3)',
  );

  // ── Object State & Conditions ACs (AC-5 through AC-8) ────────────────────

  it.todo(
    'AC-5: At least 3 objects declare stateRules (Coffee Machine water_level, Sink water_supply, Flower Bed bloom_count) and the ObjectStateSystem is registered and active. (Req 3, Req 12)',
  );

  it.todo(
    'AC-6: The brew_coffee affordance has structured conditions: [{ field: \'water_level\', operator: \'>\', value: 0 }, { field: \'bean_count\', operator: \'>\', value: 0 }] that are evaluated at perception time (filtered when conditions fail). (Req 3)',
  );

  it.todo(
    'AC-7: The Coffee Machine declares an ObjectDependency linking add_water to the Sink\'s refill_pitcher (requiresObjectId, requiresAffordance, description). (Req 3)',
  );

  it.todo(
    'AC-8: The refill_pitcher handler returns crossObjectStateChanges: [{ objectId: \'coffee-1\', statePatch: { water_level: 5 } }] that update the Coffee Machine\'s water_level. (Req 17)',
  );

  // ── Engine Assembly ACs (AC-9 through AC-16) ─────────────────────────────

  it.todo(
    'AC-9: When USE_REAL_LLM=true, the engine uses OpenAICompatibleLLMClient configured from environment variables (LLM_BASE_URL, LLM_MODEL, LLM_API_KEY, LLM_REASONING_EFFORT, LLM_MAX_TOOL_CALL_ITERATIONS). Falls back to CoffeeShopMockLLMClient when not set. (Req 5)',
  );

  it.todo(
    'AC-10: When USE_REAL_EMBEDDINGS=true, the engine uses OnnxEmbeddingProvider for the memory store and AffordanceClassifierImpl for affordance pruning. Falls back to MockEmbeddingProvider and mock classifier when not set. (Req 6, Req 7)',
  );

  it.todo(
    'AC-11: A SocialManager is constructed wrapping the AgentManagerImpl and passed as socialBridge to the CognitiveToolExecutorImpl. Enables agent-to-agent perception, talk_to, observe_agent, help, and ignore cognitive tools. (Req 8, Req 9)',
  );

  it.todo(
    'AC-12: The CognitiveToolExecutorImpl is wired with stateDataProvider (core.bridges.reflect) and socialBridge (SocialManager) and passed to the LLM client. (Req 9)',
  );

  it.todo(
    'AC-13: GuardrailEngineImpl is constructed with { affordanceMasking: true, contextualForcing: true, planValidation: true } and passed to the PPER orchestrator. (Req 10)',
  );

  it.todo(
    'AC-14: EnginePersistenceImpl is available on core.persistence (requires VectorStore provided to createEngineCore) and AutoSaveSystem is registered with a 30-second interval (default), configurable via USE_AUTOSAVE and SAVE_FILE_PATH. (Req 11)',
  );

  it.todo(
    'AC-15: MemoryDecayService and ReflectionLoop are wired (requires real VectorStore) and MemoryMaintenanceSystem is registered as an engine system. Memory decay config configurable via MEMORY_DECAY_RATE and MEMORY_PRUNE_THRESHOLD. (Req 13)',
  );

  it.todo(
    'AC-16: Drive decay rate is configurable via DRIVE_DECAY_RATE environment variable, passed to createEngineCore via EngineConfig or DriveSystemImpl. (Req 14)',
  );

  // ── Affordance Handlers ACs (AC-17 through AC-19) ────────────────────────

  it.todo(
    'AC-17: All new affordance handlers (add_water, pour_cup, refill_pitcher, relax, sit_outside, observe_flowers) are registered and return deterministic AffordanceResult values with appropriate driveChanges and newState. (Req 16)',
  );

  it.todo(
    'AC-18: New precondition checkers (has_cups checking cup_count > 0, has_water_supply checking water_supply > 0, has_blooms checking bloom_count > 0) are registered. (Req 18)',
  );

  it.todo(
    'AC-19: Movement handler for garden (go_to_garden) is registered alongside existing destinations. (Req 19)',
  );

  // ── Entry Point & Observability ACs (AC-20 through AC-23) ────────────────

  it.todo(
    'AC-20: The entry point runs for SCENE_DURATION_MS (default 300000ms with real LLM, 10000ms with mock LLM) and logs agent state every LOG_INTERVAL_MS (default 10000ms). (Req 20, Req 21)',
  );

  it.todo(
    'AC-21: After simulation, the state is saved to a file and the save summary is logged (agent count, object count, memory node count). (Req 22)',
  );

  it.todo(
    'AC-22: The CoffeeShopMockLLMClient selects drive-appropriate affordances including social-aware navigation (navigating toward living_room for social drive, using talk_to when other agents present, navigating toward bookshelf/flower bed for curiosity drive). (Req 23)',
  );

  it.todo(
    'AC-23: COFFEE_SHOP_SCENE: SceneDefinition and buildCoffeeShopEngine(): AssembledEngine are exported from the module. (Req 24)',
  );

  // ── Integration & E2E ACs (AC-24 through AC-25) ──────────────────────────

  it.todo(
    'AC-24: The scene runs with USE_REAL_LLM=true for ≥5 minutes without crashing and produces observable state changes (agent locations change, drives fluctuate, relationships develop). (Req 20, Req 21)',
  );

  it.todo(
    'AC-25: Save/load round-trip works — after saving, loading the state into a fresh engine restores agent drives, locations, object states, and memory nodes. (Req 22)',
  );
});