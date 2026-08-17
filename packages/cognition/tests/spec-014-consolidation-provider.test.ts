/**
 * Spec 014 — ConsolidationProviderImpl (cognition layer)
 * ──────────────────────────────────────────────────────
 * Covers AC-47, AC-48, AC-52.
 */
import { describe, it, expect, vi } from 'vitest';
import type {
  ConsolidationProvider,
  ReflectionResult,
  MemorySnippet,
  MemoryNode,
} from '@evol-hive/shared';
import { ConsolidationProviderImpl } from '../src/pper/consolidation-provider.js';
import type { LLMClient, LLMContextPayload } from '../src/index.js';

// ─── Fake LLMClient ──────────────────────────────────────────────────────────

class FakeLLMClient implements LLMClient {
  completeReflection = vi.fn(
    async (_systemPrompt: string, _nodes: MemorySnippet[]): Promise<ReflectionResult> => {
      return {
        // LLM may set a stale/empty agentId.
        agentId: '',
        newMemories: [
          {
            id: 'c-1',
            agentId: 'stale-from-llm',
            content: 'consolidated insight',
            embedding: [0.1, 0.2],
            timestamp: 0,
            importance: 9,
            type: 'reflection',
          } satisfies MemoryNode,
        ],
        consolidatedNodeIds: ['orig-1'],
      };
    },
  );
  completeStructured = vi.fn(async (_p: LLMContextPayload) => ({
    reasoning: '',
    action: 'idle',
  }));
  completePlan = vi.fn(async () => ({ description: '', steps: [] }));
  completeReflect = vi.fn(async () => ({}));
}

// ─── AC-47: exported & implements ConsolidationProvider ──────────────────────

describe('AC-47: ConsolidationProviderImpl exported', () => {
  it('is importable from cognition index and implements ConsolidationProvider', async () => {
    const mod = await import('../src/index.js');
    expect(mod.ConsolidationProviderImpl).toBeDefined();
    const provider: ConsolidationProvider = new ConsolidationProviderImpl({
      llmClient: new FakeLLMClient(),
    });
    expect(typeof provider.consolidate).toBe('function');
  });
});

// ─── AC-48: consolidate calls LLM and sets agentId ───────────────────────────

describe('AC-48: consolidate calls completeReflection and overrides agentId', () => {
  it('delegates to llmClient.completeReflection and sets agentId on each new memory', async () => {
    const llm = new FakeLLMClient();
    const provider = new ConsolidationProviderImpl({ llmClient: llm });

    const snippets: MemorySnippet[] = [
      { id: 'orig-1', content: 'low-level', importance: 3, timestamp: 10 },
    ];
    const result = await provider.consolidate('agent-99', 'system prompt', snippets);

    expect(llm.completeReflection).toHaveBeenCalledTimes(1);
    expect(llm.completeReflection).toHaveBeenCalledWith('system prompt', snippets);
    expect(result.newMemories).toHaveLength(1);
    expect(result.newMemories[0]?.agentId).toBe('agent-99');
  });
});

// ─── AC-52: package boundaries ───────────────────────────────────────────────

describe('AC-52: ConsolidationProviderImpl package boundaries', () => {
  it('imports from @evol-hive/shared but NOT from @evol-hive/memory', async () => {
    const fs = await import('fs');
    const source = fs.readFileSync('src/pper/consolidation-provider.ts', 'utf-8');
    expect(source).toContain('@evol-hive/shared');
    expect(source).not.toContain('@evol-hive/memory');
    expect(source).not.toContain('@evol-hive/engine');
  });
});
