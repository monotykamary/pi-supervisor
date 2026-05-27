/**
 * Prompt builder - constructs user prompts for the supervisor LLM
 * using structured compaction output instead of raw message dumps.
 */

import type { SupervisorState, SupervisorIntervention } from '../types.js';
import { getReframeGuidance } from './reframe.js';

/** Build the user-facing prompt for the supervisor LLM. */
export function buildUserPrompt(
  state: SupervisorState,
  contextText: string,
  agentIsIdle: boolean,
  ineffectivePattern?: { detected: boolean; similarCount: number; secondsSinceLastSteer: number }
): string {
  // Build intervention history with full ASI display
  const interventionHistory =
    state.interventions.length === 0
      ? 'None yet.'
      : state.interventions
          .slice(-5)
          .map((iv, i) => {
            let entry = `[${i + 1}] "${iv.message}"`;

            if (iv.asi && Object.keys(iv.asi).length > 0) {
              const asiEntries = Object.entries(iv.asi)
                .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
                .join(', ');
              entry += `\n    ASI {${asiEntries}}`;
            }
            return entry;
          })
          .join('\n');

  // Build ASI pattern summary for loop closing
  const asiSummary = buildASISummary(state.interventions);

  const agentStatus = agentIsIdle
    ? `AGENT STATUS: IDLE — the agent has finished its turn and is now waiting for user input.
You MUST return "done" or "steer". Returning "continue" here means the agent stays idle forever.`
    : `AGENT STATUS: WORKING — the agent is actively processing. Only intervene if clearly off track.`;

  const reframeGuidance = getReframeGuidance(state.reframeTier ?? 0, ineffectivePattern);
  const reframeSection = reframeGuidance ? `\n${reframeGuidance}\n` : '';

  const contextBlock = contextText
    ? `STRUCTURED CONVERSATION CONTEXT:\n${contextText}`
    : '(No conversation context available)';

  return `DESIRED OUTCOME:
${state.outcome}

${agentStatus}${reframeSection}

${contextBlock}

YOUR INTERVENTION HISTORY (with ASI observations):
${interventionHistory}

${asiSummary}
REMINDER — DESIRED OUTCOME:
${state.outcome}

Has this outcome been fully achieved? Analyze and respond with JSON only.`;
}

/** Build summary of ASI patterns to close the loop */
function buildASISummary(interventions: SupervisorIntervention[]): string {
  if (interventions.length === 0) return '';

  const patterns: string[] = [];
  const recent = interventions.slice(-5);

  const keyFrequency: Record<string, number> = {};
  for (const iv of recent) {
    if (!iv.asi) continue;
    for (const key of Object.keys(iv.asi)) {
      keyFrequency[key] = (keyFrequency[key] || 0) + 1;
    }
  }

  for (const [key, count] of Object.entries(keyFrequency)) {
    if (count >= 2) {
      patterns.push(`Pattern seen ${count}x: "${key}"`);
    }
  }

  const allValues = recent
    .filter((iv) => iv.asi)
    .flatMap((iv) => Object.values(iv.asi!))
    .map((v) => String(v).toLowerCase());

  const suspiciousIndicators = [
    'unverified',
    'contradict',
    'suspicious',
    'fake',
    'skip',
    'manipulat',
    'cheat',
    'gaming',
    'short-circuit',
  ];

  const hasSuspicious = suspiciousIndicators.some((indicator) =>
    allValues.some((v) => v.includes(indicator))
  );

  if (hasSuspicious) {
    patterns.push(
      '⚠️ Previous interventions flagged suspicious claims — require explicit proof before accepting "done"'
    );
  }

  const verificationFailures = interventions.filter(
    (iv) =>
      iv.asi &&
      Object.entries(iv.asi).some(
        ([k, v]) =>
          String(v).toLowerCase().includes('contradict') ||
          String(v).toLowerCase().includes('unverified')
      )
  ).length;

  if (verificationFailures >= 2) {
    patterns.push(
      `⚠️ ${verificationFailures} interventions involved unverified/contradicted claims — agent has pattern of unreliable reporting`
    );
  }

  if (patterns.length === 0) return '';

  return `ASI PATTERN SUMMARY (use this to inform your decision):
${patterns.map((p) => `- ${p}`).join('\n')}

`;
}
