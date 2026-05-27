/**
 * Main analyzer - orchestrates supervisor analysis using compaction-based context.
 */

import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { SteeringDecision, SupervisorState } from '../types.js';
import { callSupervisorModel } from '../session/client.js';
import { loadSystemPrompt } from './prompt-loader.js';
import {
  buildCompactionSummary,
  extractMessages,
  formatForSupervisor,
} from '../compaction/index.js';
import { buildUserPrompt } from './prompt-builder.js';

/**
 * Analyze the current conversation and return a steering decision.
 * Falls back to { action: "steer" } when the agent is idle to prevent it from staying stuck.
 */
export async function analyze(
  ctx: ExtensionContext,
  state: SupervisorState,
  agentIsIdle: boolean,
  ineffectivePattern?: { detected: boolean; similarCount: number; secondsSinceLastSteer: number },
  signal?: AbortSignal,
  onDelta?: (accumulated: string) => void
): Promise<SteeringDecision> {
  const { prompt: systemPrompt } = loadSystemPrompt(ctx.cwd);

  // Build structured compaction summary from current branch
  const messages = extractMessages(ctx);
  const summary = buildCompactionSummary(messages);
  const contextText = formatForSupervisor(summary);

  const userPrompt = buildUserPrompt(state, contextText, agentIsIdle, ineffectivePattern);

  try {
    return await callSupervisorModel(
      ctx,
      state.provider,
      state.modelId,
      systemPrompt,
      userPrompt,
      signal,
      onDelta
    );
  } catch {
    // When idle and analysis fails, nudge rather than silently do nothing
    return agentIsIdle
      ? {
          action: 'steer',
          message: 'Please continue working toward the goal.',
          reasoning: 'Analysis error',
          confidence: 0,
        }
      : { action: 'continue', reasoning: 'Analysis error', confidence: 0 };
  }
}
