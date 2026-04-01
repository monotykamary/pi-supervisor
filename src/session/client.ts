/**
 * Session client - high-level interface for calling the supervisor model.
 */

import type { ExtensionContext } from '@mariozechner/pi-coding-agent';
import type { SteeringDecision } from '../types.js';
import { SupervisorSession } from './supervisor-session.js';
import { parseDecision, safeContinue } from './response-parser.js';

// Global session manager (one per supervision goal)
let activeSession: SupervisorSession | null = null;

/** Get or create the global supervisor session. */
export function getOrCreateSession(): SupervisorSession {
  if (!activeSession) {
    activeSession = new SupervisorSession();
  }
  return activeSession;
}

/** Dispose the global supervisor session. */
export function disposeSession(): void {
  activeSession?.dispose();
  activeSession = null;
}

/**
 * Run a one-shot supervisor analysis using reusable session.
 * Returns { action: "continue" } on any failure so the chat is never interrupted.
 */
export async function callSupervisorModel(
  ctx: ExtensionContext,
  provider: string,
  modelId: string,
  systemPrompt: string,
  userPrompt: string,
  signal?: AbortSignal,
  onDelta?: (accumulated: string) => void
): Promise<SteeringDecision> {
  const session = getOrCreateSession();
  const started = await session.ensureStarted(ctx, provider, modelId, systemPrompt);
  if (!started) return safeContinue('Failed to start supervisor session');

  const text = await session.prompt(userPrompt, signal, onDelta);
  if (text === null) return safeContinue('Model call failed');
  return parseDecision(text);
}

export { SupervisorSession };
