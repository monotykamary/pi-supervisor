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
  ContentBlock,
  ToolResultEntry,
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

/** Extract ALL content blocks from message content - full fidelity including images and tool calls. */
function extractAllBlocks(content: unknown): ContentBlock[] {
  if (!Array.isArray(content)) return [];
  return content
    .map((b: any): ContentBlock | null => {
      if (b.type === 'text' && b.text) {
        return { type: 'text', text: b.text };
      }
      if (b.type === 'image' && b.source) {
        return { type: 'image', source: b.source, mimeType: b.mimeType };
      }
      if (b.type === 'tool_use' || b.type === 'tool_call') {
        return {
          type: 'tool_call',
          id: b.id || b.tool_use_id || 'unknown',
          name: b.name || b.tool_name || 'unknown',
          input: b.input || b.arguments || {},
        };
      }
      if (b.type === 'tool_result') {
        return {
          type: 'tool_result',
          toolCallId: b.tool_use_id || b.toolCallId || 'unknown',
          content: b.content || [],
          isError: b.is_error || b.isError || false,
        };
      }
      return null;
    })
    .filter((b): b is ContentBlock => b !== null);
}

/** Extract text content from message - for backward compatibility. */
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

/** Extract text from assistant message content - for backward compatibility. */
function extractAssistantText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  const textParts = content.filter((b: any) => b.type === 'text').map((b: any) => b.text as string);
  return textParts.join('\n').trim();
}

/**
 * Convert content blocks to a display string for the supervisor prompt.
 * Includes full tool outputs and notes images.
 */
function blocksToString(blocks: ContentBlock[] | undefined): string {
  if (!blocks || blocks.length === 0) return '';

  const parts: string[] = [];
  for (const block of blocks) {
    if (block.type === 'text') {
      parts.push(block.text);
    } else if (block.type === 'image') {
      parts.push(`[Image: ${block.mimeType || 'unknown'} data]`);
    } else if (block.type === 'tool_call') {
      parts.push(`[Tool call: ${block.name}(${JSON.stringify(block.input)})]`);
    } else if (block.type === 'tool_result') {
      const contentStr = block.content
        .map((c) => (typeof c === 'string' ? c : c.type === 'text' ? c.text : `[${c.type}]`))
        .join('');
      parts.push(`[Tool result${block.isError ? ' (ERROR)' : ''}]: ${contentStr}`);
    }
  }
  return parts.join('\n');
}

/**
 * Fixed message limit for supervisor context window.
 */
export const SNAPSHOT_LIMIT = 6;

/**
 * Incrementally build snapshot from new session entries since last analysis.
 * CAPTURES EVERYTHING: full tool outputs, images (base64), all content blocks.
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

  // Track pending tool results to associate with the next assistant message
  const pendingToolResults: ToolResultEntry[] = [];

  // Find entries since last analysis
  for (const entry of entries) {
    // Capture regular messages (user/assistant conversation)
    if (entry.type === 'message') {
      const msg = (entry as any).message;
      if (!msg) continue;

      if (msg.role === 'user') {
        const textContent = extractText(msg.content);
        const allBlocks = extractAllBlocks(msg.content);
        if (textContent || allBlocks.length > 0) {
          newMessages.push({
            role: 'user',
            content: textContent,
            blocks: allBlocks,
          });
        }
      } else if (msg.role === 'assistant') {
        const textContent = extractAssistantText(msg.content);
        const allBlocks = extractAllBlocks(msg.content);

        // Check for tool calls in the content blocks
        const toolCalls = allBlocks.filter(
          (b): b is ContentBlock & { type: 'tool_call' } => b.type === 'tool_call'
        );

        if (textContent || allBlocks.length > 0 || toolCalls.length > 0) {
          newMessages.push({
            role: 'assistant',
            content: textContent,
            blocks: allBlocks,
            toolResults: pendingToolResults.length > 0 ? [...pendingToolResults] : undefined,
          });
          // Clear pending tool results after associating with assistant
          pendingToolResults.length = 0;
        }
      } else if (msg.role === 'tool') {
        // Tool result messages - capture them fully
        const allBlocks = extractAllBlocks(msg.content);
        const textContent = extractText(msg.content);

        // Try to extract tool call ID and name from the message
        const toolCallId = (msg as any).tool_call_id || (msg as any).toolCallId || 'unknown';
        const toolName = (msg as any).name || 'unknown';
        const isError = (msg as any).is_error || (msg as any).isError || false;

        pendingToolResults.push({
          toolCallId,
          toolName,
          input: {},
          content: allBlocks,
          isError,
        });

        // Also add as a tool_results message for visibility
        newMessages.push({
          role: 'tool_results',
          content: textContent || `[Tool output: ${toolName}]`,
          blocks: allBlocks,
        });
      }
    }

    // Capture custom_message entries (often contain tool results in pi)
    if (entry.type === 'custom_message') {
      const customMsg = entry as any;
      const content = customMsg.content;

      if (typeof content === 'string') {
        // Plain text custom message - likely tool output
        pendingToolResults.push({
          toolCallId: customMsg.id || 'unknown',
          toolName: customMsg.customType || 'unknown',
          input: customMsg.details || {},
          content: [{ type: 'text', text: content }],
          isError: false,
        });

        newMessages.push({
          role: 'tool_results',
          content: content,
          blocks: [{ type: 'text', text: content }],
        });
      } else if (Array.isArray(content)) {
        // Rich content custom message - extract all blocks
        const allBlocks = extractAllBlocks(content);
        const textContent = content
          .filter((b: any) => b.type === 'text')
          .map((b: any) => b.text)
          .join('\n');

        pendingToolResults.push({
          toolCallId: customMsg.id || 'unknown',
          toolName: customMsg.customType || 'unknown',
          input: customMsg.details || {},
          content: allBlocks,
          isError: false,
        });

        newMessages.push({
          role: 'tool_results',
          content: textContent || `[Tool output: ${customMsg.customType}]`,
          blocks: allBlocks,
        });
      }
    }

    // Bash execution messages (special type in pi)
    if ((entry as any).type === 'bash_execution' || (entry as any).type === 'bash_result') {
      const bashEntry = entry as any;
      const result = bashEntry.result || bashEntry;

      if (result) {
        const output = result.stdout || result.output || result.content || '';
        const stderr = result.stderr || '';
        const exitCode = result.exitCode ?? result.exit_code ?? 0;

        const fullOutput = [output, stderr].filter(Boolean).join('\n');

        pendingToolResults.push({
          toolCallId: bashEntry.id || 'bash',
          toolName: 'bash',
          input: { command: result.command || bashEntry.command },
          content: [{ type: 'text', text: fullOutput }],
          isError: exitCode !== 0,
        });

        newMessages.push({
          role: 'tool_results',
          content: fullOutput || '[bash output]',
          blocks: [{ type: 'text', text: fullOutput }],
        });
      }
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
          .map((m) => {
            const roleLabel =
              m.role === 'user' ? 'USER' : m.role === 'assistant' ? 'ASSISTANT' : 'TOOL RESULTS';
            let text = `${roleLabel}: ${m.content}`;

            // Include tool calls from assistant blocks
            if (m.role === 'assistant' && m.blocks) {
              const toolCalls = m.blocks.filter((b) => b.type === 'tool_call');
              if (toolCalls.length > 0) {
                text += '\n\n[Tool calls made]:';
                for (const tc of toolCalls) {
                  text += `\n  - ${(tc as any).name}(${JSON.stringify((tc as any).input)})`;
                }
              }
            }

            // Include full tool results attached to assistant messages
            if (m.role === 'assistant' && m.toolResults && m.toolResults.length > 0) {
              text += '\n\n[Tool outputs received]:';
              for (const tr of m.toolResults) {
                const resultText = tr.content
                  .map((c) =>
                    c.type === 'text' ? c.text : c.type === 'image' ? '[Image data]' : `[${c.type}]`
                  )
                  .join('');
                text += `\n--- ${tr.toolName} output ---\n${resultText}${tr.isError ? '\n[ERROR]' : ''}`;
              }
            }

            // For tool_results role, the content is already the full output
            if (m.role === 'tool_results' && m.blocks) {
              const hasImages = m.blocks.some((b) => b.type === 'image');
              if (hasImages) {
                text += '\n\n[Contains image data - see blocks for full content]';
              }
            }

            return text;
          })
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
    // Capture regular messages
    if (entry.type === 'message') {
      const msg = (entry as any).message;
      if (!msg) continue;

      if (msg.role === 'user') {
        const textContent = extractText(msg.content);
        const allBlocks = extractAllBlocks(msg.content);
        if (textContent || allBlocks.length > 0) {
          messages.push({ role: 'user', content: textContent, blocks: allBlocks });
        }
      } else if (msg.role === 'assistant') {
        const textContent = extractAssistantText(msg.content);
        const allBlocks = extractAllBlocks(msg.content);
        if (textContent || allBlocks.length > 0) {
          messages.push({ role: 'assistant', content: textContent, blocks: allBlocks });
        }
      } else if (msg.role === 'tool') {
        // Include tool results for context
        const textContent = extractText(msg.content);
        const allBlocks = extractAllBlocks(msg.content);
        if (textContent || allBlocks.length > 0) {
          messages.push({ role: 'tool_results', content: textContent, blocks: allBlocks });
        }
      }
    }

    // Capture custom_message entries (often contain tool results)
    if (entry.type === 'custom_message') {
      const customMsg = entry as any;
      const content = customMsg.content;

      if (typeof content === 'string') {
        messages.push({
          role: 'tool_results',
          content: content,
          blocks: [{ type: 'text', text: content }],
        });
      } else if (Array.isArray(content)) {
        const allBlocks = extractAllBlocks(content);
        const textContent = content
          .filter((b: any) => b.type === 'text')
          .map((b: any) => b.text)
          .join('\n');
        messages.push({
          role: 'tool_results',
          content: textContent || `[${customMsg.customType}]`,
          blocks: allBlocks,
        });
      }
    }
  }

  const snapshot = messages.slice(-6);
  if (snapshot.length === 0) return null;

  const conversationText = snapshot
    .map(
      (m) =>
        `${m.role === 'user' ? 'USER' : m.role === 'assistant' ? 'ASSISTANT' : 'TOOL RESULTS'}: ${m.content}`
    )
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
