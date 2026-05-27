/**
 * Reframe tier state management.
 */

import type { ReframeTier, SupervisorState } from '../types.js';

const MAX_TIER: ReframeTier = 4;

/** Get the current reframe tier from state */
export function getReframeTier(state: SupervisorState | null): ReframeTier {
  return state?.reframeTier ?? 0;
}

/** Escalate reframe tier in state */
export function escalateReframeTier(state: SupervisorState): boolean {
  const current = state.reframeTier ?? 0;
  if (current < MAX_TIER) {
    state.reframeTier = (current + 1) as ReframeTier;
    return true;
  }
  return false;
}

/** Reset reframe tier to 0 */
export function resetReframeTier(state: SupervisorState): void {
  state.reframeTier = 0;
}
