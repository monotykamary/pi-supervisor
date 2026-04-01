/**
 * Core types for the pi-supervisor extension.
 */

export type SupervisorAction = 'continue' | 'steer' | 'done';

/** A single intervention record */
export interface SupervisorIntervention {
  turnCount: number;
  message: string;
  reasoning: string;
  timestamp: number;
  /** Self-generated actionable side information */
  asi?: InterventionASI;
}

/** Reframe tier tracks escalation of intervention strategies */
export type ReframeTier = 0 | 1 | 2 | 3 | 4;

/** Actionable Side Information — self-generated diagnostics per intervention */
export interface InterventionASI {
  /** Why the agent was stuck or needed steering */
  why_stuck?: string;
  /** What strategy was used (directive, subgoal, pivot, etc.) */
  strategy_used?: string;
  /** Pattern detected in agent behavior */
  pattern_detected?: string;
  /** What signals indicated this was needed */
  confidence_source?: string;
  /** Whether to escalate sooner next time */
  would_escalate_sooner?: boolean;
  /** Time to progress after this intervention */
  time_to_progress?: number;
  /** Free-form additional observations */
  [key: string]: unknown;
}

/** Full supervisor state — persisted to session */
export interface SupervisorState {
  active: boolean;
  outcome: string;
  provider: string; // e.g. "anthropic"
  modelId: string; // e.g. "claude-haiku-4-5-20251001"
  interventions: SupervisorIntervention[];
  startedAt: number;
  turnCount: number;
  // Incremental snapshot buffer (not persisted, rebuilt on load)
  snapshotBuffer?: ConversationMessage[];
  lastAnalyzedTurn?: number;
  justSteered?: boolean; // flag to check if steer worked
  // Reframe escalation tracking
  reframeTier?: ReframeTier;
  lastSteerTurn?: number; // track when we last steered to detect ineffectiveness
}

/** Decision returned by the supervisor LLM */
export interface SteeringDecision {
  action: SupervisorAction;
  message?: string;
  reasoning: string;
  confidence: number;
  /** Self-generated actionable side information when steering */
  asi?: InterventionASI;
}

/** A simplified message for building the supervisor context */
export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
}
