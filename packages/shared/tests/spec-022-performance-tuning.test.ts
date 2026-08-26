/**
 * Spec 022 — Performance Tuning: shared types & defaults.
 * Covers AC-1 (SceneDefinition.maxConcurrentCycles), AC-3 (default config),
 * AC-16 (formatPersona memoization), and the new shared config types
 * (TokenUsageReport, MemoryInjectionConfig, BatchPlanConfig).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { defaultPPERSchedulerConfig, formatPersona } from '../src/index.js';
import type {
  SceneDefinition,
  PPERSchedulerConfig,
  TokenUsageReport,
  MemoryInjectionConfig,
  BatchPlanConfig,
  AgentProfile,
} from '../src/index.js';

// ─── AC-3: defaultPPERSchedulerConfig default change 8 → 1 ───────────────────

describe('AC-3: defaultPPERSchedulerConfig (Req 4)', () => {
  const origEnv = process.env['ENGINE_MAX_CONCURRENT_LLM'];

  afterEach(() => {
    if (origEnv === undefined) {
      delete process.env['ENGINE_MAX_CONCURRENT_LLM'];
    } else {
      process.env['ENGINE_MAX_CONCURRENT_LLM'] = origEnv;
    }
  });

  it('returns maxConcurrentCycles: 1 when ENGINE_MAX_CONCURRENT_LLM is unset', () => {
    delete process.env['ENGINE_MAX_CONCURRENT_LLM'];
    const config = defaultPPERSchedulerConfig();
    expect(config.maxConcurrentCycles).toBe(1);
  });

  it('returns maxConcurrentCycles: 8 when ENGINE_MAX_CONCURRENT_LLM=8', () => {
    process.env['ENGINE_MAX_CONCURRENT_LLM'] = '8';
    const config = defaultPPERSchedulerConfig();
    expect(config.maxConcurrentCycles).toBe(8);
  });

  it('returns maxConcurrentCycles: 4 when ENGINE_MAX_CONCURRENT_LLM=4', () => {
    process.env['ENGINE_MAX_CONCURRENT_LLM'] = '4';
    const config = defaultPPERSchedulerConfig();
    expect(config.maxConcurrentCycles).toBe(4);
  });

  it('PPERSchedulerConfig accepts explicit maxConcurrentCycles', () => {
    const config: PPERSchedulerConfig = { maxConcurrentCycles: 16 };
    expect(config.maxConcurrentCycles).toBe(16);
  });
});

// ─── AC-1: SceneDefinition.maxConcurrentCycles ───────────────────────────────

describe('AC-1: SceneDefinition.maxConcurrentCycles (Req 1)', () => {
  it('accepts an optional maxConcurrentCycles field', () => {
    const scene: SceneDefinition = {
      id: 's1',
      name: 'Scene',
      rooms: [
        {
          id: 'kitchen',
          name: 'Kitchen',
          description: 'A kitchen',
          connections: [],
          objectIds: [],
        },
      ],
      objects: [],
      agents: [],
      maxConcurrentCycles: 3,
    };
    expect(scene.maxConcurrentCycles).toBe(3);
  });

  it('compiles without maxConcurrentCycles (backward compatible)', () => {
    const scene: SceneDefinition = {
      id: 's1',
      name: 'Scene',
      rooms: [],
      objects: [],
      agents: [],
    };
    expect(scene.maxConcurrentCycles).toBeUndefined();
  });
});

// ─── New shared config types ─────────────────────────────────────────────────

describe('TokenUsageReport type (Req 10)', () => {
  it('stores prompt/completion/total token counts with optional metadata', () => {
    const report: TokenUsageReport = {
      promptTokens: 120,
      completionTokens: 30,
      totalTokens: 150,
      agentId: 'a1',
      phase: 'plan',
      tickNumber: 7,
    };
    expect(report.promptTokens).toBe(120);
    expect(report.completionTokens).toBe(30);
    expect(report.totalTokens).toBe(150);
    expect(report.agentId).toBe('a1');
    expect(report.phase).toBe('plan');
    expect(report.tickNumber).toBe(7);
  });

  it('compiles with only the required token counts', () => {
    const report: TokenUsageReport = {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    };
    expect(report.totalTokens).toBe(0);
  });
});

describe('MemoryInjectionConfig type (Req 13)', () => {
  it('stores a topK number', () => {
    const config: MemoryInjectionConfig = { topK: 3 };
    expect(config.topK).toBe(3);
  });
});

describe('BatchPlanConfig type (Req 7)', () => {
  it('stores a maxBatchSize number', () => {
    const config: BatchPlanConfig = { maxBatchSize: 5 };
    expect(config.maxBatchSize).toBe(5);
  });
});

// ─── AC-16: formatPersona memoization ────────────────────────────────────────
//
// `formatPersona` returns a primitive string, so "string instance" identity
// cannot be observed with `Object.is`/`===`. Memoization (a `WeakMap` keyed by
// `AgentProfile` reference) is therefore verified via its observable side
// effect: when the persona text exceeds 500 characters, `formatPersona` logs a
// `console.warn`. With memoization, repeated calls for the *same* profile
// reference emit the warning exactly once (the cached result is reused); calls
// for *different* profile objects with identical content each recompute and
// warn separately (reference-keyed cache).

describe('AC-16: formatPersona memoization (Req 16)', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
  });

  function longPersonaProfile(id: string): AgentProfile {
    return {
      id,
      name: id,
      description: 'test',
      traits: [],
      initialDrives: { energy: 50 },
      backstory: 'x'.repeat(600), // forces the >500-char warning
    };
  }

  it('emits the >500-char warning only once for repeated calls with the same reference', () => {
    const profile = longPersonaProfile('a1');
    formatPersona(profile);
    formatPersona(profile);
    formatPersona(profile);
    const personaWarnings = warnSpy.mock.calls.filter((c) =>
      String(c[0]).includes('formatPersona'),
    );
    expect(personaWarnings).toHaveLength(1);
  });

  it('emits the warning per distinct AgentProfile object (reference-keyed cache)', () => {
    const profileA = longPersonaProfile('a1');
    const profileB = longPersonaProfile('a1'); // identical content, different object
    formatPersona(profileA);
    formatPersona(profileB);
    const personaWarnings = warnSpy.mock.calls.filter((c) =>
      String(c[0]).includes('formatPersona'),
    );
    expect(personaWarnings).toHaveLength(2);
  });

  it('returns the correct persona text for the same reference', () => {
    const profile: AgentProfile = {
      id: 'a2',
      name: 'Bob',
      description: 'A merchant',
      traits: ['cautious'],
      initialDrives: { energy: 40 },
      speechStyle: 'formal',
    };
    const first = formatPersona(profile);
    const second = formatPersona(profile);
    expect(second).toEqual(first);
    expect(second).toContain('Traits: cautious');
    expect(second).toContain('Speech style: formal');
  });

  it('memoized result is stable (same value) across many calls', () => {
    const profile: AgentProfile = {
      id: 'a3',
      name: 'Cara',
      description: 'A merchant',
      traits: ['cautious'],
      initialDrives: { energy: 40 },
      speechStyle: 'formal',
    };
    const results = new Set<string>();
    for (let i = 0; i < 10; i++) {
      results.add(formatPersona(profile));
    }
    expect(results.size).toBe(1);
  });
});
