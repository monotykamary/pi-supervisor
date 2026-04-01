/**
 * SupervisorStateManager — manages in-memory supervisor state (backward compatibility export).
 *
 * This file now re-exports from the modularized state/ directory.
 * New code should import directly from state/ modules.
 *
 * @deprecated Import from src/state/manager.js directly for new code.
 */

export { SupervisorStateManager, DEFAULT_PROVIDER, DEFAULT_MODEL_ID } from './state/manager.js';
