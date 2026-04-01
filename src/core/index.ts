/**
 * Core analysis module exports.
 *
 * This module contains the supervisor's core analysis logic:
 * - Prompt loading and building
 * - Snapshot construction from conversation history
 * - Content extraction and metrics
 * - LLM inference and outcome detection
 * - Steering decision analysis
 */

// Analysis orchestration
export { analyze } from './analyzer.js';

// Prompt management
export { loadSystemPrompt } from './prompt-loader.js';
export { buildUserPrompt } from './prompt-builder.js';

// Snapshot building
export { SNAPSHOT_LIMIT, buildIncrementalSnapshot, updateSnapshot } from './snapshot-builder.js';

// Content extraction
export {
  extractAllBlocks,
  extractText,
  extractAssistantText,
  blocksToString,
  extractMetrics,
  createToolResultEntry,
} from './content-extractor.js';

// Reframe tier management
export { getReframeGuidance, MAX_REFRAME_TIER, canEscalate, getNextTier } from './reframe.js';

// Outcome inference
export { inferOutcome } from './inference.js';
