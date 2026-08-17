/**
 * Spec 014 — Package boundary checks (memory layer)
 * ──────────────────────────────────────────────────
 * Covers AC-49 and AC-50: RetrievalEngineImpl and ReflectionLoopImpl import
 * from @evol-hive/shared only (not from cognition or engine).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

describe('AC-49: RetrievalEngineImpl imports from shared only', () => {
  it('does not import @evol-hive/cognition or @evol-hive/engine', () => {
    const source = readFileSync('src/retrieval/retrieval-engine.ts', 'utf-8');
    expect(source).not.toContain('@evol-hive/cognition');
    expect(source).not.toContain('@evol-hive/engine');
  });
});

describe('AC-50: ReflectionLoopImpl imports from shared only', () => {
  it('does not import @evol-hive/cognition or @evol-hive/engine', () => {
    const source = readFileSync('src/reflection/reflection-loop.ts', 'utf-8');
    expect(source).not.toContain('@evol-hive/cognition');
    expect(source).not.toContain('@evol-hive/engine');
  });
});
