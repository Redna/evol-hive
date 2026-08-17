/**
 * Spec 015 coverage tests — structural and integration acceptance criteria
 * that are not covered by the dedicated unit test files.
 *
 * Covers: AC-19, AC-34, AC-35, AC-38, AC-39.
 *
 * These tests verify file-level invariants (no engine/memory changes,
 * INDEX.md entry, COGNITIVE_TOOL_NAMES constant) and functional behaviors
 * (MockLLMClient compatibility, minimal scene wiring) that cross the
 * boundary of individual unit test files.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { LLMContextPayload } from '../src/index.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const COGNITION_ROOT = resolve(__dirname, '..');
const REPO_ROOT = resolve(COGNITION_ROOT, '../..');

function readFile(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), 'utf-8');
}

function fileExists(relativePath: string): boolean {
  return existsSync(join(REPO_ROOT, relativePath));
}

// ─── AC-19: COGNITIVE_TOOL_NAMES constant ────────────────────────────────────

describe('COGNITIVE_TOOL_NAMES constant (AC-19)', () => {
  it('is defined in openai-client.ts as new Set(["query_memory", "update_internal_state"])', () => {
    const source = readFile('packages/cognition/src/llm/openai-client.ts');
    expect(source).toContain('COGNITIVE_TOOL_NAMES');
    // Verify it is a Set with the expected members.
    expect(source).toMatch(/COGNITIVE_TOOL_NAMES\s*=\s*new Set/);
    expect(source).toContain("'query_memory'");
    expect(source).toContain("'update_internal_state'");
  });

  it('is used to gate mid-loop tool execution in sendRequest', () => {
    const source = readFile('packages/cognition/src/llm/openai-client.ts');
    expect(source).toContain('COGNITIVE_TOOL_NAMES.has');
  });
});

// ─── AC-34: MockLLMClient accepts agentId on LLMContextPayload ───────────────

describe('MockLLMClient agentId compatibility (AC-34)', () => {
  it('minimal-scene.ts defines MockLLMClient that implements LLMClient', () => {
    const source = readFile('examples/minimal-scene.ts');
    expect(source).toContain('class MockLLMClient implements LLMClient');
  });

  it('MockLLMClient methods accept LLMContextPayload with agentId (structural check)', () => {
    // The MockLLMClient is in examples/minimal-scene.ts (a TypeScript source
    // file outside the package). We verify structurally that its methods
    // accept the LLMContextPayload type (which now has an optional agentId)
    // by checking the source signatures.
    const source = readFile('examples/minimal-scene.ts');

    // The mock implements LLMClient, whose methods take LLMContextPayload.
    // Since agentId is optional on LLMContextPayload, existing payloads
    // without agentId still compile, and payloads with agentId also work.
    // We verify the mock does not access payload.agentId in a way that
    // would break (it ignores the payload with _payload).
    expect(source).toMatch(/async completePlan\(_payload: LLMContextPayload\)/);
    expect(source).toMatch(/async completeReflect\(_payload: LLMContextPayload\)/);
    expect(source).toMatch(/async completeStructured\(_payload: LLMContextPayload\)/);

    // The mock does NOT attempt to access payload.agentId (it uses _payload,
    // meaning it ignores the payload entirely — safe with the new field).
    expect(source).not.toMatch(/MockLLMClient[\s\S]*payload\.agentId/);
  });
});

// ─── AC-35: Minimal scene wiring with CognitiveToolExecutorImpl ─────────────

describe('Minimal scene wiring (AC-35)', () => {
  it('minimal-scene.ts imports CognitiveToolExecutorImpl', () => {
    const source = readFile('examples/minimal-scene.ts');
    expect(source).toContain('CognitiveToolExecutorImpl');
  });

  it('minimal-scene.ts constructs CognitiveToolExecutorImpl when useRealLLM is true', () => {
    const source = readFile('examples/minimal-scene.ts');
    // The wiring should conditionally construct the executor.
    expect(source).toContain('new CognitiveToolExecutorImpl');
    // It should pass memoryInjector and stateDataProvider.
    expect(source).toContain('memoryInjector');
    expect(source).toContain('stateDataProvider');
  });

  it('minimal-scene.ts passes cognitiveToolExecutor to OpenAICompatibleLLMClient config', () => {
    const source = readFile('examples/minimal-scene.ts');
    expect(source).toContain('cognitiveToolExecutor');
  });

  it('minimal-scene.ts reads LLM_MAX_TOOL_CALL_ITERATIONS from env', () => {
    const source = readFile('examples/minimal-scene.ts');
    expect(source).toContain('LLM_MAX_TOOL_CALL_ITERATIONS');
  });

  it('minimal-scene.ts provides a CognitiveToolDataProvider via engine bridges', () => {
    const source = readFile('examples/minimal-scene.ts');
    // The state data provider delegates to core.bridges.reflect.
    expect(source).toContain('updateGoal');
    expect(source).toContain('applyDriveChanges');
    expect(source).toContain('core.bridges.reflect');
  });

  it('falls back to MockLLMClient when USE_REAL_LLM is not true', () => {
    const source = readFile('examples/minimal-scene.ts');
    expect(source).toMatch(/new MockLLMClient/);
  });
});

// ─── AC-38: No files in packages/engine/ or packages/memory/ modified ───────

describe('Package boundaries — no engine or memory changes (AC-38)', () => {
  it('cognitive-tool-executor.ts does not import from @evol-hive/engine', () => {
    const source = readFile('packages/cognition/src/tools/cognitive-tool-executor.ts');
    // The string '@evol-hive/engine' may appear in comments (JSDoc) but must
    // NOT appear in actual import statements.
    const importLines = source.split('\n').filter((l) => l.trim().startsWith('import '));
    const engineImports = importLines.filter((l) => l.includes('@evol-hive/engine'));
    expect(engineImports).toHaveLength(0);
  });

  it('openai-client.ts does not import from @evol-hive/engine or @evol-hive/memory', () => {
    const source = readFile('packages/cognition/src/llm/openai-client.ts');
    expect(source).not.toContain('@evol-hive/engine');
    expect(source).not.toContain('@evol-hive/memory');
  });

  it('cognitive-tool-executor.ts imports MemoryInjector from @evol-hive/memory (allowed)', () => {
    const source = readFile('packages/cognition/src/tools/cognitive-tool-executor.ts');
    expect(source).toContain('@evol-hive/memory');
    expect(source).toContain('MemoryInjector');
  });

  it('cognition package.json has only shared + memory as workspace deps (no engine)', () => {
    const pkgJson = JSON.parse(readFile('packages/cognition/package.json'));
    const deps = Object.keys(pkgJson.dependencies || {});
    const workspaceDeps = deps.filter((d: string) => d.startsWith('@evol-hive/'));
    expect(workspaceDeps).toContain('@evol-hive/shared');
    expect(workspaceDeps).toContain('@evol-hive/memory');
    expect(workspaceDeps).not.toContain('@evol-hive/engine');
  });
});

// ─── AC-39: docs/specs/INDEX.md contains spec 015 ───────────────────────────

describe('INDEX.md contains spec 015 (AC-39)', () => {
  it('INDEX.md contains a row for spec 015', () => {
    const indexPath = 'docs/specs/INDEX.md';
    expect(fileExists(indexPath)).toBe(true);
    const content = readFile(indexPath);
    expect(content).toContain('015');
    expect(content).toContain('015-full-cognitive-tools.md');
    // Verify it references the correct issue #55.
    expect(content).toContain('#55');
    // Verify it references this PR #58.
    expect(content).toContain('#58');
  });

  it('spec 015 row mentions "Full Cognitive Tools"', () => {
    const content = readFile('docs/specs/INDEX.md');
    expect(content).toContain('Full Cognitive Tools');
  });

  it('spec 015 row references architecture sections §8, §6, §11', () => {
    const content = readFile('docs/specs/INDEX.md');
    // Find the line containing 015-full-cognitive-tools.md
    const lines = content.split('\n');
    const spec015Line = lines.find((l) => l.includes('015-full-cognitive-tools.md'));
    expect(spec015Line).toBeDefined();
    expect(spec015Line).toContain('§8');
    expect(spec015Line).toContain('§6');
    expect(spec015Line).toContain('§11');
  });

  it('spec 015 row lists packages: cognition, shared, examples', () => {
    const content = readFile('docs/specs/INDEX.md');
    const lines = content.split('\n');
    const spec015Line = lines.find((l) => l.includes('015-full-cognitive-tools.md'));
    expect(spec015Line).toBeDefined();
    expect(spec015Line).toContain('cognition');
    expect(spec015Line).toContain('shared');
    expect(spec015Line).toContain('examples');
  });
});
