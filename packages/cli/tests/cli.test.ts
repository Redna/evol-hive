/**
 * Spec 022 CLI tests — Scene Authoring (Declarative)
 * ====================================================
 * Tests for the evol-hive CLI commands: validate-scene, create-scene,
 * run-scene. These tests cover AC-12 through AC-15 from the spec.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const REPO_ROOT = resolve(__dirname, '../../..');
const TMP_DIR = join(REPO_ROOT, 'packages/cli/tests/tmp-cli-files');

function ensureTmpDir(): void {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
  mkdirSync(TMP_DIR, { recursive: true });
}

function cleanupTmpDir(): void {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
}

/** Run the CLI via tsx (source-level execution, no build step needed). */
function runCli(args: string[], opts?: { stdin?: string; cwd?: string; timeoutMs?: number }) {
  const result = spawnSync('npx', ['tsx', join(REPO_ROOT, 'packages/cli/src/cli.ts'), ...args], {
    cwd: opts?.cwd ?? REPO_ROOT,
    input: opts?.stdin,
    encoding: 'utf-8',
    timeout: opts?.timeoutMs ?? 30_000,
    env: { ...process.env, USE_REAL_LLM: 'false', USE_REAL_EMBEDDINGS: 'false' },
  });
  return {
    exitCode: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

// ─── AC-12: validate-scene on valid file ───────────────────────────────────

describe('Spec 022 — AC-12: validate-scene on valid file exits 0', () => {
  it('npx evol-hive validate-scene examples/coffee-shop.scene.yaml exits 0 and prints success', () => {
    const result = runCli(['validate-scene', 'examples/coffee-shop.scene.yaml']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('valid');
  });
});

// ─── AC-13: validate-scene on malformed file ───────────────────────────────

describe('Spec 022 — AC-13: validate-scene on malformed file exits 1', () => {
  let malformedFile: string;

  beforeEach(() => {
    ensureTmpDir();
    malformedFile = join(TMP_DIR, 'malformed.scene.yaml');
    writeFileSync(
      malformedFile,
      `
id: bad-scene
name: Bad Scene
rooms:
  - id: room-1
    description: Missing name field.
    connections: []
    objectIds: []
objects: []
agents: []
`,
      'utf-8',
    );
  });

  afterEach(cleanupTmpDir);

  it('exits with code 1 and prints validation errors with field paths', () => {
    const result = runCli(['validate-scene', malformedFile]);
    expect(result.exitCode).toBe(1);
    // Output should contain a field path reference
    const output = result.stdout + result.stderr;
    expect(output).toContain('/rooms/0');
    expect(output.toLowerCase()).toContain('name');
  });
});

// ─── AC-14: create-scene produces valid .scene.yaml ────────────────────────

describe('Spec 022 — AC-14: create-scene produces valid .scene.yaml', () => {
  let outputDir: string;

  beforeEach(() => {
    ensureTmpDir();
    outputDir = TMP_DIR;
  });

  afterEach(cleanupTmpDir);

  it('create-scene with interactive answers produces a valid .scene.yaml', () => {
    const outputFile = join(outputDir, 'my-scene.scene.yaml');

    // Provide answers via stdin: scene name, then rooms, objects, agents
    // The wizard prompts will be answered by piped stdin lines.
    // Provide answers via stdin matching the wizard flow:
    //   1. Scene name
    //   2. Room name (not empty to create a room)
    //   3. Room description
    //   4. Connections (empty for none)
    //   5. Add another room? (n)
    //   6. Object name (empty to skip)
    //   7. Agent name (empty to skip)
    const stdin = [
      'My Test Scene', // scene name
      'bedroom', // room name
      'A cozy bedroom', // room description
      '', // connections (empty)
      'n', // add another room? no
      '', // object name (empty to skip objects)
      '', // agent name (empty to skip agents)
    ].join('\n');

    const result = runCli(['create-scene', '--output', outputFile], {
      stdin: stdin + '\n',
      timeoutMs: 15_000,
    });

    // The file should exist and be valid YAML
    expect(existsSync(outputFile)).toBe(true);
    const content = readFileSync(outputFile, 'utf-8');
    expect(content).toContain('id:');
    expect(content).toContain('name:');

    // Validate the produced file
    const validateResult = runCli(['validate-scene', outputFile]);
    expect(validateResult.exitCode).toBe(0);
  });
});

// ─── AC-15: run-scene prints agent state snapshot ──────────────────────────

describe('Spec 022 — AC-15: run-scene prints agent state snapshot', () => {
  it('run-scene builds engine and prints at least one agent state snapshot', () => {
    // Run with a short duration to avoid long test times
    const result = runCli(['run-scene', 'examples/coffee-shop.scene.yaml', '--duration', '2000'], {
      timeoutMs: 30_000,
    });

    // Should print at least one agent state snapshot
    const output = result.stdout + result.stderr;
    expect(output).toContain('state') || expect(output).toContain('[state]');
  });
});
