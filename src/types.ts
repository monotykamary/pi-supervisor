/**
 * Core types for the pi-supervisor extension.
 */

export type SupervisorAction = "continue" | "steer" | "done";

/** A single intervention record */
export interface SupervisorIntervention {
  turnCount: number;
  message: string;
  reasoning: string;
  timestamp: number;
}

/** Full supervisor state — persisted to session */
export interface SupervisorState {
  active: boolean;
  outcome: string;
  provider: string;          // e.g. "anthropic"
  modelId: string;           // e.g. "claude-haiku-4-5-20251001"
  interventions: SupervisorIntervention[];
  startedAt: number;
  turnCount: number;
  // Incremental snapshot buffer (not persisted, rebuilt on load)
  snapshotBuffer?: ConversationMessage[];
  lastAnalyzedTurn?: number;
  justSteered?: boolean;     // flag to check if steer worked
}

/** Decision returned by the supervisor LLM */
export interface SteeringDecision {
  action: SupervisorAction;
  message?: string;
  reasoning: string;
  confidence: number;
}

/** A simplified message for building the supervisor context */
export interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
}
