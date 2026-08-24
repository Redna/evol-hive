/**
 * Spec 019 coverage tests — Wire SocialManager in Assembly & Example Scenes
 * ==========================================================================
 * PR #78 is a **spec-only PR** that introduces the specification document
 * `docs/specs/019-wire-social-manager.md` (23 requirements, 24 acceptance
 * criteria). No implementation code is included in this PR.
 *
 * This file serves two purposes:
 *
 * 1. **Spec document validation** — Active tests that verify the spec file
 *    exists, is well-formed, has the correct number of requirements and
 *    acceptance criteria, and that `docs/specs/INDEX.md` is updated.
 *
 * 2. **AC test scaffolds** — `it.todo()` stubs for each of the 24 acceptance
 *    criteria. These are pending tests that will be activated (converted to
 *    real tests) when the implementation PR lands. They serve as a verifiable
 *    checklist ensuring no AC is forgotten during implementation.
 *
 * Coverage summary:
 *   - AC-1 through AC-24: all scaffolded as `it.todo`
 *   - Spec document structure: 8 active tests
 *   - INDEX.md update: 3 active tests
 *   - Existing scaffolding verification: 7 active tests
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const REPO_ROOT = resolve(__dirname, '../../..');
const SPEC_PATH = join(REPO_ROOT, 'docs/specs/019-wire-social-manager.md');
const INDEX_PATH = join(REPO_ROOT, 'docs/specs/INDEX.md');

function readFile(path: string): string {
  return readFileSync(path, 'utf-8');
}

function fileExists(path: string): boolean {
  return existsSync(path);
}

// ─── Spec Document Validation ───────────────────────────────────────────────

describe('Spec 019 — Document structure', () => {
  it('spec file exists at docs/specs/019-wire-social-manager.md', () => {
    expect(fileExists(SPEC_PATH)).toBe(true);
  });

  it('spec file has the correct title', () => {
    const content = readFile(SPEC_PATH);
    expect(content).toContain(
      '# Feature: Wire SocialManager in Assembly & Example Scenes',
    );
  });

  it('spec file contains 23 requirements', () => {
    const content = readFile(SPEC_PATH);
    // Requirements are numbered items in the "## Requirements" section.
    const reqSection = content.split('## Requirements')[1]?.split('## Acceptance Criteria')[0];
    expect(reqSection).toBeDefined();
    const reqMatches = reqSection!.match(/^\d+\.\s\*\*/gm);
    expect(reqMatches).not.toBeNull();
    expect(reqMatches!.length).toBe(23);
  });

  it('spec file contains exactly 24 acceptance criteria', () => {
    const content = readFile(SPEC_PATH);
    const acMatches = content.match(/- \[ \] \*\*AC-\d+\*\*:/g);
    expect(acMatches).not.toBeNull();
    expect(acMatches!.length).toBe(24);
  });

  it('spec file references the correct architecture sections (§3, §6, §8, §9)', () => {
    const content = readFile(SPEC_PATH);
    expect(content).toContain('§3');
    expect(content).toContain('§6');
    expect(content).toContain('§8');
    expect(content).toContain('§9');
  });

  it('spec file references the correct issue (#73)', () => {
    const content = readFile(SPEC_PATH);
    expect(content).toContain('#73');
  });

  it('spec file lists the correct packages: engine, examples', () => {
    const content = readFile(SPEC_PATH);
    expect(content).toContain('`engine`');
    expect(content).toContain('`examples`');
  });

  it('spec file references ADR-0001 for package boundaries', () => {
    const content = readFile(SPEC_PATH);
    expect(content).toContain('ADR-0001');
  });
});

// ─── INDEX.md Validation ────────────────────────────────────────────────────

describe('Spec 019 — INDEX.md update', () => {
  it('INDEX.md contains spec 019 row', () => {
    const content = readFile(INDEX_PATH);
    expect(content).toContain('019');
    expect(content).toContain('Wire SocialManager');
  });

  it('INDEX.md marks spec 019 as 📝 Drafted', () => {
    const content = readFile(INDEX_PATH);
    // Find the line containing "019" and verify it includes "Drafted"
    const lines = content.split('\n');
    const spec019Line = lines.find((l) => l.includes('019') && l.includes('Wire SocialManager'));
    expect(spec019Line).toBeDefined();
    expect(spec019Line).toContain('📝 Drafted');
  });

  it('INDEX.md updates spec count summary to at least 21', () => {
    const content = readFile(INDEX_PATH);
    expect(content).toContain('Total specs:');
    expect(content).toMatch(/Total specs:\s+2[0-9]/);
  });
});

// ─── Existing Scaffolding Verification ──────────────────────────────────────
//
// These tests verify that the existing types and classes the spec references
// as "already existing" (from spec 018) are present in the codebase. The spec
// explicitly depends on these — confirming their presence validates the spec's
// assumptions.

describe('Spec 019 — Existing scaffolding verification', () => {
  it('SocialManager already exists in engine social package', () => {
    const socialManagerPath = join(REPO_ROOT, 'packages/engine/src/social/social-manager.ts');
    expect(fileExists(socialManagerPath)).toBe(true);
    const content = readFile(socialManagerPath);
    expect(content).toContain('export class SocialManager');
    // Must have constructor accepting AgentManager
    expect(content).toContain('constructor');
    // Must implement SocialActionBridge methods
    expect(content).toContain('queueMessage');
    expect(content).toContain('getAgentsInRoom');
    expect(content).toContain('getRelationships');
    expect(content).toContain('updateRelationship');
  });

  it('MessageQueue already exists in engine social package', () => {
    const messageQueuePath = join(REPO_ROOT, 'packages/engine/src/social/message-queue.ts');
    expect(fileExists(messageQueuePath)).toBe(true);
    const content = readFile(messageQueuePath);
    expect(content).toContain('export class MessageQueue');
    expect(content).toContain('enqueue');
    expect(content).toContain('dequeue');
  });

  it('SocialManager and MessageQueue are exported from engine index', () => {
    const engineIndexPath = join(REPO_ROOT, 'packages/engine/src/index.ts');
    expect(fileExists(engineIndexPath)).toBe(true);
    const content = readFile(engineIndexPath);
    expect(content).toContain('social/message-queue');
    expect(content).toContain('social/social-manager');
  });

  it('PerceptionDataProviderImpl already has setSocialManager method', () => {
    const perceptionPath = join(REPO_ROOT, 'packages/engine/src/agents/perception/index.ts');
    expect(fileExists(perceptionPath)).toBe(true);
    const content = readFile(perceptionPath);
    expect(content).toContain('setSocialManager');
    expect(content).toContain('getAgentsInRoom');
    expect(content).toContain('dequeueSocialMessages');
    expect(content).toContain('getRelationships');
  });

  it('CognitiveToolExecutorImpl already has socialBridge option in cognition', () => {
    const executorPath = join(REPO_ROOT, 'packages/cognition/src/tools/cognitive-tool-executor.ts');
    expect(fileExists(executorPath)).toBe(true);
    const content = readFile(executorPath);
    expect(content).toContain('socialBridge');
    expect(content).toContain('SocialActionBridge');
    // Social tool methods: executeTalkTo, executeObserveAgent, executeHelp, executeIgnore
    expect(content).toContain('executeTalkTo');
    expect(content).toContain('executeObserveAgent');
    expect(content).toContain('executeHelp');
    expect(content).toContain('executeIgnore');
  });

  it('OpenAICompatibleLLMClient already exists in cognition', () => {
    // The class is defined in openai-client.ts and re-exported from llm/index.ts
    const clientPath = join(REPO_ROOT, 'packages/cognition/src/llm/openai-client.ts');
    expect(fileExists(clientPath)).toBe(true);
    const content = readFile(clientPath);
    expect(content).toContain('export class OpenAICompatibleLLMClient');
    expect(content).toContain('cognitiveToolExecutor');

    // Verify it is re-exported from the llm barrel
    const llmIndexPath = join(REPO_ROOT, 'packages/cognition/src/llm/index.ts');
    expect(fileExists(llmIndexPath)).toBe(true);
    const indexContent = readFile(llmIndexPath);
    expect(indexContent).toContain('OpenAICompatibleLLMClient');
  });

  it('EngineCore and AssembledEngine interfaces exist in assembly.ts', () => {
    const assemblyPath = join(REPO_ROOT, 'packages/engine/src/assembly.ts');
    expect(fileExists(assemblyPath)).toBe(true);
    const content = readFile(assemblyPath);
    expect(content).toContain('export interface EngineCore');
    expect(content).toContain('export interface AssembledEngine');
    expect(content).toContain('export function createEngineCore');
    expect(content).toContain('export function createEngine');
    expect(content).toContain('export function assembleGameLoop');
    expect(content).toContain('export function loadScene');
  });
});

// ─── AC Scaffolds (pending until implementation) ────────────────────────────
//
// Each `it.todo` below corresponds to one acceptance criterion from the spec.
// When the implementation PR lands, convert these to real `it()` tests with
// assertions. This ensures every AC is tracked and none are forgotten.

describe('Spec 019 — Acceptance Criteria scaffolds (pending implementation)', () => {
  // ── Engine Layer ACs (AC-1 through AC-6) ──────────────────────────────────

  it.todo(
    'AC-1: createEngineCore(config) returns an EngineCore object with a socialManager field that is an instance of SocialManager (not undefined). (Req 1, 3, 4)',
  );

  it.todo(
    'AC-2: After createEngineCore(config), core.bridges.perception.getAgentsInRoom(roomId, agentId) returns non-empty results when other agents are in the same room. Specifically: spawn agents A and B in room "kitchen", then getAgentsInRoom("kitchen", "agent-a") returns a summary containing B\'s agentId. (Req 2)',
  );

  it.todo(
    'AC-3: The EngineCore interface in assembly.ts includes socialManager: SocialManager as a non-optional field. (Req 3)',
  );

  it.todo(
    'AC-4: The AssembledEngine interface in assembly.ts includes socialManager: SocialManager as a non-optional field. (Req 5)',
  );

  it.todo(
    'AC-5: createEngine(config, orchestrator) returns an AssembledEngine with a non-undefined socialManager field. (Req 6)',
  );

  it.todo(
    'AC-6: assembly.ts imports SocialManager from ./social/social-manager.js. (Req 7)',
  );

  // ── Minimal Scene AC (AC-7) ───────────────────────────────────────────────

  it.todo(
    'AC-7: When USE_REAL_LLM=true, examples/minimal-scene.ts constructs CognitiveToolExecutorImpl with socialBridge: core.socialManager (in addition to the existing stateDataProvider). (Req 8)',
  );

  // ── Morning Routine ACs (AC-8 through AC-11) ──────────────────────────────

  it.todo(
    'AC-8: When USE_REAL_LLM=true, examples/morning-routine.ts constructs an OpenAICompatibleLLMClient with a CognitiveToolExecutorImpl wired with socialBridge: core.socialManager and stateDataProvider: core.bridges.reflect. (Req 9, 10)',
  );

  it.todo(
    'AC-9: When USE_REAL_LLM is not set, examples/morning-routine.ts uses the existing MorningRoutineMockLLMClient (no behavior change). (Req 9)',
  );

  it.todo(
    'AC-10: buildMorningRoutineEngine() returns an AssembledEngine with a non-undefined socialManager field. (Req 12)',
  );

  it.todo(
    'AC-11: The MorningRoutineMockLLMClient.selectAffordance() method, when drive === \'social\' and room === \'living_room\', returns \'observe\' instead of \'watch_tv\'. (Req 13)',
  );

  // ── Office Day ACs (AC-12 through AC-14) ──────────────────────────────────

  it.todo(
    'AC-12: When USE_REAL_LLM=true, examples/office-day.ts constructs an OpenAICompatibleLLMClient with a CognitiveToolExecutorImpl wired with socialBridge: core.socialManager and stateDataProvider: core.bridges.reflect. (Req 14, 15)',
  );

  it.todo(
    'AC-13: When USE_REAL_LLM is not set, examples/office-day.ts uses the existing OfficeDayMockLLMClient (no behavior change). (Req 14)',
  );

  it.todo(
    'AC-14: buildOfficeDayEngine() returns an AssembledEngine with a non-undefined socialManager field. (Req 16)',
  );

  // ── Assembly Wiring Tests ACs (AC-15 through AC-18) ───────────────────────

  it.todo(
    'AC-15: A test in packages/engine/tests/assembly.test.ts verifies that createEngineCore(config).socialManager is an instance of SocialManager. (Req 18)',
  );

  it.todo(
    'AC-16: A test verifies that after createEngineCore(config) + spawning two agents in the same room, core.bridges.perception.getAgentsInRoom(roomId, agentA) returns a non-empty array containing agent B\'s summary. (Req 19)',
  );

  it.todo(
    'AC-17: A test verifies that createEngine(config, orchestrator).socialManager is not undefined. (Req 20)',
  );

  it.todo(
    'AC-18: A test verifies that after createEngineCore() + loadScene() with a multi-agent scene, moving two agents to the same room results in getAgentsInRoom() returning the other agent. (Req 21)',
  );

  // ── Documentation AC (AC-19) ──────────────────────────────────────────────

  it.todo(
    'AC-19: docs/specs/INDEX.md includes spec 019 with status 📝 Drafted. (Req 23)',
  );

  // ── Backward Compatibility ACs (AC-20 through AC-21) ──────────────────────

  it.todo(
    'AC-20: Existing tests in packages/engine/tests/assembly.test.ts that do not reference socialManager continue to compile and pass without modification. (Backward compatibility)',
  );

  it.todo(
    'AC-21: Existing tests that call createEngineCore() without accessing socialManager continue to compile and pass. The socialManager field is additive. (Backward compatibility)',
  );

  // ── End-to-End Social Interaction ACs (AC-22 through AC-24) ───────────────
  // These require a running LLM server and are tagged as manual/integration tests.

  it.todo(
    'AC-22: When USE_REAL_LLM=true with the morning-routine scene, the LLM context includes "Agents present: Bob (...)" when Alice and Bob are in the same room, and the tools array includes talk_to, observe_agent, help, and ignore tool definitions. (Req 9, Issue AC-4) [manual/integration]',
  );

  it.todo(
    'AC-23: When USE_REAL_LLM=true with the morning-routine scene, and the LLM calls talk_to with { targetAgentId: "agent-bob", message: "Hi Bob!" }, the message is queued via SocialManager.queueMessage() and appears in Bob\'s next perception socialContext. (Req 9, Issue AC-5) [manual/integration]',
  );

  it.todo(
    'AC-24: After a talk_to interaction between Alice and Bob, AgentInternalState.relationships for Alice includes { "agent-bob": { trust: 52, familiarity: 5, lastInteraction: <timestamp> } } and for Bob includes { "agent-alice": { trust: 52, familiarity: 5, lastInteraction: <timestamp> } }. (Req 9, Issue AC-6) [manual/integration]',
  );
});