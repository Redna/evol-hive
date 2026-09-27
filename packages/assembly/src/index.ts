// ─────────────────────────────────────────────────────────────────────────────
// evol-hive / assembly — the composition root (spec 050)
// ─────────────────────────────────────────────────────────────────────────────
// The only package allowed to depend on both @evol-hive/engine and
// @evol-hive/cognition (ADR-0001). Exports the promoted assembler.
export {
  assembleWorld,
  assembleCognitionStack,
  assembleSystem1,
  buildMemorySubsystem,
  MockOrchestrator,
  MockEmbeddingProvider,
} from './assembly.js';
export type {
  AssembleWorldOptions,
  AssembledWorld,
  AssembleCognitionStackOptions,
  CognitionStack,
  MemorySubsystem,
  System1AssemblyOptions,
  System1Assembled,
} from './assembly.js';
// Spec 067 (R1/R4): the sample-sink decision as data — a spending run can never
// select the in-memory sink, and a cheap run never writes files by default.
export { DEFAULT_SESSION_LOG_DIR, resolveSampleSink } from './sample-sink.js';
export type { SampleSinkConfig, SampleSinkDecision, SampleSinkKind } from './sample-sink.js';
