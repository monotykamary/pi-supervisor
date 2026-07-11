/**
 * Outcome inference from conversation history.
 */

import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { SupervisorSession } from '../session/supervisor-session.js';
import {
  extractMessages,
  buildCompactionSummary,
  formatForSupervisor,
} from '../compaction/index.js';

/** System prompt for inferring an outcome from conversation history. */
const INFER_OUTCOME_SYSTEM_PROMPT = `You are a goal extraction assistant. Your task is to analyze a conversation between a user and a coding AI assistant, and extract the user's primary desired outcome or goal.

The outcome should be:
- Specific and measurable (not vague like "make it better")
- Action-oriented (what needs to be built, fixed, or achieved)
- Concise (1-2 sentences, ideally under 100 characters)
- Focused on the core intent, not implementation details

Examples of good outcomes:
- "Add JWT authentication with refresh tokens and test coverage"
- "Refactor the database layer to use connection pooling"
- "Fix the memory leak in the file upload handler"
- "Implement dark mode toggle with system preference detection"

Respond with ONLY the outcome statement. No quotes, no markdown, no explanations.`;

/**
 * Infer a supervision outcome from the conversation history.
 * Uses the compaction pipeline to build a structured summary for inference.
 */
export async function inferOutcome(
  ctx: ExtensionContext,
  provider: string,
  modelId: string,
  signal?: AbortSignal
): Promise<string | null> {
  const messages = extractMessages(ctx);
  if (messages.length === 0) return null;

  // Use the compaction pipeline for structured context (avoids cold prefills)
  const summary = buildCompactionSummary(messages);
  const contextText = formatForSupervisor(summary);

  if (!contextText) return null;

  const userPrompt = `Analyze this conversation summary and extract the user's primary goal or desired outcome:

${contextText}

What is the specific outcome the user is trying to achieve?`;

  try {
    const session = new SupervisorSession();
    const started = await session.ensureStarted(
      ctx,
      provider,
      modelId,
      INFER_OUTCOME_SYSTEM_PROMPT
    );
    if (!started) return null;

    const result = await session.prompt(userPrompt, signal);
    session.dispose();

    if (!result) return null;
    return result
      .replace(/^["']|["']$/g, '')
      .replace(/\n/g, ' ')
      .trim()
      .slice(0, 200);
  } catch {
    return null;
  }
}
