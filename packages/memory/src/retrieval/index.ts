// retrieval/ — Weighted retrieval scoring, decay service, dual-track injection
// (Section 11 / spec 014).

export {
  RetrievalEngineImpl,
  type RetrievalEngineOptions,
  type RetrievalResult,
} from './retrieval-engine.js';
export { MemoryDecayServiceImpl, type MemoryDecayServiceOptions } from './memory-decay-service.js';
export { MemoryInjectorImpl, type MemoryInjectorOptions } from './memory-injector.js';
