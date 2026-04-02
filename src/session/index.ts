/**
 * Session management module exports.
 *
 * This module contains LLM session management:
 * - Reusable supervisor session for token efficiency
 * - Response parsing and decision extraction
 * - High-level client interface
 */

export { SupervisorSession } from './supervisor-session.js';
export { parseDecision } from './response-parser.js';
export { callSupervisorModel, getOrCreateSession, disposeSession } from './client.js';
