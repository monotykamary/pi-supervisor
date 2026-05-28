/**
 * Core types for the pi-supervisor extension.
 */

/** A single intervention record */
export interface SupervisorIntervention {
  message: string;
  reasoning: string;
  timestamp: number;
  asi?: InterventionASI;
}

/** Reframe tier tracks escalation of intervention strategies */
export type ReframeTier = 0 | 1 | 2 | 3 | 4;

/** Actionable Side Information — free-form observations from interventions */
export interface InterventionASI {
  [key: string]: unknown;
}

/** Full supervisor state — persisted to session */
export interface SupervisorState {
  active: boolean;
  outcome: string;
  provider: string;
  modelId: string;
  interventions: SupervisorIntervention[];
  startedAt: number;
  reframeTier?: ReframeTier;
  /** Consecutive agent_end steers; reset on done/stop/new supervision */
  idleSteers?: number;
  /** Whether we just steered and should verify on next mid-run event */
  justSteered?: boolean;
}

/** Decision returned by the supervisor LLM */
export interface SteeringDecision {
  action: 'continue' | 'steer' | 'done';
  message?: string;
  reasoning: string;
  confidence: number;
  asi?: InterventionASI;
}
