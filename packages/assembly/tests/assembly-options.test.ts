/**
 * Spec 050 — QA coverage pass: assembler OPTION wires (R2/R5 residual gaps)
 * ────────────────────────────────────────────────────────────────────────────
 * The main suites (assembly.test.ts, scheduler-forwarding.test.ts,
 * wiring-audit.test.ts) cover AC-1/2/3/6 and the R2 core wires. This suite
 * closes the three remaining R2/R5 gaps found in the QA coverage audit of
 * PR #185 — wires the assembler performs that no test observed:
 *
 *   1. R2 (spec 017, Req 16/18): the `autoSave` option — the assembler sets
 *      `core.autoSaveConfig` and forwards the config to `assembleGameLoop`,
 *      which registers the AutoSaveSystem when enabled and persistence
 *      exists. Previously examples wired `AutoSaveSystem` by hand
 *      (e.g. `coffee-shop.ts`); after spec 050 this is an assembler wire, so
 *      it must be observed through `assembleWorld`.
 *   2. R2 (spec 014, Req 17/18): memory maintenance opt-out —
 *      `wireMemoryMaintenance: false` must leave NO decay service, NO
 *      reflection loop, and NO `memory-maintenance` system in the loop; the
 *      default (unset) registers it (the AC-2 suite passes the option but
 *      never asserted its effect).
 *   3. R5 (spec 027 AC-9, spec 007): embedding-provider selection inside
 *      `buildMemorySubsystem` — `USE_REAL_EMBEDDINGS=true` selects
 *      `OnnxEmbeddingProvider`, the default selects the assembler's
 *      `MockEmbeddingProvider`. Construction is lazy (spec 007: file I/O
 *      deferred to `embed()`/`ready()`), so asserting the selection never
 *      touches the network or the model file.
 *
 * Deterministic throughout — no network, no model files, no real timers.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { EngineConfig } from '@evol-hive/shared';
import { OnnxEmbeddingProvider } from '@evol-hive/cognition';
import { assembleWorld, buildMemorySubsystem, MockEmbeddingProvider } from '@evol-hive/assembly';

// ── Env hygiene ──────────────────────────────────────────────────────────────

const ENV_KEYS = ['USE_REAL_LLM', 'USE_REAL_EMBEDDINGS', 'EMBEDDING_MODEL_PATH'] as const;

beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeConfig(): EngineConfig {
  return {
    fps: 30,
    spatialDebounceSeconds: 2,
    maxConcurrentLLM: 8,
    guardrailsEnabled: true,
    guardrails: { affordanceMasking: true, contextualForcing: true, planValidation: true },
  };
}

/** Generic no-network mock LLM (the assembler's own default, re-declared). */
class GenericMockLLM {
  // Structural typing: the assembler only needs the LLMClient shape; the
  // no-op methods below mirror DefaultMockLLMClient. Declared inline to keep
  // this suite independent of the main suite's helper class.
  async completeStructured(): Promise<{ reasoning: string; action: string }> {
    return { reasoning: 'Mock action.', action: 'observe' };
  }
  async completeReflection(): Promise<{ agentId: string; newMemories: never[] }> {
    return { agentId: 'mock', newMemories: [] };
  }
  async completePlan(): Promise<{
    description: string;
    steps: { description: string; targetAffordance: string }[];
  }> {
    return {
      description: 'Observe the environment',
      steps: [{ description: 'Observe', targetAffordance: 'observe' }],
    };
  }
  async completeReflect(): Promise<{ memoryContent: string }> {
    return { memoryContent: 'Observed the environment.' };
  }
}

// ── (1) R2: the autoSave option wires the AutoSaveSystem (spec 017) ─────────

describe('spec 050 R2 — autoSave option wires the AutoSaveSystem through the assembler', () => {
  it('autoSave enabled: core.autoSaveConfig is set and the auto-save system is registered (persistence exists on the cognition path)', () => {
    const world = assembleWorld({
      config: makeConfig(),
      mockLLMClient: new GenericMockLLM(),
      autoSave: { enabled: true, intervalTicks: 12 },
    });
    expect(world.core.autoSaveConfig).toEqual({ enabled: true, intervalTicks: 12 });
    // AutoSaveSystem requires persistence (a VectorStore) — present here
    // because the assembler built the memory subsystem BEFORE the core (R5).
    expect(world.core.persistence).toBeDefined();
    expect(world.gameLoop.systemNames()).toContain('auto-save');
  });

  it('autoSave disabled: the config is recorded but the system is NOT registered (spec 017, Req 18 — enabled only)', () => {
    const world = assembleWorld({
      config: makeConfig(),
      mockLLMClient: new GenericMockLLM(),
      autoSave: { enabled: false, intervalTicks: 12 },
    });
    expect(world.core.autoSaveConfig).toEqual({ enabled: false, intervalTicks: 12 });
    expect(world.gameLoop.systemNames()).not.toContain('auto-save');
  });

  it('no autoSave option: no autoSaveConfig, no auto-save system (the former default shape)', () => {
    const world = assembleWorld({ config: makeConfig(), mockLLMClient: new GenericMockLLM() });
    expect(world.core.autoSaveConfig).toBeUndefined();
    expect(world.gameLoop.systemNames()).not.toContain('auto-save');
  });
});

// ── (2) R2: memory maintenance opt-out (spec 014) ────────────────────────────

describe('spec 050 R2 — wireMemoryMaintenance: false wires NO maintenance anywhere', () => {
  it('opt-out: no decay service, no reflection loop, no core maintenance config, no memory-maintenance system in the loop', () => {
    const world = assembleWorld({
      config: makeConfig(),
      mockLLMClient: new GenericMockLLM(),
      wireMemoryMaintenance: false,
    });
    expect(world.stack).toBeDefined();
    expect(world.stack!.memoryDecayService).toBeUndefined();
    expect(world.stack!.reflectionLoop).toBeUndefined();
    expect(world.core.memoryDecayService).toBeUndefined();
    expect(world.core.reflectionLoop).toBeUndefined();
    expect(world.core.memoryMaintenanceConfig).toBeUndefined();
    expect(world.gameLoop.systemNames()).not.toContain('memory-maintenance');
  });

  it('default (option unset): the maintenance system IS registered in the game loop — decay + reflection wired (spec 014)', () => {
    const world = assembleWorld({ config: makeConfig(), mockLLMClient: new GenericMockLLM() });
    expect(world.stack!.memoryDecayService).toBeDefined();
    expect(world.stack!.reflectionLoop).toBeDefined();
    expect(world.core.memoryMaintenanceConfig).toBeDefined();
    expect(world.gameLoop.systemNames()).toContain('memory-maintenance');
  });
});

// ── (3) R5: embedding-provider selection inside buildMemorySubsystem ─────────

describe('spec 050 R5 — buildMemorySubsystem selects the embedding provider from env', () => {
  it("default: the assembler's MockEmbeddingProvider (deterministic, no ONNX, no network)", () => {
    const memory = buildMemorySubsystem();
    expect(memory.embeddingProvider).toBeInstanceOf(MockEmbeddingProvider);
  });

  it('USE_REAL_EMBEDDINGS=true: OnnxEmbeddingProvider — construction is lazy (spec 007), selection touches no file', () => {
    process.env['USE_REAL_EMBEDDINGS'] = 'true';
    // A path that does not exist — safe, because the provider defers ALL
    // file I/O to embed()/embedBatch()/ready() (spec 007, lazy construction).
    process.env['EMBEDDING_MODEL_PATH'] = 'test-fixtures/nonexistent-model.onnx';
    const memory = buildMemorySubsystem();
    expect(memory.embeddingProvider).toBeInstanceOf(OnnxEmbeddingProvider);
    // The selection flows into the assembled stack unchanged — the classifier
    // and the System 1 feature service prune over the SAME provider (R5).
    const world = assembleWorld({ config: makeConfig(), mockLLMClient: new GenericMockLLM() });
    expect(world.stack!.embeddingProvider).toBeInstanceOf(OnnxEmbeddingProvider);
  });
});
