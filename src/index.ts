/**
 * pi-supervisor — A pi extension that supervises the chat and steers it toward a defined outcome.
 *
 * Uses algorithmic compaction (normalize → filter → build-sections) to build
 * structured conversation context for the supervisor LLM, instead of
 * tracking turns or maintaining rolling message buffers.
 *
 * Commands:
 *   /supervise              — auto-infer goal from conversation
 *   /supervise <outcome>    — start supervising with explicit goal
 *   /supervise stop         — stop supervising
 *   /supervise widget       — toggle the status widget on/off
 */

import { truncateToWidth } from '@earendil-works/pi-tui';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { SupervisorStateManager } from './state/manager.js';
import { analyze } from './core/analyzer.js';
import { inferOutcome } from './core/inference.js';
import { loadSystemPrompt } from './core/prompt-loader.js';
import { updateUI, toggleWidget } from './ui/renderer.js';
import { pickModel } from './ui/model-picker.js';
import { loadGlobalModel } from './global-config.js';
import { disposeSession } from './session/client.js';
import { Type } from '@sinclair/typebox';
import { checkChildPiProcesses, waitForSubagents } from './subagent-detector.js';
import { detectMidRunSignals } from './state/mid-run-signals.js';
import { createInitialState, type WidgetState } from './ui/types.js';
import {
  extractMessages,
  buildCompactionSummary,
  formatForSupervisor,
} from './compaction/index.js';

/**
 * Extract partial reasoning text from the supervisor's streaming JSON response.
 */
export function extractThinking(accumulated: string): string {
  const keyIdx = accumulated.indexOf('"reasoning"');
  if (keyIdx === -1) return '';
  const after = accumulated.slice(keyIdx + '"reasoning"'.length);
  const openMatch = after.match(/^\s*:\s*"/);
  if (!openMatch) return '';
  const content = after.slice(openMatch[0].length);
  const closeIdx = content.search(/(?<!\\)"/);
  const raw = closeIdx === -1 ? content : content.slice(0, closeIdx);
  return raw.replace(/\\n/g, ' ').replace(/\\"/g, '"').trim();
}

function truncateForNotify(message: string, reserveChars: number = 20): string {
  const terminalWidth = process.stdout.columns || 100;
  const maxContentWidth = Math.max(20, terminalWidth - reserveChars);
  return truncateToWidth(message.replace(/\r?\n/g, ' '), maxContentWidth, '…');
}

/** Check if the session has any user messages in its history. */
function hasUserMessages(ctx: ExtensionContext): boolean {
  const messages = extractMessages(ctx);
  for (const msg of messages) {
    if (msg.role === 'user') {
      const content =
        typeof msg.content === 'string'
          ? msg.content
          : Array.isArray(msg.content)
            ? msg.content
                .filter((b: any) => b.type === 'text')
                .map((b: any) => b.text)
                .join('\n')
                .trim()
            : '';
      if (content && content.length > 0) return true;
    }
  }
  return false;
}

export default function (pi: ExtensionAPI) {
  const state = new SupervisorStateManager(pi);
  const widgetState = createInitialState();
  let currentCtx: ExtensionContext | undefined;

  // ---- Session lifecycle: restore state ----

  const onSessionLoad = (ctx: ExtensionContext) => {
    currentCtx = ctx;
    state.loadFromSession(ctx);

    if (state.isActive() && ctx.isIdle()) {
      state.stop();
      disposeSession();
      ctx.ui.notify('Supervision cleared: agent is idle', 'info');
    }

    updateUI(ctx, widgetState, state.getState());
  };

  pi.on('session_start', async (_event, ctx) => onSessionLoad(ctx));
  pi.on('session_start', async (event, ctx) => {
    if (event.reason === 'startup' || event.reason === 'reload') return;
    onSessionLoad(ctx);
  });
  pi.on('session_tree', async (_event, ctx) => onSessionLoad(ctx));

  // ---- Compaction survival: persist state BEFORE compaction ----
  pi.on('session_before_compact', async (_event, ctx) => {
    if (state.isActive()) {
      state.persist();
    }
  });

  // ---- After compaction: reload state and continue if agent is working ----
  pi.on('session_compact', async (_event, ctx) => {
    currentCtx = ctx;
    state.loadFromSession(ctx);

    if (!state.isActive()) {
      updateUI(ctx, widgetState, null);
      return;
    }

    if (ctx.isIdle()) {
      state.stop();
      disposeSession();
      ctx.ui.notify('Supervision cleared: compaction complete, agent idle', 'info');
      updateUI(ctx, widgetState, null);
      return;
    }

    updateUI(ctx, widgetState, state.getState(), {
      type: 'watching',
      reframeTier: state.getReframeTier(),
    });
  });

  // ---- Keep ctx fresh ----

  pi.on('turn_start', async (_event, ctx) => {
    currentCtx = ctx;
  });

  // ---- Mid-run steering: signal-based ----
  // turn_end fires after each LLM sub-turn while agent is still running.
  // Instead of a blind turn counter, we check for reactive signals:
  // - just steered → verify it worked
  // - tool error → check if the agent is stuck
  // - file read loop → same file read 4+ times without an edit
  // - read-only stagnation → 8+ consecutive read calls without a mutation

  pi.on('turn_end', async (_event, ctx) => {
    currentCtx = ctx;
    if (!state.isActive()) return;

    const messages = extractMessages(ctx);
    const signal = detectMidRunSignals(messages);
    if (!signal) return;

    let decision;
    try {
      decision = await analyze(ctx, state.getState()!, false /* agent still working */);
    } catch {
      return;
    }

    if (decision.action === 'steer' && decision.message && decision.confidence >= 0.85) {
      state.addIntervention({
        message: decision.message,
        reasoning: decision.reasoning,
        timestamp: Date.now(),
        asi: decision.asi,
      });
      updateUI(ctx, widgetState, state.getState(), { type: 'steering', message: decision.message });
      pi.sendUserMessage(decision.message, { deliverAs: 'steer' });
    }
  });

  // ---- After each agent run: analyze + steer ----
  // agent_end fires once per user prompt, always with the agent idle.

  pi.on('agent_end', async (_event, ctx) => {
    currentCtx = ctx;
    if (!state.isActive()) return;

    const s = state.getState()!;

    // Check for child subagent processes
    const subagentStatus = await checkChildPiProcesses();
    if (subagentStatus.hasActiveSubagents) {
      updateUI(ctx, widgetState, s, {
        type: 'waiting',
        message: `Waiting for ${subagentStatus.count} subagent(s)...`,
        reframeTier: state.getReframeTier(),
      });

      const { completed, finalStatus } = await waitForSubagents(2000, 120000);

      if (!completed && finalStatus.hasActiveSubagents) {
        ctx.ui.notify(
          `Supervisor: ${finalStatus.count} subagent(s) still running after timeout, proceeding with analysis`,
          'warning'
        );
      }

      updateUI(ctx, widgetState, s, {
        type: 'analyzing',
        reframeTier: state.getReframeTier(),
      });
    }

    // Check for ineffective steering patterns
    const ineffectivePattern = state.detectIneffectivePattern();
    if (ineffectivePattern.detected && state.getReframeTier() < 4) {
      state.escalateReframeTier();
    }

    updateUI(ctx, widgetState, state.getState()!, {
      type: 'analyzing',
      reframeTier: state.getReframeTier(),
    });

    const decision = await analyze(
      ctx,
      state.getState()!,
      true /* always idle at agent_end */,
      ineffectivePattern,
      undefined,
      (accumulated) => {
        const thinking = extractThinking(accumulated);
        updateUI(ctx, widgetState, state.getState()!, {
          type: 'analyzing',
          reframeTier: state.getReframeTier(),
          thinking,
        });
      }
    );

    if (decision.action === 'steer' && decision.message) {
      state.incrementIdleSteers();
      state.addIntervention({
        message: decision.message,
        reasoning: decision.reasoning,
        timestamp: Date.now(),
        asi: decision.asi,
      });
      updateUI(ctx, widgetState, state.getState(), {
        type: 'steering',
        message: decision.message,
        reframeTier: state.getReframeTier(),
      });
      pi.sendUserMessage(decision.message, { deliverAs: 'steer' });
    } else if (decision.action === 'done') {
      state.resetIdleSteers();
      state.resetReframeTier();
      // Show 'done' with the outcome still visible before stopping
      updateUI(ctx, widgetState, state.getState(), { type: 'done' });
      state.stop();
      disposeSession();
    } else {
      updateUI(ctx, widgetState, state.getState(), {
        type: 'watching',
        reframeTier: state.getReframeTier(),
      });
    }
  });

  // ---- /supervise command ----

  pi.registerCommand('supervise', {
    description: 'Supervise the chat toward a desired outcome (/supervise or /supervise <outcome>)',
    handler: async (args, ctx) => {
      currentCtx = ctx;
      const trimmed = args?.trim() ?? '';

      // --- subcommands ---

      if (trimmed === 'widget') {
        const visible = toggleWidget(widgetState);
        if (state.isActive()) {
          updateUI(ctx, widgetState, state.getState());
        }
        ctx.ui.notify(`Supervisor widget ${visible ? 'shown' : 'hidden'}.`, 'info');
        return;
      }

      if (trimmed === 'stop') {
        if (!state.isActive()) {
          ctx.ui.notify('Supervisor is not active.', 'warning');
          return;
        }
        state.stop();
        state.resetIdleSteers();
        disposeSession();
        updateUI(ctx, widgetState, state.getState());
        ctx.ui.notify('Supervisor stopped.', 'info');
        return;
      }

      // --- infer goal from conversation (no args) ---

      if (!trimmed) {
        const s = state.getState();
        const globalModel = loadGlobalModel();
        const sessionModel = ctx.model;
        let provider = s?.provider ?? globalModel?.provider ?? sessionModel?.provider ?? 'unknown';
        let modelId = s?.modelId ?? globalModel?.modelId ?? sessionModel?.id ?? 'unknown';

        const hasConversation = !s?.active && hasUserMessages(ctx);
        if (!hasConversation) {
          ctx.ui.notify(
            'No conversation history found. Use /supervise <goal> to set an explicit goal.',
            'warning'
          );
          return;
        }

        if (!s) {
          const apiKey = await ctx.modelRegistry.getApiKeyForProvider(provider);
          if (!apiKey) {
            ctx.ui.notify(
              `No API key for "${provider}/${modelId}" — pick a model with an available key.`,
              'warning'
            );
            const picked = await pickModel(ctx, provider, modelId);
            if (!picked) return;
            provider = picked.provider;
            modelId = picked.id;
          }
        }

        updateUI(ctx, widgetState, state.getState(), { type: 'inferring' });
        const inferred = await inferOutcome(ctx, provider, modelId);
        updateUI(ctx, widgetState, state.getState());

        if (!inferred) {
          ctx.ui.notify(
            'Could not infer goal from conversation. Use /supervise <goal> to set an explicit goal.',
            'warning'
          );
          return;
        }

        state.start(inferred, provider, modelId);
        updateUI(ctx, widgetState, state.getState());

        if (ctx.isIdle()) {
          pi.sendUserMessage(`Please start working on this goal: ${inferred}`, {
            deliverAs: 'followUp',
          });
        }

        ctx.ui.notify(`Supervisor active: "${truncateForNotify(inferred, 25)}"`, 'info');
        return;
      }

      // Resolve model settings
      const existing = state.getState();
      const globalModel = loadGlobalModel();
      const sessionModel = ctx.model;
      let provider =
        existing?.provider ?? globalModel?.provider ?? sessionModel?.provider ?? 'unknown';
      let modelId = existing?.modelId ?? globalModel?.modelId ?? sessionModel?.id ?? 'unknown';

      if (state.isActive() && existing) {
        const appendedOutcome = `${existing.outcome}. Additionally: ${trimmed}`;
        state.updateOutcome(appendedOutcome);
        updateUI(ctx, widgetState, state.getState());

        ctx.ui.notify(
          `Supervisor goal expanded: "${truncateForNotify(trimmed, 30)}" added to active supervision.`,
          'info'
        );
        return;
      }

      if (!existing) {
        const apiKey = await ctx.modelRegistry.getApiKeyForProvider(provider);
        if (!apiKey) {
          ctx.ui.notify(
            `No API key for "${provider}/${modelId}" — pick a model with an available key.`,
            'warning'
          );
          const picked = await pickModel(ctx, provider, modelId);
          if (!picked) return;
          provider = picked.provider;
          modelId = picked.id;
        }
      }

      state.start(trimmed, provider, modelId);
      updateUI(ctx, widgetState, state.getState());

      if (ctx.isIdle()) {
        pi.sendUserMessage(`Please start working on this goal: ${trimmed}`, {
          deliverAs: 'followUp',
        });
      }

      ctx.ui.notify(`Supervisor active: "${truncateForNotify(trimmed, 25)}"`, 'info');
    },
  });

  // ---- Tool: model can initiate supervision but never modify an active session ----

  pi.registerTool({
    name: 'start_supervision',
    label: 'Start Supervision',
    description:
      'Activate the supervisor to track the conversation toward a specific outcome. ' +
      'The supervisor will observe every turn and steer the agent if it drifts. ' +
      'Once supervision is active it is locked — only the user can change or stop it. ' +
      'Uses the global config model or active chat model (model cannot be specified).',
    parameters: Type.Object({
      outcome: Type.String({
        description:
          'The desired end-state to supervise toward. Be specific and measurable ' +
          "(e.g. 'Implement JWT auth with refresh tokens and full test coverage').",
      }),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      const text = (msg: string) => ({
        content: [{ type: 'text' as const, text: msg }],
        details: undefined,
      });

      if (state.isActive()) {
        const s = state.getState()!;
        return text(
          `Supervision is already active and cannot be changed by the model.\n` +
            `Active outcome: "${s.outcome}"\n` +
            `Only the user can stop or modify supervision via /supervise.`
        );
      }

      const globalModel = loadGlobalModel();
      const sessionModel = ctx.model;
      const provider = globalModel?.provider ?? sessionModel?.provider ?? 'unknown';
      const modelId = globalModel?.modelId ?? sessionModel?.id ?? 'unknown';

      state.start(params.outcome, provider, modelId);
      currentCtx = ctx;
      updateUI(ctx, widgetState, state.getState());

      if (ctx.isIdle()) {
        pi.sendUserMessage(`Please start working on this goal: ${params.outcome}`, {
          deliverAs: 'followUp',
        });
      }

      ctx.ui.notify(
        `Supervisor started by agent: "${truncateForNotify(params.outcome, 30)}"`,
        'info'
      );

      return text(`Supervision active. Outcome: "${params.outcome}"`);
    },
  });
}
