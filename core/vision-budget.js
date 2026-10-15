'use strict';

const { readImageMetadata } = require('./image-metadata');

const UNKNOWN_IMAGE_TOKENS = 16384;
const DIMENSION_LIMIT = 8192;
const ASPECT_RATIO_LIMIT = 8;
const DETAILS = new Set(['auto', 'low', 'high']);

// Dimension arithmetic follows the published processors, with deployment
// measurements recorded in docs/TOKEN-BUDGET.md. No pixel decoding is needed.
// DeepSeek reference revision: 5254448103b6254fc646dacbca1cbbf20e9216c1.
// Derived from its MIT-licensed image_processor.py; see THIRD-PARTY-NOTICES.md.
function deepseekImageTokens(width, height) {
  const patch = 14, downsample = 3, minPixels = 295936, maxTokens = 1024;
  if (width * height < minPixels) {
    const ratio = Math.sqrt(minPixels / (width * height));
    width = Math.trunc(width * ratio);
    height = Math.trunc(height * ratio);
  }
  let bestWidth = Math.ceil(width / patch) * patch;
  let bestHeight = Math.ceil(height / patch) * patch;
  const grid = () => [Math.ceil(Math.floor(bestHeight / patch) / downsample),
    Math.ceil(Math.floor(bestWidth / patch) / downsample)];
  let [rows, columns] = grid();
  if (rows * (columns + 1) + 2 > maxTokens) {
    const aspect = height / width;
    const maxWidth = Math.sqrt((maxTokens - 2) / aspect + 0.25) - 0.5;
    const maxHeight = maxWidth * aspect;
    const cell = patch * downsample;
    const scale = Math.min(Math.floor(maxWidth) * cell / width,
      Math.floor(maxHeight) * cell / height);
    bestHeight = Math.floor(height * scale / patch) * patch;
    bestWidth = Math.floor(width * scale / patch) * patch;
    [rows, columns] = grid();
  }
  // Per-row newline plus the image's start/end markers.
  return rows * (columns + 1) + 2;
}

// Python's round() uses ties to even; Math.round() would differ at e.g. 528px.
function roundEven(value) {
  const lower = Math.floor(value);
  return value - lower === 0.5 ? lower + (lower % 2) : Math.round(value);
}

function qwenImageTokens(width, height) {
  const factor = 32, minPixels = 65536, maxPixels = 16777216;
  let columns = roundEven(width / factor), rows = roundEven(height / factor);
  const roundedArea = rows * columns * factor ** 2;
  if (roundedArea > maxPixels) {
    const scale = Math.sqrt(height * width / maxPixels);
    rows = Math.floor(height / scale / factor);
    columns = Math.floor(width / scale / factor);
  } else if (roundedArea < minPixels) {
    const scale = Math.sqrt(minPixels / (height * width));
    // Preserve the operation order: 239px gives 8.000000000000002, hence 9.
    rows = Math.ceil(height * scale / factor);
    columns = Math.ceil(width * scale / factor);
  }
  return rows * columns + 2; // Image start/end markers accompany the patches.
}

function dimensionEstimate(model, detail, metadata) {
  if (!metadata || (detail !== undefined && !DETAILS.has(detail))) return null;
  let { width, height } = metadata;
  if (width > DIMENSION_LIMIT || height > DIMENSION_LIMIT ||
      Math.max(width, height) / Math.min(width, height) > ASPECT_RATIO_LIMIT) return null;
  if (model === 'DeepSeek-V4.1-Flash') {
    return { tokens: deepseekImageTokens(width, height), margin: 8 };
  }
  if (model === 'qwen3.8-27b') {
    return { tokens: qwenImageTokens(width, height), margin: 8 };
  }
  return null;
}

// Stateless: inspect bounded headers only, without hashing complete images,
// retaining payloads, fetching URLs, or learning from previous requests.
function estimateVisionBudget(payload) {
  const result = { imageCount: 0, imageTokensEstimate: 0, imageMarginTokens: 0,
    dimensionImageCount: 0, unknownImageCount: 0, imageEstimateSource: 'none' };
  for (const message of Array.isArray(payload?.messages) ? payload.messages : []) {
    for (const part of Array.isArray(message?.content) ? message.content : []) {
      if (part?.type !== 'image_url') continue;
      result.imageCount++;
      const metadata = readImageMetadata(part.image_url?.url);
      const estimate = dimensionEstimate(payload.model, part.image_url?.detail, metadata);
      if (estimate) {
        result.dimensionImageCount++;
        result.imageTokensEstimate += estimate.tokens;
        result.imageMarginTokens += estimate.margin;
      } else {
        result.unknownImageCount++;
        result.imageTokensEstimate += UNKNOWN_IMAGE_TOKENS;
      }
    }
  }
  if (result.imageCount) {
    result.imageEstimateSource = result.unknownImageCount === 0 ? 'dimensions'
      : result.dimensionImageCount === 0 ? 'heuristic' : 'mixed';
  }
  return result;
}

module.exports = { estimateVisionBudget, UNKNOWN_IMAGE_TOKENS };
