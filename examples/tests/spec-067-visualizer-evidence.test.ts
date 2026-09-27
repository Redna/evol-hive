/**
 * Spec 067 — A Live Run Must Leave Evidence (issue #270), leg 1
 * ─────────────────────────────────────────────────────────────
 * `examples/visualizer-demo.ts` is the path most likely to run for hours
 * (live visual observation), so it is the one that MUST sink its System-1
 * samples on the real-LLM path (AC-1) and announce where they will land
 * before the first agent cycle (AC-2). `USE_REAL_LLM=false` keeps the
 * in-memory sink and writes nothing (AC-4).
 *
 * The decision is asserted as data through the demo's own exported seam
 * (`system1OptionsForRun`) plus `resolveSampleSink` (spec Test Seam 1). The
 * demo wiring is asserted at the source seam because starting a real-LLM demo
 * would require an LLM backend these tests must not use.
 *
 * Red on current `main`: the demo passes no `system1` option and no
 * `sessionLogDir` at all, so no samples are produced on the expensive path.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { DEFAULT_SESSION_LOG_DIR, resolveSampleSink } from '@evol-hive/assembly';
import { system1OptionsForRun } from '../visualizer-demo.js';

const SOURCE = readFileSync(new URL('../visualizer-demo.ts', import.meta.url), 'utf8');

describe('spec 067 AC-1 — the visualizer demo passes a session-log directory', () => {
  it('resolves a file sink for a real-LLM run (default `session-logs`)', () => {
    expect(system1OptionsForRun(true, {})).toEqual({
      useRealLlm: true,
      sessionLogDir: DEFAULT_SESSION_LOG_DIR,
    });
  });

  it('lets SYSTEM1_SESSION_LOG_DIR override the sink on the real-LLM path', () => {
    expect(system1OptionsForRun(true, { SYSTEM1_SESSION_LOG_DIR: '/tmp/override-067' })).toEqual({
      useRealLlm: true,
      sessionLogDir: '/tmp/override-067',
    });
  });

  it('carries the gate artifact through on the real-LLM path', () => {
    expect(
      system1OptionsForRun(true, {
        SYSTEM1_SESSION_LOG_DIR: '/tmp/override-067',
        SYSTEM1_GATE_ARTIFACT: 'gate-artifact.json',
      }),
    ).toEqual({
      useRealLlm: true,
      sessionLogDir: '/tmp/override-067',
      gateArtifactPath: 'gate-artifact.json',
    });
  });

  it('passes the resolved System-1 options into assembleWorld (uses the shared resolver)', () => {
    expect(SOURCE).toMatch(/resolveSampleSink\(/);
    expect(SOURCE).toMatch(/system1OptionsForRun\(useRealLLM\)/);
    expect(SOURCE).toMatch(/system1 !== undefined \? \{ system1 \}/);
  });
});

describe('spec 067 AC-2 — the evidence destination is announced before cycles start', () => {
  it('prints the destination before core.gameLoop.start()', () => {
    const announceAt = SOURCE.indexOf('session samples');
    const startAt = SOURCE.indexOf('core.gameLoop.start()');
    expect(announceAt, 'the demo must announce where samples are written').toBeGreaterThanOrEqual(
      0,
    );
    expect(startAt, 'the demo must start the game loop').toBeGreaterThanOrEqual(0);
    expect(announceAt).toBeLessThan(startAt);
  });
});

describe('spec 067 AC-4 — USE_REAL_LLM=false writes nothing', () => {
  it('resolves the in-memory sink for a cheap run', () => {
    expect(resolveSampleSink({ useRealLlm: false })).toEqual({ kind: 'memory', directory: null });
  });

  it('wires no System 1 (and therefore no sample sink) for a cheap run', () => {
    expect(system1OptionsForRun(false, {})).toBeUndefined();
    // Even an explicit directory must not turn on System 1 for a cheap run.
    expect(system1OptionsForRun(false, { SYSTEM1_SESSION_LOG_DIR: '/tmp/x' })).toBeUndefined();
  });
});
