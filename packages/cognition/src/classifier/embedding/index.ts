// embedding/ — Embedding model integration (Model2Vec, ONNX, Ollama)
// ────────────────────────────────────────────────────────────────────
// Spec 007: Concrete `OnnxEmbeddingProvider` backed by ONNX Runtime.

export {
  OnnxEmbeddingProvider,
  EmbeddingModelError,
  type OnnxEmbeddingProviderConfig,
  type OnnxSession,
  type Tokenizer,
  type MockOnnxSession,
  type MockTokenizer,
} from './onnx-provider.js';
