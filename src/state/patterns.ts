/**
 * Pattern detection for ineffective steering interventions.
 * Uses timestamps from intervention records instead of turn counting.
 */

import type { SupervisorIntervention, SupervisorState } from '../types.js';

export interface IneffectivePattern {
  detected: boolean;
  similarCount: number;
  secondsSinceLastSteer: number;
}

/** Stagnation threshold: no steer in this many seconds suggests ineffectiveness */
const STAGNATION_SECS = 60;

/**
 * Detect if recent interventions show a pattern of ineffectiveness.
 * Returns similarity info if the last 2+ steering messages are similar,
 * or if stagnation is detected (no new steer in a while despite active supervision).
 */
export function detectIneffectivePattern(
  state: Pick<SupervisorState, 'interventions' | 'startedAt'>
): IneffectivePattern {
  const now = Date.now();
  const lastSteerTs =
    state.interventions.length > 0
      ? state.interventions[state.interventions.length - 1].timestamp
      : state.startedAt;
  const secondsSinceLastSteer = Math.round((now - lastSteerTs) / 1000);

  // Stagnation: no new steer action in a while
  const stagnating = secondsSinceLastSteer >= STAGNATION_SECS;

  const recent = state.interventions.slice(-3);
  if (recent.length < 2) {
    return { detected: stagnating, similarCount: recent.length, secondsSinceLastSteer };
  }

  const messages = recent.map((iv) => iv.message.toLowerCase());
  let similarCount = 1;

  for (let i = 1; i < messages.length; i++) {
    if (areMessagesSimilar(messages[i - 1], messages[i])) {
      similarCount++;
    }
  }

  const detected = similarCount >= 2 || stagnating;

  return { detected, similarCount, secondsSinceLastSteer };
}

function areMessagesSimilar(a: string, b: string): boolean {
  const normalize = (s: string) => s.replace(/[^\w\s]/g, '').trim();
  const normA = normalize(a);
  const normB = normalize(b);

  if (normA === normB) return true;

  const directiveWords = [
    'focus',
    'implement',
    'add',
    'fix',
    'create',
    'build',
    'need',
    'should',
    'must',
  ];
  const aDirectives = directiveWords.filter((w) => normA.includes(w));
  const bDirectives = directiveWords.filter((w) => normB.includes(w));

  const commonDirectives = aDirectives.filter((w) => bDirectives.includes(w));
  if (commonDirectives.length >= 2) return true;

  const lenRatio = Math.min(normA.length, normB.length) / Math.max(normA.length, normB.length);
  if (lenRatio > 0.7 && commonDirectives.length >= 1) return true;

  return false;
}
