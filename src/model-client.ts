/**
 * model-client — calls the supervisor LLM (backward compatibility export).
 *
 * This file now re-exports from the modularized session/ directory.
 * New code should import directly from session/ modules.
 *
 * @deprecated Import from src/session/ modules directly for new code.
 */

// Session management
export { SupervisorSession } from './session/supervisor-session.js';

// Client functions
export { callSupervisorModel, getOrCreateSession, disposeSession } from './session/client.js';

// Response parsing
export { parseDecision } from './session/response-parser.js';
