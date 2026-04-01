/**
 * engine — supervisor analysis logic.
 *
 * Builds conversation snapshots incrementally from session history,
 * constructs prompts, and calls the supervisor model.
 *
 * System prompt discovery order (mirrors pi's SYSTEM.md convention):
 *   1. <cwd>/.pi/SUPERVISOR.md   — project-local
 *   2. ~/.pi/agent/SUPERVISOR.md — global
 *   3. Built-in template         — fallback
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { ExtensionContext } from '@mariozechner/pi-coding-agent';
import type {
  ConversationMessage,
  SteeringDecision,
  SupervisorState,
  InterventionASI,
} from './types.js';
import { callSupervisorModel } from './model-client.js';

// ---- System prompt loading ----

const SUPERVISOR_MD = 'SUPERVISOR.md';
const CONFIG_DIR = '.pi';
const GLOBAL_AGENT_DIR = join(homedir(), '.pi', 'agent');

/** Built-in fallback system prompt. */
const BUILTIN_SYSTEM_PROMPT = `You are a supervisor monitoring a coding AI assistant conversation.
Your job: ensure the assistant fully achieves a specific outcome without needing the human to intervene.

═══ WHEN THE AGENT IS IDLE (finished its turn, waiting for user input) ═══
This is your most important moment. The agent has stopped and is waiting.
You MUST choose "done" or "steer". Never return "continue" when the agent is idle.

- "done"  → only when the outcome is completely and verifiably achieved.
- "steer" → everything else: incomplete work, partial progress, open questions, waiting for confirmation.

If the agent asked a clarifying question or needs a decision:
  FIRST check: is this question necessary to achieve the goal?
  - YES (directly blocks goal progress): answer with a sensible default and tell agent to proceed.
  - NO (out of scope, nice-to-have, unrelated feature): do NOT answer it. Redirect:
    "That's outside the scope of the goal. Focus on: [restate the specific missing piece of the goal]."
  DO NOT answer: passwords, credentials, secrets, anything requiring real user knowledge.

Your steer message speaks AS the user. Make it clear, direct, and actionable (1–3 sentences).
Do not ask the agent to verify its own work — tell it what to do next.

═══ WHEN THE AGENT IS ACTIVELY WORKING (mid-turn) ═══
Only intervene if it is clearly heading in the wrong direction.
Trust the agent to complete what it has started. Avoid interrupting productive work.

═══ STEERING RULES ═══
- Be specific: reference the outcome, missing pieces, or the question being answered.
- Never repeat a steering message that had no effect — escalate or change approach.
- A good steer answers the agent's question OR redirects to the missing piece of the outcome.
- If the agent is taking shortcuts to satisfy the goal without properly achieving it, always steer and remind it not to take shortcuts.

"done" CRITERIA: The core outcome is complete and functional. Minor polish, style tweaks, or
optional improvements do NOT block "done". Prefer stopping when the goal is substantially
achieved rather than looping forever chasing perfection.

═══ AFTER STEERING: SELF-REFLECTION ═══
When you choose to steer, capture actionable side information (ASI) about why you intervened.
This helps you learn which strategies work for future similar situations.

ASI is free-form: use the suggested keys below, and add ANY additional keys you find useful.
Examples: "test_count_before", "files_modified", "dead_end", "next_time_try", etc.

Respond ONLY with valid JSON — no prose, no markdown fences.
Response schema (strict JSON):
{
  "action": "continue" | "steer" | "done",
  "message": "...",     // Required when action === "steer"
  "reasoning": "...",   // Brief internal reasoning
  "confidence": 0.85,   // Float 0-1
  "asi": {              // Optional: capture when steering. Free-form, arbitrary keys allowed.
    "why_stuck": "what pattern indicated the agent needed help",
    "strategy_used": "directive | subgoal | pivot | minimal_slice",
    "pattern_detected": "e.g. repeated_refactoring_without_tests",
    "confidence_source": "what signals informed your decision",
    "would_escalate_sooner": true | false,
    "...": "any additional keys you find useful"
  }
}`;

/**
 * Load the supervisor system prompt.
 * Checks .pi/SUPERVISOR.md (project) then ~/.pi/agent/SUPERVISOR.md (global),
 * falling back to the built-in template if neither exists.
 * Returns both the prompt and its source path (or "built-in").
 */
export function loadSystemPrompt(cwd: string): { prompt: string; source: string } {
  const projectPath = join(cwd, CONFIG_DIR, SUPERVISOR_MD);
  if (existsSync(projectPath)) {
    return { prompt: readFileSync(projectPath, 'utf-8').trim(), source: projectPath };
  }

  const globalPath = join(GLOBAL_AGENT_DIR, SUPERVISOR_MD);
  if (existsSync(globalPath)) {
    return { prompt: readFileSync(globalPath, 'utf-8').trim(), source: globalPath };
  }

  return { prompt: BUILTIN_SYSTEM_PROMPT, source: 'built-in' };
}

/**
 * Extract metrics from conversation text.
 * Simple pass-through: the LLM supervisor can read the raw text.
 * Only explicitly marked METRIC lines are extracted for convenience.
 */
export function extractMetrics(text: string): Record<string, number> {
  const metrics: Record<string, number> = {};

  // Pattern: "METRIC name=value" (autoresearch-style - explicit marker)
  const metricLines = text.match(/METRIC\s+(\w+)\s*=\s*([\d.]+)/g);
  if (metricLines) {
    for (const line of metricLines) {
      const match = line.match(/METRIC\s+(\w+)\s*=\s*([\d.]+)/);
      if (match) {
        metrics[match[1]] = parseFloat(match[2]);
      }
    }
  }

  return metrics;
}

/** Extract text content from message. */
function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b: any) => b.type === 'text')
      .map((b: any) => b.text as string)
      .join('\n')
      .trim();
  }
  return '';
}

/** Extract text from assistant message content. */
function extractAssistantText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  const textParts = content.filter((b: any) => b.type === 'text').map((b: any) => b.text as string);
  return textParts.join('\n').trim();
}

/**
 * Fixed message limit for supervisor context window.
 */
export const SNAPSHOT_LIMIT = 6;

/**
 * Incrementally build snapshot from new session entries since last analysis.
 * Only walks entries from lastAnalyzedTurn to current, appends to existing buffer.
 */
export function buildIncrementalSnapshot(
  ctx: ExtensionContext,
  state: SupervisorState
): ConversationMessage[] {
  const existingBuffer = state.snapshotBuffer ?? [];
  const lastAnalyzed = state.lastAnalyzedTurn ?? -1;
  const currentTurn = state.turnCount;

  // If already analyzed this turn, return existing
  if (lastAnalyzed >= currentTurn) {
    return existingBuffer.slice(-SNAPSHOT_LIMIT);
  }

  const newMessages: ConversationMessage[] = [...existingBuffer];
  const entries = ctx.sessionManager.getBranch();
  let entryIndex = 0;

  // Find entries since last analysis
  for (const entry of entries) {
    if (entry.type !== 'message') continue;
    const msg = (entry as any).message;
    if (!msg) continue;

    // Track entry position roughly (not exact turn mapping, but sufficient)
    entryIndex++;

    if (msg.role === 'user') {
      const content = extractText(msg.content);
      if (content) newMessages.push({ role: 'user', content });
    } else if (msg.role === 'assistant') {
      const content = extractAssistantText(msg.content);
      if (content) newMessages.push({ role: 'assistant', content });
    }
  }

  // Keep only last 6, compress older if needed
  if (newMessages.length > SNAPSHOT_LIMIT) {
    const overflow = newMessages.length - SNAPSHOT_LIMIT;
    // Drop oldest messages (simple approach)
    return newMessages.slice(overflow);
  }

  return newMessages;
}

/**
 * Update state with new snapshot and return it.
 */
export function updateSnapshot(
  ctx: ExtensionContext,
  state: SupervisorState
): ConversationMessage[] {
  const snapshot = buildIncrementalSnapshot(ctx, state);
  state.snapshotBuffer = snapshot;
  state.lastAnalyzedTurn = state.turnCount;
  return snapshot;
}

/** Get reframe guidance based on current tier */
export function getReframeGuidance(
  tier: number,
  ineffectivePattern?: { detected: boolean; similarCount: number; turnsSinceLastSteer: number }
): string {
  if (!ineffectivePattern?.detected && tier === 0) return '';

  const tierGuidance: Record<number, string> = {
    0: '',
    1: `🔄 REFRAME TIER 1 — DIRECTIVE: The agent needs clearer direction. Be extremely specific about the next single action to take.`,
    2: `🔄 REFRAME TIER 2 — SUBGOAL: The agent is stuck on the full goal. Break this into a smaller, verifiable milestone. Tell it to complete just that one piece.`,
    3: `🔄 REFRAME TIER 3 — PIVOT: The current approach isn't working. Suggest a completely different strategy or implementation path. Challenge any assumptions.`,
    4: `🔄 REFRAME TIER 4 — MINIMAL SLICE: Strip to absolute essentials. Ask: "What's the smallest working version you can deliver right now?" Push for tangible output.`,
  };

  const patternNote = ineffectivePattern?.detected
    ? `\n⚠ INEFFECTIVE PATTERN DETECTED: Last ${ineffectivePattern.similarCount} steering messages were similar or no progress in ${ineffectivePattern.turnsSinceLastSteer} turns. Escalate your approach.`
    : '';

  return tierGuidance[tier] + patternNote;
}

/** Build the user-facing prompt for the supervisor LLM. */
export function buildUserPrompt(
  state: SupervisorState,
  snapshot: ConversationMessage[],
  agentIsIdle: boolean,
  ineffectivePattern?: { detected: boolean; similarCount: number; turnsSinceLastSteer: number }
): string {
  const interventionHistory =
    state.interventions.length === 0
      ? 'None yet.'
      : state.interventions
          .slice(-5)
          .map((iv, i) => {
            let entry = `[${i + 1}] Turn ${iv.turnCount}: "${iv.message}"`;
            if (iv.asi?.why_stuck) {
              entry += `\n    ASI: ${iv.asi.why_stuck}`;
            }
            return entry;
          })
          .join('\n');

  // Extract metrics from all conversation messages
  const allMetrics: Record<string, number> = {};
  for (const msg of snapshot) {
    const msgMetrics = extractMetrics(msg.content);
    Object.assign(allMetrics, msgMetrics);
  }
  const metricsText =
    Object.keys(allMetrics).length > 0
      ? `METRICS DETECTED IN CONVERSATION:\n${Object.entries(allMetrics)
          .map(([k, v]) => `  ${k}: ${v}`)
          .join('\n')}\n`
      : '';

  const conversationText =
    snapshot.length === 0
      ? '(No conversation yet)'
      : snapshot
          .map((m) => `${m.role === 'user' ? 'USER' : 'ASSISTANT'}: ${m.content}`)
          .join('\n\n---\n\n');

  const agentStatus = agentIsIdle
    ? `AGENT STATUS: IDLE — the agent has finished its turn and is now waiting for user input.
You MUST return "done" or "steer". Returning "continue" here means the agent stays idle forever.`
    : `AGENT STATUS: WORKING — the agent is actively processing. Only intervene if clearly off track.`;

  const reframeGuidance = getReframeGuidance(state.reframeTier ?? 0, ineffectivePattern);
  const reframeSection = reframeGuidance ? `\n${reframeGuidance}\n` : '';

  return `DESIRED OUTCOME:
${state.outcome}

${agentStatus}${reframeSection}

${metricsText}RECENT CONVERSATION (last ${snapshot.length} messages):
${conversationText}

PREVIOUS INTERVENTIONS BY YOU:
${interventionHistory}

REMINDER — DESIRED OUTCOME:
${state.outcome}

Has this outcome been fully achieved? Analyze and respond with JSON only.`;
}

/**
 * Analyze the current conversation and return a steering decision.
 * Falls back to { action: "steer" } when the agent is idle to prevent it from staying stuck.
 */
export async function analyze(
  ctx: ExtensionContext,
  state: SupervisorState,
  agentIsIdle: boolean,
  ineffectivePattern?: { detected: boolean; similarCount: number; turnsSinceLastSteer: number },
  signal?: AbortSignal,
  onDelta?: (accumulated: string) => void
): Promise<SteeringDecision> {
  const { prompt: systemPrompt } = loadSystemPrompt(ctx.cwd);

  // Update snapshot incrementally
  const snapshot = updateSnapshot(ctx, state);
  const userPrompt = buildUserPrompt(state, snapshot, agentIsIdle, ineffectivePattern);

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

// ---- Outcome inference for existing conversations ----

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
 * Returns null if inference fails or there's no conversation to analyze.
 */
export async function inferOutcome(
  ctx: ExtensionContext,
  provider: string,
  modelId: string,
  signal?: AbortSignal
): Promise<string | null> {
  // Build a focused snapshot for the immediate goal (last 6 messages = ~3 turns)
  const entries = ctx.sessionManager.getBranch();
  const messages: ConversationMessage[] = [];

  for (const entry of entries) {
    if (entry.type !== 'message') continue;
    const msg = (entry as any).message;
    if (!msg) continue;

    if (msg.role === 'user') {
      const content = extractText(msg.content);
      if (content) messages.push({ role: 'user', content });
    } else if (msg.role === 'assistant') {
      const content = extractAssistantText(msg.content);
      if (content) messages.push({ role: 'assistant', content });
    }
  }

  const snapshot = messages.slice(-6);
  if (snapshot.length === 0) return null;

  const conversationText = snapshot
    .map((m) => `${m.role === 'user' ? 'USER' : 'ASSISTANT'}: ${m.content}`)
    .join('\n\n---\n\n');

  const userPrompt = `Analyze this conversation and extract the user's primary goal or desired outcome:

${conversationText}

What is the specific outcome the user is trying to achieve?`;

  try {
    // Import dynamically to avoid circular dependency issues
    const { callModel } = await import('./model-client.js');
    const result = await callModel(
      ctx,
      provider,
      modelId,
      INFER_OUTCOME_SYSTEM_PROMPT,
      userPrompt,
      signal
    );
    if (!result) return null;
    // Clean up the result: remove quotes, trim whitespace, limit length
    return result
      .replace(/^["']|["']$/g, '') // Remove surrounding quotes
      .replace(/\n/g, ' ') // Replace newlines with spaces
      .trim()
      .slice(0, 200); // Hard limit at 200 chars
  } catch {
    return null;
  }
}
