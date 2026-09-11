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
