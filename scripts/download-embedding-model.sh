#!/usr/bin/env bash
#
# download-embedding-model.sh — Downloads the gte-small ONNX model + tokenizer
# ───────────────────────────────────────────────────────────────────────────
# Spec 007, Req 21: The ONNX model and tokenizer files are NOT committed to the
# repository (too large for git). This script downloads them from HuggingFace Hub.
#
# Usage:
#   ./scripts/download-embedding-model.sh [output_dir]
#
# Defaults:
#   output_dir = models/gte-small
#   model repo = Xenova/gte-small (ONNX export of thenlper/gte-small)
#
# After downloading, set:
#   EMBEDDING_MODEL_PATH=$PWD/models/gte-small/onnx/model_quantized.onnx
#   EMBEDDING_TOKENIZER_PATH=$PWD/models/gte-small
#   USE_REAL_EMBEDDINGS=true

set -euo pipefail

OUTPUT_DIR="${1:-models/gte-small}"
REPO="Xenova/gte-small"
MODEL_FILE="onnx/model_quantized.onnx"
TOKENIZER_FILES=("tokenizer.json" "tokenizer_config.json" "special_tokens_map.json" "vocab.txt")

mkdir -p "$(dirname "$OUTPUT_DIR")"

echo "Downloading gte-small ONNX model + tokenizer to: $OUTPUT_DIR"
echo "Source repo: $REPO"
echo ""

# Download model file
MODEL_URL="https://huggingface.co/${REPO}/resolve/main/${MODEL_FILE}"
MODEL_OUTPUT="${OUTPUT_DIR}/onnx/model_quantized.onnx"
mkdir -p "${OUTPUT_DIR}/onnx"

echo "Downloading model: ${MODEL_URL}"
if command -v curl &> /dev/null; then
  curl -fSL "${MODEL_URL}" -o "${MODEL_OUTPUT}"
elif command -v wget &> /dev/null; then
  wget -q "${MODEL_URL}" -O "${MODEL_OUTPUT}"
else
  echo "Error: neither curl nor wget is available." >&2
  exit 1
fi
echo "  → Saved to ${MODEL_OUTPUT}"

# Download tokenizer files
for f in "${TOKENIZER_FILES[@]}"; do
  URL="https://huggingface.co/${REPO}/resolve/main/${f}"
  OUTPUT="${OUTPUT_DIR}/${f}"
  echo "Downloading tokenizer: ${URL}"
  if command -v curl &> /dev/null; then
    curl -fSL "${URL}" -o "${OUTPUT}" || echo "  → Skipping ${f} (not found, may be optional)"
  elif command -v wget &> /dev/null; then
    wget -q "${URL}" -O "${OUTPUT}" || echo "  → Skipping ${f} (not found, may be optional)"
  fi
done

echo ""
echo "✅ Download complete!"
echo ""
echo "To use the real embedding provider, set these environment variables:"
echo "  export EMBEDDING_MODEL_PATH=\"${PWD}/${MODEL_OUTPUT}\""
echo "  export EMBEDDING_TOKENIZER_PATH=\"${PWD}/${OUTPUT_DIR}\""
echo "  export USE_REAL_EMBEDDINGS=true"