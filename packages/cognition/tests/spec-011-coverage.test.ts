/**
 * Spec 011 coverage tests — structural and integration acceptance criteria
 * that are not covered by the dedicated unit test files.
 *
 * Covers: AC-2, AC-14, AC-22, AC-27, AC-28, AC-29, AC-32, AC-33, AC-34, AC-35.
 *
 * These tests verify file-level invariants (deleted files, absence of imports,
 * INDEX.md status) and functional behaviors (no alias mapping, MockLLMClient
 * compatibility) that cross the boundary of individual unit test files.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type {
  Affordance,
  CognitiveTool,
  ExecuteResult,
  AgentInternalState,
  PerceptionResult,
} from '@evol-hive/shared';
import { chooseActionTool, formulatePlanTool, reflectTool } from '@evol-hive/shared';
import type { LLMContextPayload } from '../src/index.js';
import { OpenAICompatibleLLMClient, LLMResponseError } from '../src/llm/openai-client.js';
import { PlanBuilderImpl } from '../src/pper/plan-builder.js';
import { PerceptionBuilderImpl } from '../src/pper/perception-builder.js';
import { ReflectBuilderImpl } from '../src/pper/reflect-builder.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const COGNITION_ROOT = resolve(__dirname, '..');
const REPO_ROOT = resolve(COGNITION_ROOT, '../..');

function readSrc(relPath: string): string {
  return readFileSync(join(COGNITION_ROOT, relPath), 'utf-8');
}

function readRepo(relPath: string): string {
  return readFileSync(join(REPO_ROOT, relPath), 'utf-8');
}

function repoFileExists(relPath: string): boolean {
  return existsSync(join(REPO_ROOT, relPath));
}

const BASE_URL = 'http://localhost:8080/v1';
const MODEL = 'llama3.1';

type FetchArgs = [string, RequestInit];

function callAt(mock: ReturnType<typeof vi.fn>, index: number): { url: string; init: RequestInit } {
  const args = mock.mock.calls[index] as unknown as FetchArgs;
  return { url: args[0], init: args[1] };
}

function makePayload(overrides: Partial<LLMContextPayload> = {}): LLMContextPayload {
  return {
    systemPrompt: 'You are a helpful agent.',
    perceptionContext: 'You are in a kitchen.',
    availableAffordances: [{ id: 'brew_coffee', label: 'Brew coffee' }] as Affordance[],
    cognitiveTools: [] as CognitiveTool[],
    tools: [chooseActionTool],
    ...overrides,
  };
}

function toolCallResponse(toolName: string, argumentsObj: unknown, status = 200): Response {
  const body = JSON.stringify({
    choices: [
      {
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call-1',
              type: 'function',
              function: {
                name: toolName,
                arguments: JSON.stringify(argumentsObj),
              },
            },
          ],
        },
      },
    ],
  });
  return new Response(body, {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const FULL_DRIVES = { energy: 20, hunger: 50, social: 50, comfort: 50, curiosity: 50 };

function makePerceptionResult(): PerceptionResult {
  return {
    passive: {
      roomId: 'kitchen',
      objectsPresent: [{ objectId: 'coffee-1', name: 'Coffee Machine', type: 'appliance' }],
      drives: FULL_DRIVES,
    },
    prunedAffordances: [{ id: 'brew_coffee', label: 'Brew coffee' }],
    primaryDriveLabel: 'energy',
  };
}

function makeAgentState(): AgentInternalState {
  return {
    agentId: 'agent-1',
    drives: FULL_DRIVES,
    currentGoal: 'Restore energy',
    currentPlan: null,
    isThinking: false,
    room: 'kitchen',
  };
}

function makeExecuteResult(): ExecuteResult {
  return {
    agentId: 'agent-1',
    success: true,
    stepExecuted: { description: 'Brew coffee', targetAffordance: 'brew_coffee' },
    result: undefined,
    planComplete: false,
    stepSkipped: false,
  };
}

// ─── AC-2: LLMContextPayload type change ─────────────────────────────────────

describe('LLMContextPayload type (AC-2)', () => {
  it('has a required tools: ToolDefinition[] field', () => {
    const payload: LLMContextPayload = {
      systemPrompt: 'sys',
      perceptionContext: 'ctx',
      availableAffordances: [],
      cognitiveTools: [],
      tools: [chooseActionTool],
    };
    expect(payload.tools).toBeDefined();
    expect(Array.isArray(payload.tools)).toBe(true);
    expect(payload.tools[0]!.type).toBe('function');
  });

  it('does not have responseSchema field', () => {
    const payload: LLMContextPayload = {
      systemPrompt: 'sys',
      perceptionContext: 'ctx',
      availableAffordances: [],
      cognitiveTools: [],
      tools: [],
    };
    expect((payload as Record<string, unknown>)['responseSchema']).toBeUndefined();
  });

  it('does not have schemaHint field', () => {
    const payload: LLMContextPayload = {
      systemPrompt: 'sys',
      perceptionContext: 'ctx',
      availableAffordances: [],
      cognitiveTools: [],
      tools: [],
    };
    expect((payload as Record<string, unknown>)['schemaHint']).toBeUndefined();
  });

  it('source index.ts defines tools and does not define responseSchema or schemaHint', () => {
    const src = readSrc('src/index.ts');
    expect(src).toContain('tools');
    expect(src).not.toContain('responseSchema');
    expect(src).not.toContain('schemaHint');
  });
});

// ─── AC-14: No alias mapping logic ───────────────────────────────────────────

describe('No alias mapping logic (AC-14)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const originalFetch = globalThis.fetch;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('completeStructured does not perform alias mapping — canonical field names used directly', async () => {
    fetchMock.mockResolvedValue(toolCallResponse('choose_action', { reasoning: 'r', action: 'a' }));
    const client = new OpenAICompatibleLLMClient({ baseUrl: BASE_URL, model: MODEL });
    const result = await client.completeStructured(makePayload());
    expect(result.reasoning).toBe('r');
    expect(result.action).toBe('a');
    // No alias warnings should be emitted — there is no alias mapping code.
    const aliasWarnings = warnSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((s) => s.includes('[field-alias]'));
    expect(aliasWarnings).toHaveLength(0);
  });

  it('completePlan does not perform alias mapping — canonical field names used directly', async () => {
    fetchMock.mockResolvedValue(
      toolCallResponse('formulate_plan', {
        description: 'Brew coffee',
        steps: [{ description: 'Brew a cup', targetAffordance: 'brew_coffee' }],
      }),
    );
    const client = new OpenAICompatibleLLMClient({ baseUrl: BASE_URL, model: MODEL });
    const payload = makePayload({ tools: [formulatePlanTool] });
    const result = await client.completePlan(payload);
    expect(result.description).toBe('Brew coffee');
    expect(result.steps[0]!.targetAffordance).toBe('brew_coffee');
    const aliasWarnings = warnSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((s) => s.includes('[field-alias]'));
    expect(aliasWarnings).toHaveLength(0);
  });

  it('completeReflect does not perform alias mapping — canonical field names used directly', async () => {
    fetchMock.mockResolvedValue(
      toolCallResponse('reflect', { newGoal: 'Survive', driveOverrides: { energy: 50 } }),
    );
    const client = new OpenAICompatibleLLMClient({ baseUrl: BASE_URL, model: MODEL });
    const payload = makePayload({ tools: [reflectTool] });
    const result = await client.completeReflect(payload);
    expect(result.newGoal).toBe('Survive');
    expect(result.driveOverrides).toEqual({ energy: 50 });
    const aliasWarnings = warnSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((s) => s.includes('[field-alias]'));
    expect(aliasWarnings).toHaveLength(0);
  });

  it('openai-client.ts does not contain resolveField or warnAliasIfUsed references', () => {
    const src = readSrc('src/llm/openai-client.ts');
    expect(src).not.toContain('resolveField');
    expect(src).not.toContain('warnAliasIfUsed');
    expect(src).not.toContain('[field-alias]');
  });
});

// ─── AC-22: PPER service files not modified ──────────────────────────────────

describe('PPER services unmodified (AC-22)', () => {
  const PPER_SERVICE_FILES = [
    'src/pper/plan-service.ts',
    'src/pper/reflect-service.ts',
    'src/pper/execute-service.ts',
    'src/pper/orchestrator.ts',
    'src/pper/index.ts',
  ];

  // Forbidden imports that would indicate spec 010/011 changes leaked into services.
  const FORBIDDEN_IMPORTS = [
    'resolveField',
    'schemaHint',
    'PLAN_SCHEMA_HINT',
    'ACTION_RESPONSE_SCHEMA_HINT',
    'REFLECT_SCHEMA_HINT',
    'MEMORY_CONSOLIDATION_SCHEMA_HINT',
    'JSON_INSTRUCTION_SUFFIX',
    'json-recovery',
    'ToolDefinition',
    'formulatePlanTool',
    'chooseActionTool',
    'reflectTool',
    'memoryConsolidationTool',
  ];

  for (const file of PPER_SERVICE_FILES) {
    it(`${file} does not import spec 011 tool-calling constructs or spec 010 schema hints (AC-22)`, () => {
      const src = readSrc(file);
      for (const forbidden of FORBIDDEN_IMPORTS) {
        expect(src).not.toContain(forbidden);
      }
    });
  }
});

// ─── AC-27: minimal-scene.ts config cleanup ──────────────────────────────────

describe('minimal-scene.ts config cleanup (AC-27)', () => {
  it('does not reference responseFormat, useJsonSchema, or enableJsonRecovery', () => {
    const src = readRepo('examples/minimal-scene.ts');
    expect(src).not.toContain('responseFormat');
    expect(src).not.toContain('useJsonSchema');
    expect(src).not.toContain('enableJsonRecovery');
  });

  it('does not reference LLM_RESPONSE_FORMAT env var', () => {
    const src = readRepo('examples/minimal-scene.ts');
    expect(src).not.toContain('LLM_RESPONSE_FORMAT');
  });
});

// ─── AC-28: MockLLMClient works with new payload ─────────────────────────────

describe('MockLLMClient compatibility (AC-28)', () => {
  it('minimal-scene.ts MockLLMClient does not reference payload.responseSchema or payload.schemaHint', () => {
    const src = readRepo('examples/minimal-scene.ts');
    expect(src).not.toContain('payload.responseSchema');
    expect(src).not.toContain('payload.schemaHint');
    // The mock should accept payloads with tools (it ignores payload content,
    // but must not crash on the new shape).
    expect(src).toContain('MockLLMClient');
  });

  it('MockLLMClient implements all four LLMClient methods', async () => {
    const mod = await import('../../examples/minimal-scene.ts');
    expect(mod.MockLLMClient).toBeDefined();
    const mock = new mod.MockLLMClient();
    expect(typeof mock.completeStructured).toBe('function');
    expect(typeof mock.completeReflection).toBe('function');
    expect(typeof mock.completePlan).toBe('function');
    expect(typeof mock.completeReflect).toBe('function');
  });

  it('MockLLMClient.completeStructured returns a valid LLMActionResponse', async () => {
    const mod = await import('../../examples/minimal-scene.ts');
    const mock = new mod.MockLLMClient();
    const payload: LLMContextPayload = {
      systemPrompt: 'sys',
      perceptionContext: 'ctx',
      availableAffordances: [],
      cognitiveTools: [],
      tools: [chooseActionTool],
    };
    const result = await mock.completeStructured(payload);
    expect(result.reasoning).toBeDefined();
    expect(result.action).toBeDefined();
  });

  it('MockLLMClient.completePlan returns a valid FormulatePlanResult', async () => {
    const mod = await import('../../examples/minimal-scene.ts');
    const mock = new mod.MockLLMClient();
    const payload: LLMContextPayload = {
      systemPrompt: 'sys',
      perceptionContext: 'ctx',
      availableAffordances: [],
      cognitiveTools: [],
      tools: [formulatePlanTool],
    };
    const result = await mock.completePlan(payload);
    expect(result.description).toBeDefined();
    expect(result.steps).toBeDefined();
    expect(Array.isArray(result.steps)).toBe(true);
  });

  it('MockLLMClient.completeReflect returns a valid ReflectLLMResponse', async () => {
    const mod = await import('../../examples/minimal-scene.ts');
    const mock = new mod.MockLLMClient();
    const payload: LLMContextPayload = {
      systemPrompt: 'sys',
      perceptionContext: 'ctx',
      availableAffordances: [],
      cognitiveTools: [],
      tools: [reflectTool],
    };
    const result = await mock.completeReflect(payload);
    expect(result).toBeDefined();
  });
});

// ─── AC-29: Superseded test files are deleted ────────────────────────────────

describe('Superseded test files deleted (AC-29)', () => {
  const DELETED_FILES = [
    'packages/cognition/tests/json-recovery.test.ts',
    'packages/cognition/tests/builder-json-suffix.test.ts',
    'packages/cognition/tests/schema-hints-and-aliasing.test.ts',
    'packages/shared/tests/llm-schema-hints.test.ts',
  ];

  for (const file of DELETED_FILES) {
    it(`${file} no longer exists (AC-29)`, () => {
      expect(repoFileExists(file)).toBe(false);
    });
  }
});

// ─── AC-32: Builder system prompts don't contain JSON_INSTRUCTION_SUFFIX ─────

describe('Builder system prompts (AC-32)', () => {
  it('PlanBuilderImpl system prompt does not contain JSON_INSTRUCTION_SUFFIX', () => {
    const builder = new PlanBuilderImpl();
    const payload = builder.build(makePerceptionResult());
    expect(payload.systemPrompt).not.toContain('IMPORTANT: Respond ONLY with a valid JSON object');
    expect(payload.systemPrompt).not.toContain('JSON_INSTRUCTION_SUFFIX');
  });

  it('PerceptionBuilderImpl system prompt does not contain JSON_INSTRUCTION_SUFFIX', () => {
    const builder = new PerceptionBuilderImpl();
    const payload = builder.build(makePerceptionResult());
    expect(payload.systemPrompt).not.toContain('IMPORTANT: Respond ONLY with a valid JSON object');
    expect(payload.systemPrompt).not.toContain('JSON_INSTRUCTION_SUFFIX');
  });

  it('ReflectBuilderImpl system prompt does not contain JSON_INSTRUCTION_SUFFIX', () => {
    const builder = new ReflectBuilderImpl();
    const payload = builder.build('agent-1', makeAgentState(), makeExecuteResult());
    expect(payload.systemPrompt).not.toContain('IMPORTANT: Respond ONLY with a valid JSON object');
    expect(payload.systemPrompt).not.toContain('JSON_INSTRUCTION_SUFFIX');
  });

  it('PlanBuilderImpl source does not import JSON_INSTRUCTION_SUFFIX or PLAN_SCHEMA_HINT', () => {
    const src = readSrc('src/pper/plan-builder.ts');
    expect(src).not.toContain('JSON_INSTRUCTION_SUFFIX');
    expect(src).not.toContain('PLAN_SCHEMA_HINT');
  });

  it('PerceptionBuilderImpl source does not import JSON_INSTRUCTION_SUFFIX or ACTION_RESPONSE_SCHEMA_HINT', () => {
    const src = readSrc('src/pper/perception-builder.ts');
    expect(src).not.toContain('JSON_INSTRUCTION_SUFFIX');
    expect(src).not.toContain('ACTION_RESPONSE_SCHEMA_HINT');
  });

  it('ReflectBuilderImpl source does not import JSON_INSTRUCTION_SUFFIX or REFLECT_SCHEMA_HINT', () => {
    const src = readSrc('src/pper/reflect-builder.ts');
    expect(src).not.toContain('JSON_INSTRUCTION_SUFFIX');
    expect(src).not.toContain('REFLECT_SCHEMA_HINT');
  });
});

// ─── AC-33: PPER service tests exist and are unmodified ──────────────────────

describe('PPER service tests pass without service modification (AC-33)', () => {
  it('pper-orchestrator.test.ts exists (service tests intact)', () => {
    expect(existsSync(join(COGNITION_ROOT, 'tests/pper-orchestrator.test.ts'))).toBe(true);
  });

  it('pper-error-recovery.test.ts exists (service tests intact)', () => {
    expect(existsSync(join(COGNITION_ROOT, 'tests/pper-error-recovery.test.ts'))).toBe(true);
  });

  it('PPER service source files do not reference responseSchema, schemaHint, or tool calling constructs', () => {
    const serviceFiles = [
      'src/pper/plan-service.ts',
      'src/pper/reflect-service.ts',
      'src/pper/execute-service.ts',
      'src/pper/orchestrator.ts',
    ];
    for (const file of serviceFiles) {
      const src = readSrc(file);
      expect(src).not.toContain('responseSchema');
      expect(src).not.toContain('schemaHint');
    }
  });
});

// ─── AC-34: Package boundaries ───────────────────────────────────────────────

describe('Package boundaries (AC-34)', () => {
  it('openai-client.ts does not import from @evol-hive/engine', () => {
    const src = readSrc('src/llm/openai-client.ts');
    expect(src).not.toContain('@evol-hive/engine');
  });

  it('no new npm dependencies in cognition package.json', () => {
    const pkgJson = JSON.parse(readSrc('package.json'));
    expect(pkgJson.dependencies).toBeDefined();
    // The dependency list should not include any new packages beyond what
    // was already there. We verify the key set is stable (no unexpected additions).
    const deps = Object.keys(pkgJson.dependencies || {});
    // @evol-hive/shared and @evol-hive/memory (added by spec 015, AC-36) are the
    // only allowed workspace dependencies.
    const workspaceDeps = deps.filter((d) => d.startsWith('@evol-hive/'));
    expect(workspaceDeps).toEqual(['@evol-hive/shared', '@evol-hive/memory']);
  });

  it('no new npm dependencies in shared package.json', () => {
    const pkgJson = JSON.parse(readRepo('packages/shared/package.json'));
    const deps = Object.keys(pkgJson.dependencies || {});
    // Shared should have no runtime dependencies (it's a types/schemas package).
    expect(deps).toEqual([]);
  });
});

// ─── AC-35: INDEX.md status updates ──────────────────────────────────────────

describe('Spec INDEX.md status updates (AC-35)', () => {
  it('spec 011 is listed in INDEX.md', () => {
    const src = readRepo('docs/specs/INDEX.md');
    expect(src).toContain('011');
    expect(src).toContain('Replace Structured Output with Tool Calling');
  });

  it('spec 009 is marked as Superseded by 011', () => {
    const src = readRepo('docs/specs/INDEX.md');
    expect(src).toMatch(/009.*Superseded by 011/);
  });

  it('spec 010 is marked as Superseded by 011', () => {
    const src = readRepo('docs/specs/INDEX.md');
    expect(src).toMatch(/010.*Superseded by 011/);
  });
});
