/**
 * System 1 — Trainable React/Ignore Gating + Trainable Importance Head
 * ─────────────────────────────────────────────────────────────────────
 * Spec 035 (issue #132). This module is the **feature-schema contract**
 * (Req 2): the fixed field order and normalization rules that bind the TS
 * feature extractor (cognition) to any trainer (ADR-0002 "Negative costs"
 * mitigation), plus the typed cross-package ports that let the engine's
 * scheduler consult a System 1 gate without engine↔cognition imports
 * (ADR-0001 — same pattern as `PPEROrchestratorPort`).
 *
 * The pure scalar/normalization functions below are part of the contract and
 * are consumed by BOTH the cognition extractor and the engine trigger source.
 * The extractor assembly (which injects the 384-dim snapshot embedding) lives
 * in `@evol-hive/cognition/src/system1/`.
 *
 * Golden rule (ADR-0002, amended): TS never *trains* models — it only runs
 * inference (a linear probe here: `p = σ(W·x + b)`) over deterministic feature
 * vectors. All gradient updates happen in Python offline (`training/`), or as
 * audited one-line sleep-time updates at dream boundaries.
 */

import type { AgentDrives } from './agent.js';

// ─────────────────────────────────────────────────────────────────────────────
// Feature schema contract (Req 1, Req 2)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The version of the scalar feature schema. ANY change to the field list,
 * order, or normalization rules MUST bump this constant and invalidate prior
 * artifacts (heads fail open on mismatch).
 */
export const FEATURE_SCHEMA_VERSION = 1;

/**
 * The ordered scalar feature fields — the order IS the contract. The trainer
 * consumes exactly this sequence.
 *
 * 5 normalized drives (0–1) + 5 normalized drive deltas (−1–1) + novelty
 * (0–1) + 6 flags/scalars (0–1).
 */
export const SCALAR_FEATURE_FIELDS = [
  'driveEnergy',
  'driveHunger',
  'driveSocial',
  'driveComfort',
  'driveCuriosity',
  'deltaEnergy',
  'deltaHunger',
  'deltaSocial',
  'deltaComfort',
  'deltaCuriosity',
  'novelty',
  'messagePending',
  'conversationOpen',
  'conversationTurns',
  'nearbyObjectStateChange',
  'worldMutation',
  'driveThresholdCrossing',
  'ticksSinceLastCycle',
] as const;

export type ScalarFeatureField = (typeof SCALAR_FEATURE_FIELDS)[number];

/** The scalar portion of a feature vector, keyed by the ordered contract fields. */
export type ScalarFeatures = Record<ScalarFeatureField, number>;

/** The full feature vector: 384-dim snapshot embedding ⊕ ordered scalars. */
export interface System1FeatureVector {
  /** Stamped schema version (must equal {@link FEATURE_SCHEMA_VERSION} at build time). */
  schemaVersion: number;
  /** The snapshot embedding from the shared embedding provider (e.g. 384-dim). */
  embedding: number[];
  /** The ordered scalar features. */
  scalar: ScalarFeatures;
}

/** A schema-versioned scalar feature set (the extractor's output). */
export interface ScalarFeatureSet {
  schemaVersion: number;
  scalar: ScalarFeatures;
}

/** Fields that are binary flags (0 or 1) per the normalization contract. */
const BINARY_FLAG_FIELDS: ReadonlySet<string> = new Set([
  'messagePending',
  'conversationOpen',
  'nearbyObjectStateChange',
  'worldMutation',
  'driveThresholdCrossing',
]);

/**
 * Validates the normalization contract for a scalar feature set (Req 2):
 * drives 0–1, deltas −1–1, novelty 0–1, flags 0/1, remaining scalars 0–1.
 * Returns a list of human-readable violations (empty = valid).
 */
export function validateScalarFeatures(scalar: ScalarFeatures): string[] {
  const violations: string[] = [];
  for (const field of SCALAR_FEATURE_FIELDS) {
    const value = scalar[field];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      violations.push(`${field}: not a finite number`);
      continue;
    }
    if (field.startsWith('delta')) {
      if (value < -1 || value > 1) violations.push(`${field}: ${value} outside -1..1`);
    } else if (BINARY_FLAG_FIELDS.has(field)) {
      if (value !== 0 && value !== 1) violations.push(`${field}: ${value} is not binary 0/1`);
    } else if (value < 0 || value > 1) {
      violations.push(`${field}: ${value} outside 0..1`);
    }
  }
  return violations;
}

/** Normalization constants (documented contract, deterministic). */
export interface System1GateConfig {
  /** Cycle runs when `p(react) >= threshold` (or a hard trigger fires). */
  threshold: number;
  /** How often (in ticks) the async embedding refresh runs per agent. */
  embeddingRefreshIntervalTicks: number;
  /** K most recent memory embeddings used for novelty. */
  noveltyMemoryK: number;
  /** Ticks-since-last-cycle normalization constant (saturates at 1). */
  ticksNormalization: number;
  /** Conversation-turn normalization constant (saturates at 1). */
  conversationTurnsNormalization: number;
}

/** Default System 1 gate config (spec 035). */
export function defaultSystem1GateConfig(): System1GateConfig {
  return {
    threshold: 0.5,
    embeddingRefreshIntervalTicks: 30,
    noveltyMemoryK: 5,
    ticksNormalization: 600, // ~10s at 60fps
    conversationTurnsNormalization: 20,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure normalization + scalar math (the shared part of the extractor, Req 1/2)
// ─────────────────────────────────────────────────────────────────────────────

/** Cosine similarity. Zero-magnitude vectors yield 0 (never NaN). */
export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let magA = 0;
  let magB = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i]! * b[i]!;
    magA += a[i]! * a[i]!;
    magB += b[i]! * b[i]!;
  }
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

/**
 * Novelty (Req 1): cosine distance (1 − max similarity) between the snapshot
 * embedding and the agent's K most recent memory embeddings. 1 = maximally
 * novel (including "no memories yet"), 0 = identical to the closest recent
 * memory. Decreases as the snapshot approaches recent-memory embeddings.
 */
export function computeNovelty(
  snapshotEmbedding: number[],
  recentMemoryEmbeddings: number[][] | undefined,
  k = 5,
): number {
  if (!recentMemoryEmbeddings || recentMemoryEmbeddings.length === 0) return 1;
  const window = recentMemoryEmbeddings.slice(-k); // K most recent
  let maxSim = -Infinity;
  for (const memory of window) {
    const sim = cosine(snapshotEmbedding, memory);
    if (sim > maxSim) maxSim = sim;
  }
  const novelty = 1 - maxSim;
  return Math.min(1, Math.max(0, novelty));
}

/** Normalized drive deltas (−1..1), keyed by the contract delta fields. */
export type DriveDeltas = Record<
  'deltaEnergy' | 'deltaHunger' | 'deltaSocial' | 'deltaComfort' | 'deltaCuriosity',
  number
>;

/**
 * Normalized drive deltas since the agent's last completed cycle (Req 1):
 * `(current − previous) / 100`, clamped to −1..1 (drives are 0–100).
 */
export function computeDriveDeltas(current: AgentDrives, previous: AgentDrives): DriveDeltas {
  const clamp = (v: number): number => Math.min(1, Math.max(-1, v));
  return {
    deltaEnergy: clamp((current.energy - previous.energy) / 100),
    deltaHunger: clamp((current.hunger - previous.hunger) / 100),
    deltaSocial: clamp((current.social - previous.social) / 100),
    deltaComfort: clamp((current.comfort - previous.comfort) / 100),
    deltaCuriosity: clamp((current.curiosity - previous.curiosity) / 100),
  };
}

/** Drive thresholds for crossing detection (0–100 drive scale). */
export interface DriveThresholds {
  low: number;
  high: number;
}

/** Default drive thresholds (spec 035): urgent band at ≤20, satisfied band at ≥80. */
export const DEFAULT_DRIVE_THRESHOLDS: DriveThresholds = { low: 20, high: 80 };

/**
 * True when any drive crossed a threshold boundary (low or high, either
 * direction) between the previous and current values (Req 1, Req 5).
 */
export function detectThresholdCrossings(
  previous: AgentDrives,
  current: AgentDrives,
  thresholds: DriveThresholds = DEFAULT_DRIVE_THRESHOLDS,
): boolean {
  const keys: (keyof AgentDrives)[] = ['energy', 'hunger', 'social', 'comfort', 'curiosity'];
  for (const key of keys) {
    const prev = previous[key];
    const curr = current[key];
    for (const t of [thresholds.low, thresholds.high]) {
      if ((prev < t && curr >= t) || (prev >= t && curr < t)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * The engine-state inputs to scalar feature extraction (Req 1). Gathered
 * synchronously from engine state by the engine's feature system; the
 * embedding is injected separately (it is the only asynchronous input).
 */
export interface System1EngineSnapshot {
  agentId: string;
  tickNumber: number;
  simTime: number;
  /** Current drive values (0–100). */
  drives: AgentDrives;
  /** Drive values at the agent's last *completed* cycle (`null` = never cycled). */
  drivesAtLastCycle: AgentDrives | null;
  /** Ticks since the last completed cycle (∞-safe: use a large number when never). */
  ticksSinceLastCycle: number;
  /** Incoming social message pending (peeked, not consumed). */
  messagePending: boolean;
  /** The agent participates in a live (open/active) conversation. */
  conversationOpen: boolean;
  /** Turn count of the agent's live conversation (0 when none). */
  conversationTurns: number;
  /** An object in the agent's room changed state recently. */
  nearbyObjectStateChange: boolean;
  /** A world mutation event occurred recently. */
  worldMutation: boolean;
  /** Deterministic snapshot text (embedded by the async refresh path). */
  snapshotText: string;
}

/**
 * Extracts the schema-versioned scalar feature set from an engine snapshot
 * (Req 1/2). Pure: fixed field order, fixed normalization. The embedding
 * inputs (snapshot + recent memories) are optional — novelty falls back to 1
 * (maximally novel) when absent.
 */
export function extractScalarFeatures(
  snapshot: System1EngineSnapshot,
  embeddings?: {
    snapshotEmbedding?: number[];
    recentMemoryEmbeddings?: number[][];
    noveltyMemoryK?: number;
  },
): ScalarFeatureSet {
  const cfg = defaultSystem1GateConfig();
  const drives: AgentDrives = snapshot.drives;
  const deltas = snapshot.drivesAtLastCycle
    ? computeDriveDeltas(drives, snapshot.drivesAtLastCycle)
    : { deltaEnergy: 0, deltaHunger: 0, deltaSocial: 0, deltaComfort: 0, deltaCuriosity: 0 };

  const novelty =
    embeddings?.snapshotEmbedding !== undefined
      ? computeNovelty(
          embeddings.snapshotEmbedding,
          embeddings.recentMemoryEmbeddings,
          embeddings.noveltyMemoryK ?? cfg.noveltyMemoryK,
        )
      : 1;

  // Threshold crossings are computed from engine state alone (Req 1): the
  // drives now vs. the drives at the agent's last completed cycle.
  const crossing =
    snapshot.drivesAtLastCycle !== null
      ? detectThresholdCrossings(snapshot.drivesAtLastCycle, drives)
      : false;

  const scalar: ScalarFeatures = {
    driveEnergy: clamp01(drives.energy / 100),
    driveHunger: clamp01(drives.hunger / 100),
    driveSocial: clamp01(drives.social / 100),
    driveComfort: clamp01(drives.comfort / 100),
    driveCuriosity: clamp01(drives.curiosity / 100),
    deltaEnergy: deltas.deltaEnergy,
    deltaHunger: deltas.deltaHunger,
    deltaSocial: deltas.deltaSocial,
    deltaComfort: deltas.deltaComfort,
    deltaCuriosity: deltas.deltaCuriosity,
    novelty,
    messagePending: snapshot.messagePending ? 1 : 0,
    conversationOpen: snapshot.conversationOpen ? 1 : 0,
    conversationTurns: clamp01(snapshot.conversationTurns / cfg.conversationTurnsNormalization),
    nearbyObjectStateChange: snapshot.nearbyObjectStateChange ? 1 : 0,
    worldMutation: snapshot.worldMutation ? 1 : 0,
    driveThresholdCrossing: crossing ? 1 : 0,
    ticksSinceLastCycle: clamp01(snapshot.ticksSinceLastCycle / cfg.ticksNormalization),
  };
  return { schemaVersion: FEATURE_SCHEMA_VERSION, scalar };
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

/** Projects the scalar set into the ordered contract vector. */
export function scalarToVector(scalar: ScalarFeatures): number[] {
  return SCALAR_FEATURE_FIELDS.map((field) => scalar[field]);
}

/**
 * Builds the full feature vector (Req 1): 384-dim snapshot embedding ⊕ ordered
 * scalars. Pure — the embedding must already be resolved (the async wrapper in
 * cognition resolves it via the shared provider).
 */
export function buildFeatureVector(
  snapshot: System1EngineSnapshot,
  snapshotEmbedding: number[],
  recentMemoryEmbeddings?: number[][],
): System1FeatureVector {
  if (!snapshotEmbedding || snapshotEmbedding.length === 0) {
    throw new Error('[system1] buildFeatureVector requires a non-empty snapshot embedding');
  }
  const { scalar } = extractScalarFeatures(snapshot, {
    snapshotEmbedding,
    ...(recentMemoryEmbeddings !== undefined ? { recentMemoryEmbeddings } : {}),
  });
  return { schemaVersion: FEATURE_SCHEMA_VERSION, embedding: snapshotEmbedding, scalar };
}

// ─────────────────────────────────────────────────────────────────────────────
// Weight artifact (Req 3, Req 4)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A versioned linear-probe weight snapshot (Req 4). Inference is a pure TS
 * dot-product + sigmoid — no model graph execution needed for a linear layer.
 */
export interface GateWeightArtifact {
  /** Which head this artifact belongs to. */
  kind: 'react-gate' | 'importance-head';
  /** Monotonic head version — bumped on every retrain/committed dream update. */
  headVersion: number;
  /** The feature schema this artifact was trained against (fail-open on mismatch). */
  featureSchemaVersion: number;
  /** Bias term b. */
  bias: number;
  /** Scalar-feature weights, keyed by the ordered contract fields. */
  scalarWeights: Record<string, number>;
  /**
   * Embedding weights (same dimensionality as the provider's output).
   * `undefined`/`null` = scalar-only head (embedding contributes 0).
   */
  embeddingWeights?: number[] | null;
  /** ISO timestamp of training (audit metadata). */
  trainedAt?: string;
  /** Trainer identifier (e.g. "training/train_react_gate.py ridge λ=0.1"). */
  source?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Gate decision + ports (Req 5, 6, 7)
// ─────────────────────────────────────────────────────────────────────────────

/** The hard-positive triggers (Req 5): force a cycle regardless of `p(react)`. */
export interface HardTriggerFlags {
  /** Incoming agent message pending. */
  messagePending: boolean;
  /** Conversation invite (a live conversation the agent may join). */
  conversationInvite: boolean;
  /** Nearby object mutation (object state change in the agent's room). */
  nearbyObjectMutation: boolean;
  /** Drive threshold crossing since the last completed cycle. */
  driveThresholdCrossing: boolean;
}

/** All hard triggers false. */
export const NO_HARD_TRIGGERS: HardTriggerFlags = {
  messagePending: false,
  conversationInvite: false,
  nearbyObjectMutation: false,
  driveThresholdCrossing: false,
};

/** Any hard trigger set? */
export function hasHardTrigger(flags: HardTriggerFlags): boolean {
  return (
    flags.messagePending ||
    flags.conversationInvite ||
    flags.nearbyObjectMutation ||
    flags.driveThresholdCrossing
  );
}

/** The outcome of one System 1 gate evaluation (Req 7). */
export interface ReactGateDecision {
  /** `p(react) = σ(W·x + b)` — 1 on fail-open. */
  pReact: number;
  /** Cycle this tick? `p(react) >= threshold` OR a hard trigger OR fail-open. */
  react: boolean;
  /** A hard trigger fired (forces react, and forces a REACT label — Req 9). */
  hardTrigger: boolean;
  /** The head version that produced this decision (auditability, Req 4). */
  headVersion: number;
  /** True when the gate is fail-open (missing/corrupt/mismatched artifact). */
  failOpen: boolean;
}

/** Port (defined in `shared` per ADR-0001): the engine scheduler consults this
 * synchronously before `startCycle`. Implemented in cognition; wired at
 * assembly. Must never await — reads cached features only (Req 7). */
export interface System1GatePort {
  decide(agentId: string, hardTriggers: HardTriggerFlags): ReactGateDecision;
}

/** Port: engine-side hard-trigger extraction from live engine state. */
export interface System1TriggerSourcePort {
  getHardTriggers(agentId: string): HardTriggerFlags;
}

/** Port: synchronous read of the per-agent cached feature vector. */
export interface System1FeatureSourcePort {
  getFeatures(agentId: string): System1FeatureVector | null;
}

/** Port: feature-cache refresh (scalar part synchronous, embedding async). */
export interface System1FeatureRefresherPort {
  refreshScalars(agentId: string, snapshot: System1EngineSnapshot): void;
  refreshEmbedding(agentId: string, snapshot: System1EngineSnapshot): Promise<void>;
}

/** Port: the agent's K most recent memory embeddings (for novelty). */
export interface System1RecentMemoriesPort {
  getRecentMemoryEmbeddings(agentId: string, k: number): Promise<number[][]>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Outcome labeling + session log ports (Req 9)
// ─────────────────────────────────────────────────────────────────────────────

/** Which outcome signals fired during a completed cycle (Req 9). */
export interface OutcomeFlags {
  planChanged: boolean;
  drivesChanged: boolean;
  memoryWritten: boolean;
  conversationContinued: boolean;
}

/** A before/after state snapshot used by the outcome probe. */
export interface OutcomeSnapshot {
  planId: string | null;
  planStepIndex: number;
  drives: Record<string, number>;
  memoryCount: number;
  conversationTurns: number;
}

/** Port: capture the engine state needed for outcome labeling. */
export interface System1OutcomeProbePort {
  snapshot(agentId: string): Promise<OutcomeSnapshot>;
}

/** The context recorded at cycle start (decision + triggers + tick). */
export interface CycleStartContext {
  decision: ReactGateDecision;
  hardTriggers: HardTriggerFlags;
  tickNumber: number;
  simTime: number;
}

/** Port: outcome labeling lifecycle hooks driven by the scheduler (Req 7/9). */
export interface System1OutcomeRecorderPort {
  onCycleStart(agentId: string, ctx: CycleStartContext): void;
  onCycleSettled(agentId: string, error?: string): void;
}

/**
 * One labeled training sample (Req 9). Appended as one JSONL line per cycle;
 * the JSON key order below is the serialization contract for the trainer.
 */
export interface CycleOutcomeSample {
  schemaVersion: number;
  headVersion: number;
  agentId: string;
  tickNumber: number;
  simTime: number;
  label: 'react' | 'ignore';
  hardTrigger: boolean;
  pReact: number;
  outcome?: OutcomeFlags;
  scalar: ScalarFeatures | null;
  embedding: number[] | null;
}

/** Port: the per-agent JSONL session-log sink. */
export interface System1SampleSinkPort {
  append(sample: CycleOutcomeSample): void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Dream update (Req 11, 12) + identity trigger port (Req 16, 17)
// ─────────────────────────────────────────────────────────────────────────────

/** Dream-update guardrail config (Req 12): bounded steps + LR cap + tolerance. */
export interface DreamUpdateConfig {
  /** Per-sample learning rate for `W += lr · (p − y) · x`. */
  learningRate: number;
  /** Hard cap on the learning rate (guardrail). */
  maxLearningRate: number;
  /** Hard cap on update steps per dream (guardrail, ≤200). */
  maxSteps: number;
  /** Fraction of samples reserved as the validation holdout. */
  holdoutFraction: number;
  /** Allowed holdout-loss increase before a revert (guardrail). */
  lossTolerance: number;
}

/** Default dream-update config (spec 035, Req 12). */
export function defaultDreamUpdateConfig(): DreamUpdateConfig {
  return {
    learningRate: 0.05,
    maxLearningRate: 0.1,
    maxSteps: 200,
    holdoutFraction: 0.2,
    lossTolerance: 0.01,
  };
}

/** The audited `dream_update` event (Req 12). */
export interface DreamUpdateEvent {
  type: 'dream_update';
  /** Total samples considered (0 when the schema contract blocked the update). */
  sampleCount: number;
  /** Samples the update steps ran on (≤ maxSteps). */
  trainCount: number;
  /** Holdout samples used for the revert guardrail. */
  holdoutCount: number;
  /** Holdout BCE loss before the update. */
  lossBefore: number;
  /** Holdout BCE loss after the update (== lossBefore when reverted). */
  lossAfter: number;
  /** Head version after the dream (== headVersionBefore when reverted). */
  headVersion: number;
  /** Head version before the dream. */
  headVersionBefore: number;
  /** True when the guardrail restored the previous snapshot. */
  reverted: boolean;
  featureSchemaVersion: number;
}

/** Port: per-tick identity-hook trigger (mid-session consolidation, Req 17). */
export interface System1IdentityTriggerPort {
  tick(agentId: string): void;
}