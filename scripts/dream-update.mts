/**
 * scripts/dream-update — Sleep-time weight update runner (spec 035, Req 11–13).
 *
 * Reads per-agent JSONL session logs (`<dir>/<agentId>.jsonl`, written by the
 * System1OutcomeRecorder during live runs), applies one bounded dream update
 * (`applyDreamUpdate`: one-line linear probe SGD + holdout revert guardrail),
 * and writes the resulting weight artifact for hot-swap.
 *
 * Usage:
 *   npx tsx scripts/dream-update.ts <session-log-dir> <artifact-out> [artifact-in]
 *
 * - `<session-log-dir>`: directory containing `<agentId>.jsonl` session logs
 *   (default for live sims: `session-logs/`).
 * - `<artifact-out>`: where the updated artifact JSON is written
 *   (pass this path as SYSTEM1_GATE_ARTIFACT on the next live run).
 * - `[artifact-in]`: optional current artifact to warm-start from; omitted
 *   = fresh zero-weight head (headVersion 1).
 *
 * The script is offline and idempotent — the runtime never trains (ADR-0002:
 * TS serves ONNX/linear artifacts; dream updates are the TS-native exception,
 * bounded and audited).
 */

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CycleOutcomeSample, GateWeightArtifact } from '../packages/shared/src/index.js';
import {
  FEATURE_SCHEMA_VERSION,
  SCALAR_FEATURE_FIELDS,
  defaultDreamUpdateConfig,
} from '../packages/shared/src/index.js';
import { applyDreamUpdate } from '../packages/cognition/src/system1/dream-update.ts';

function loadSamples(dir: string): CycleOutcomeSample[] {
  const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  if (files.length === 0) {
    throw new Error(`No .jsonl session logs found in ${dir}`);
  }
  const samples: CycleOutcomeSample[] = [];
  for (const f of files) {
    const lines = readFileSync(join(dir, f), 'utf-8')
      .split('\n')
      .filter((l) => l.trim().length > 0);
    for (const line of lines) {
      try {
        samples.push(JSON.parse(line) as CycleOutcomeSample);
      } catch {
        console.error(`[dream] skipping unparseable line in ${f}`);
      }
    }
    console.error(`[dream] ${f}: ${lines.length} samples`);
  }
  return samples;
}

function freshArtifact(): GateWeightArtifact {
  const scalarWeights: Record<string, number> = {};
  for (const field of SCALAR_FEATURE_FIELDS) {
    scalarWeights[field] = 0;
  }
  return {
    kind: 'react-gate',
    headVersion: 1,
    featureSchemaVersion: FEATURE_SCHEMA_VERSION,
    bias: 0,
    scalarWeights,
    embeddingWeights: null,
    trainedAt: new Date().toISOString(),
    source: 'scripts/dream-update.ts (fresh)',
  };
}

function main(): void {
  const [dir, artifactOut, artifactIn] = process.argv.slice(2);
  if (dir === undefined || artifactOut === undefined) {
    console.error(
      'Usage: npx tsx scripts/dream-update.ts <session-log-dir> <artifact-out> [artifact-in]',
    );
    process.exit(1);
  }

  const samples = loadSamples(dir);
  console.error(`[dream] total samples: ${samples.length}`);

  let previous = freshArtifact();
  if (artifactIn !== undefined) {
    previous = JSON.parse(readFileSync(artifactIn, 'utf-8')) as GateWeightArtifact;
    console.error(
      `[dream] warm start: headVersion=${previous.headVersion} (bias=${previous.bias.toFixed(4)})`,
    );
  }

  const { artifact, event } = applyDreamUpdate(previous, samples, defaultDreamUpdateConfig());

  writeFileSync(artifactOut, JSON.stringify(artifact, null, 2));
  console.log(JSON.stringify(event, null, 2));
  console.error(
    event.reverted
      ? `[dream] REVERTED — holdout loss regressed; artifact unchanged (headVersion ${artifact.headVersion})`
      : `[dream] committed: headVersion ${event.headVersionBefore} → ${event.headVersion}, ` +
          `loss ${event.lossBefore.toFixed(4)} → ${event.lossAfter.toFixed(4)} ` +
          `(${event.trainCount} train / ${event.holdoutCount} holdout) → ${artifactOut}`,
  );
}

main();
