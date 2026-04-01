/**
 * Prompt builder - constructs user prompts for the supervisor LLM.
 */

import type { SupervisorState, ConversationMessage } from '../types.js';
import { extractMetrics } from './content-extractor.js';
import { getReframeGuidance } from './reframe.js';

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
