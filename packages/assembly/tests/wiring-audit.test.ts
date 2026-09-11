/**
 * Spec 050 — AC-1 / AC-3: static wiring audits (grep assertions)
 * ────────────────────────────────────────────────────────────────────────────
 * The two assembly paths (`packages/engine/src/assembly.ts` +
 * `examples/assembly.ts`) had already diverged twice (#155, #165). Spec 050
 * removes the second path and makes the composition root the only place that
 * wires the cognition stack. These audits pin the structural invariant:
 *
 *   AC-1 — `examples/assembly.ts` is deleted; no consumer entry point
 *     (examples/, packages/cli/src) contains any of
 *     `createPPEROrchestrator|new GuardrailEngineImpl|buildMemorySubsystem|
 *      new SocialManager` — nor any other wiring call.
 *   AC-3 — engine-side wiring (`ConversationManagerImpl` construction,
 *     `setTickSource`, persistence construction) appears ONLY in
 *     `packages/engine/src`; cognition-side wiring (orchestrator, guardrails,
 *     classifier, System 1 heads, LLM client construction) appears ONLY in
 *     `packages/assembly` (its definitions live in `packages/cognition`);
 *     consumers contain zero wiring calls — `assembleWorld(...)` + scene data.
 *
 * Scope note: the audits scan consumer ENTRY POINTS (top-level `examples/*.ts`
 * and `packages/cli/src/**`). Test files legitimately construct machinery with
 * manual wiring (component QA suites); they are not consumers.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..');

// ── File collection ──────────────────────────────────────────────────────────

/** All top-level examples entry points (the demo/validation entry points). */
function exampleEntryFiles(): string[] {
  const dir = resolve(REPO, 'examples');
  return readdirSync(dir)
    .filter((f) => f.endsWith('.ts'))
    // Build/tooling config files are not consumers.
    .filter((f) => !f.endsWith('.config.ts'))
    .map((f) => resolve(dir, f));
}

/** All CLI source files. */
function cliSourceFiles(): string[] {
  const dir = resolve(REPO, 'packages', 'cli', 'src');
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const f of readdirSync(d)) {
      const p = resolve(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (f.endsWith('.ts')) out.push(p);
    }
  };
  walk(dir);
  return out;
}

function pkgSourceFiles(pkg: string): string[] {
  const dir = resolve(REPO, 'packages', pkg, 'src');
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const f of readdirSync(d)) {
      const p = resolve(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (f.endsWith('.ts')) out.push(p);
    }
  };
  walk(dir);
  return out;
}

const read = (p: string): string => readFileSync(p, 'utf-8');

const rel = (p: string): string => p.slice(REPO.length + 1);

// ── AC-1: examples/assembly.ts is deleted ────────────────────────────────────

describe('AC-1 — examples/assembly.ts is deleted (single wiring source of truth)', () => {
  it('examples/assembly.ts no longer exists', () => {
    expect(existsSync(resolve(REPO, 'examples', 'assembly.ts'))).toBe(false);
  });

  it('no source file imports the deleted examples assembly (stale relative imports)', () => {
    for (const file of [...exampleEntryFiles(), ...cliSourceFiles()]) {
      const src = read(file);
      expect(src, rel(file)).not.toMatch(/from\s+'\.\/assembly(\.js|\.ts)?'/);
      expect(src, rel(file)).not.toMatch(/from\s+'\.\.\/assembly(\.js|\.ts)?'/);
    }
  });
});

// ── AC-1: consumers contain zero wiring calls ────────────────────────────────

describe('AC-1/AC-3 — consumer entry points are thin: assembleWorld + scene data only', () => {
  // Everything that counts as WIRING (engine-side or cognition-side assembly
  // machinery). Consumers pass config + env only; the assembler owns all of it.
  const FORBIDDEN_IN_CONSUMERS = [
    'createEngineCore',
    'assembleGameLoop',
    'assembleCognitionStack',
    'assembleSystem1',
    'createPPEROrchestrator',
    'new GuardrailEngineImpl',
    'new CognitiveToolExecutorImpl',
    'buildMemorySubsystem',
    'new SocialManager',
    'new ConversationManagerImpl',
    'new InMemoryVectorStore',
    'new MemoryStoreImpl',
    'new MemoryDecayServiceImpl',
    'new ReflectionLoopImpl',
    'new OnnxEmbeddingProvider',
    'new AffordanceClassifierImpl',
    'new OpenAICompatibleLLMClient',
    'setConversationManager',
    'setTickSource',
    'new ReactGateHead',
    'new LinearImportanceHead',
    'new System1GateServiceImpl',
    'new System1FeatureServiceImpl',
    'new SalienceWeightedIdentityService',
  ];

  const consumers = [
    ...exampleEntryFiles().map((p) => ({ path: p, label: rel(p) })),
    ...cliSourceFiles().map((p) => ({ path: p, label: rel(p) })),
  ];

  for (const forbidden of FORBIDDEN_IN_CONSUMERS) {
    it(`no consumer entry point contains "${forbidden}"`, () => {
      const offenders = consumers.filter((c) => read(c.path).includes(forbidden));
      expect(
        offenders.map((o) => o.label),
        `wiring call "${forbidden}" leaked into consumer entry points`,
      ).toEqual([]);
    });
  }

  it('every consumer entry point that assembles a world calls the promoted assembler', () => {
    // The five R3 consumers (plus the three legacy demo scenes) must all go
    // through the composition root. Files that never build an engine
    // (scene-data-only modules, the CLI's command dispatcher and scene
    // scaffolding/validation commands) are exempt.
    const SCENE_DATA_ONLY = new Set([
      'dynamic-world.ts',
      'scene-helpers.ts',
      'cli.ts',
      'create-scene.ts',
      'validate-scene.ts',
      // cli package barrels / command modules that never assemble an engine
      'index.ts',
    ]);
    const assemblers = consumers.filter((c) => !SCENE_DATA_ONLY.has(c.path.split('/').pop()!));
    for (const consumer of assemblers) {
      expect(read(consumer.path), rel(consumer.path)).toContain('assembleWorld');
    }
  });
});

// ── AC-3: engine-side wiring only in packages/engine ─────────────────────────

describe('AC-3 — engine-side wiring appears only in packages/engine', () => {
  const ENGINE_ONLY_WIRING = [
    'new ConversationManagerImpl',
    'setTickSource',
    'new EnginePersistenceImpl',
    'new AgentManagerImpl',
    'new SceneMutationServiceImpl',
  ];

  // The negative space: every OTHER package's src + consumer entry points.
  const nonEngineSources = [
    ...pkgSourceFiles('shared').map((p) => ({ path: p, label: rel(p) })),
    ...pkgSourceFiles('cognition').map((p) => ({ path: p, label: rel(p) })),
    ...pkgSourceFiles('memory').map((p) => ({ path: p, label: rel(p) })),
    ...pkgSourceFiles('assembly').map((p) => ({ path: p, label: rel(p) })),
    ...cliSourceFiles().map((p) => ({ path: p, label: rel(p) })),
  ];

  for (const wiring of ENGINE_ONLY_WIRING) {
    it(`"${wiring}" appears in no package outside packages/engine`, () => {
      const offenders = nonEngineSources.filter((s) => read(s.path).includes(wiring));
      expect(offenders.map((o) => o.label)).toEqual([]);
    });
  }

  it('cognition-side wiring appears in packages/assembly (and its cognition definitions), nowhere else', () => {
    // cognition-side CONSTRUCTION calls must be confined to the assembly
    // package's src (the orchestrator/guardrail factories are DEFINED in
    // cognition's src and are not scanned here).
    for (const pkg of ['engine', 'shared', 'memory']) {
      for (const file of pkgSourceFiles(pkg)) {
        const src = read(file);
        expect(src, rel(file)).not.toMatch(/createPPEROrchestrator\(/);
        expect(src, rel(file)).not.toMatch(/new GuardrailEngineImpl/);
      }
    }
  });
});

// ── Package boundary (§2 dependency graph, enforced structurally) ────────────

describe('AC-3 — package dependency graph (ADR-0001 + spec 050 R1)', () => {
  function importsOf(src: string): string[] {
    const matches = src.matchAll(/from\s+'(@evol-hive\/[a-z]+)'/g);
    return [...matches].map((m) => m[1]!);
  }

  it('engine never imports cognition, and cognition never imports engine (mutual independence)', () => {
    for (const file of pkgSourceFiles('engine')) {
      expect(importsOf(read(file)), rel(file)).not.toContain('@evol-hive/cognition');
    }
    for (const file of pkgSourceFiles('cognition')) {
      expect(importsOf(read(file)), rel(file)).not.toContain('@evol-hive/engine');
    }
  });

  it('the assembly package is the only place depending on BOTH engine and cognition', () => {
    const assemblySrc = pkgSourceFiles('assembly').map(read).join('\n');
    expect(assemblySrc).toContain('@evol-hive/engine');
    expect(assemblySrc).toContain('@evol-hive/cognition');
    for (const pkg of ['shared', 'engine', 'memory', 'cognition']) {
      for (const file of pkgSourceFiles(pkg)) {
        expect(importsOf(read(file)), rel(file)).not.toContain('@evol-hive/assembly');
      }
    }
  });

  it('shared imports nothing from sibling packages (zero deps)', () => {
    for (const file of pkgSourceFiles('shared')) {
      const imports = importsOf(read(file));
      expect(imports, rel(file)).toEqual([]);
    }
  });
});