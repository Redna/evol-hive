/**
 * system1/ — System 1 trainable heads (spec 035, issue #132)
 * ────────────────────────────────────────────────────────────────────────────
 * Feature extractor plumbing, React/Ignore linear-probe gate, importance
 * head + composite importance, session sample logging, dream-time updates,
 * and the salience-weighted identity hook.
 */

// Re-export the shared feature-schema contract and pure scalar math (Req 1/2):
// the schema contract lives in `shared`; the cognition extractor consumes it
// and adds the embedding-driven assembly below.
export {
  FEATURE_SCHEMA_VERSION,
  SCALAR_FEATURE_FIELDS,
  cosine,
  computeNovelty,
  computeDriveDeltas,
  detectThresholdCrossings,
  extractScalarFeatures,
  scalarToVector,
  buildFeatureVector,
  validateScalarFeatures,
  defaultSystem1GateConfig,
  defaultDreamUpdateConfig,
  DEFAULT_DRIVE_THRESHOLDS,
} from '@evol-hive/shared';

export {
  sigmoid,
  dotProduct,
  evaluateLinearProbe,
  decideWithArtifact,
  ReactGateHead,
  makeFeatureArtifactLoader,
  makeFileArtifactLoader,
  type ArtifactLoader,
} from './react-gate.js';

export { System1GateServiceImpl, type System1GateServiceOptions } from './gate-service.js';

export {
  LinearImportanceHead,
  NEUTRAL_IMPORTANCE_PRIOR,
  type LinearImportanceHeadOptions,
} from './importance-head.js';

export {
  composeImportance,
  driveDeltaMagnitude,
  DownstreamUtilityTracker,
  CompositeImportanceComposer,
  IMPORTANCE_COMPOSITION_WEIGHTS,
  UTILITY_RETRIEVAL_WEIGHT,
  UTILITY_PLAN_SUCCESS_WEIGHT,
  type ImportanceCompositionInputs,
  type DownstreamUtilityStats,
  type CompositeImportanceContext,
} from './composite-importance.js';

export {
  JsonlSessionSampleLog,
  InMemorySampleLogWriter,
  makeFileSampleLogWriter,
  serializeSample,
  type SampleLogWriter,
} from './session-log.js';

export { applyDreamUpdate, binaryCrossEntropy, type DreamUpdateResult } from './dream-update.js';

export {
  SalienceWeightedIdentityService,
  SalienceAccumulator,
  computeSalienceNorm,
  defaultSalienceConfig,
  type SalienceConfig,
  type SalienceIdentityServiceOptions,
} from './identity-salience.js';

export { System1FeatureServiceImpl, type System1FeatureServiceOptions } from './feature-service.js';
