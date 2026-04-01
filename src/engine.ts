/**
 * engine — supervisor analysis logic (backward compatibility export).
 *
 * This file now re-exports from the modularized core/ directory.
 * New code should import directly from core/ modules.
 *
 * @deprecated Import from src/core/ modules directly for new code.
 */

// Core analysis
export { analyze } from './core/analyzer.js';

// Snapshot building
export {
  SNAPSHOT_LIMIT,
  buildIncrementalSnapshot,
  updateSnapshot,
} from './core/snapshot-builder.js';

// Prompt building
export { buildUserPrompt } from './core/prompt-builder.js';

// Prompt loading
export { loadSystemPrompt } from './core/prompt-loader.js';

// Inference
export { inferOutcome } from './core/inference.js';

// Reframe
export { getReframeGuidance } from './core/reframe.js';

// Content extraction
export { extractMetrics } from './core/content-extractor.js';
