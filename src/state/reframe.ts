/**
 * Reframe tier state management.
 */

import type { ReframeTier, SupervisorState } from '../types.js';

/** Maximum reframe tier value */
export const MAX_REFRAME_TIER: ReframeTier = 4;

/** Get the current reframe tier from state */
export function getReframeTier(state: SupervisorState | null): ReframeTier {
  return state?.reframeTier ?? 0;
}

/** Check if tier can be escalated further */
export function canEscalate(tier: ReframeTier): boolean {
  return tier < MAX_REFRAME_TIER;
}

/** Get next tier value */
export function getNextTier(tier: ReframeTier): ReframeTier {
  return Math.min(tier + 1, MAX_REFRAME_TIER) as ReframeTier;
}

/** Escalate reframe tier in state */
export function escalateReframeTier(state: SupervisorState): boolean {
  const current = state.reframeTier ?? 0;
  if (current < MAX_REFRAME_TIER) {
    state.reframeTier = getNextTier(current);
    return true;
  }
  return false;
}

/** Reset reframe tier to 0 */
export function resetReframeTier(state: SupervisorState): void {
  state.reframeTier = 0;
}
