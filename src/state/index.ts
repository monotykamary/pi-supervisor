/**
 * State management module exports.
 *
 * This module contains supervisor state management:
 * - State manager for persistence and lifecycle
 * - Reframe tier escalation logic
 * - Ineffective pattern detection
 */

export { SupervisorStateManager, DEFAULT_PROVIDER, DEFAULT_MODEL_ID } from './manager.js';
export {
  getReframeTier,
  escalateReframeTier,
  resetReframeTier,
  MAX_REFRAME_TIER,
} from './reframe.js';
export { detectIneffectivePattern, type IneffectivePattern } from './patterns.js';
