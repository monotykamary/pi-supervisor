/**
 * Outcome inference from conversation history.
 */

import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { SupervisorSession } from '../session/supervisor-session.js';
import { extractMessages } from '../compaction/index.js';
import { normalize } from '../compaction/normalize.js';
import { filterNoise } from '../compaction/filter-noise.js';
import { buildBriefSections, stringifyBrief } from '../compaction/brief.js';

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

  // Build a brief transcript for the inference prompt
  const blocks = filterNoise(normalize(messages));
  const sections = buildBriefSections(blocks);
  const briefText = stringifyBrief(sections);

  if (!briefText) return null;

  // Take last portion of the brief for context (keep it focused)
  const lines = briefText.split('\n');
  const recentLines = lines.slice(-40);
  const conversationText = recentLines.join('\n');

  const userPrompt = `Analyze this conversation and extract the user's primary goal or desired outcome:

${conversationText}

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
