/**
 * pi-supervisor — A pi extension that supervises the chat and steers it toward a defined outcome.
 *
 * Token-optimal design:
 * - Single trigger: always at agent_end (when idle)
 * - Mid-run: only if just steered (checking if it worked) or safety valve every 8th turn
 * - Session reuse for automatic prompt caching
 * - Incremental 6-message snapshots
 *
 * Commands:
 *   /supervise              — auto-infer goal from conversation
 *   /supervise <outcome>    — start supervising with explicit goal
 *   /supervise stop         — stop supervising
 *   /supervise widget       — toggle the status widget on/off
 */

import { truncateToWidth } from '@mariozechner/pi-tui';
import type { ExtensionAPI, ExtensionContext } from '@mariozechner/pi-coding-agent';
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
import { createInitialState, type WidgetState } from './ui/types.js';

/**
 * Extract partial reasoning text from the supervisor's streaming JSON response.
 * Works on incomplete JSON while the model is still generating.
 */
export function extractThinking(accumulated: string): string {
  // Find the "reasoning" key and capture content after the opening quote
  const keyIdx = accumulated.indexOf('"reasoning"');
  if (keyIdx === -1) return '';
  const after = accumulated.slice(keyIdx + '"reasoning"'.length);
  const openMatch = after.match(/^\s*:\s*"/);
  if (!openMatch) return '';
  const content = after.slice(openMatch[0].length);
  // If the closing quote has arrived, take only what's inside; otherwise take all (streaming)
  const closeIdx = content.search(/(?<!\\)"/);
  const raw = closeIdx === -1 ? content : content.slice(0, closeIdx);
  return raw.replace(/\\n/g, ' ').replace(/\\"/g, '"').trim();
}

/**
 * Truncate a message to fit within the terminal width for notifications.
 * Reserves space for the notification prefix and padding.
 */
function truncateForNotify(message: string, reserveChars: number = 20): string {
  const terminalWidth = process.stdout.columns || 100;
  const maxContentWidth = Math.max(20, terminalWidth - reserveChars);
  return truncateToWidth(message, maxContentWidth, '…');
}

/** Check if the session has any user messages in its history. */
function hasUserMessages(ctx: ExtensionContext): boolean {
  const entries = ctx.sessionManager.getBranch();
  for (const entry of entries) {
    if (entry.type === 'message') {
      const msg = (entry as any).message;
      if (msg?.role === 'user') {
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
  }
  return false;
}

export default function (pi: ExtensionAPI) {
  const state = new SupervisorStateManager(pi);
  const widgetState = createInitialState();
  let currentCtx: ExtensionContext | undefined;
  let idleSteers = 0; // consecutive agent_end steers; reset on done/stop/new supervision

  // ---- Session lifecycle: restore state ----

  /**
   * Ephemeral supervision rule: supervision only survives if there's active work.
   * When loading a session (start, switch, fork, tree navigation), if supervision
   * was active but the agent is idle, we clear it. Supervision must be tied to
   * real-time steering needs, not historical session state.
   */
  const onSessionLoad = (ctx: ExtensionContext) => {
    currentCtx = ctx;
    state.loadFromSession(ctx);

    // Ephemeral check: if supervision restored but agent is idle, stop it
    if (state.isActive() && ctx.isIdle()) {
      state.stop();
      idleSteers = 0;
      disposeSession();
      // Notify that we cleared stale supervision
      ctx.ui.notify('Supervision cleared: agent is idle', 'info');
    }

    updateUI(ctx, widgetState, state.getState());
  };

  pi.on('session_start', async (_event, ctx) => onSessionLoad(ctx));
  pi.on('session_switch', async (_event, ctx) => onSessionLoad(ctx));
  pi.on('session_fork', async (_event, ctx) => onSessionLoad(ctx));
  pi.on('session_tree', async (_event, ctx) => onSessionLoad(ctx));

  // ---- Compaction survival: persist state BEFORE compaction ----
  // This ensures supervisor-state is in the "kept" (recent) portion,
  // not the summarized portion, so it survives autocompaction.
  pi.on('session_before_compact', async (_event, ctx) => {
    if (state.isActive()) {
      state.persist();
    }
  });

  // ---- After compaction: reload state and continue supervision if agent is working ----
  // Auto-compaction during long sessions should NOT stop supervision - we want to
  // continue steering the agent toward the goal after compaction completes.
  pi.on('session_compact', async (_event, ctx) => {
    currentCtx = ctx;
    state.loadFromSession(ctx);

    // State should now be found (we persisted before compaction)
    if (!state.isActive()) {
      updateUI(ctx, widgetState, null);
      return;
    }

    // Ephemeral rule: if agent is idle after compaction, clear supervision
    if (ctx.isIdle()) {
      state.stop();
      idleSteers = 0;
      disposeSession();
      ctx.ui.notify('Supervision cleared: compaction complete, agent idle', 'info');
      updateUI(ctx, widgetState, null);
      return;
    }

    // Agent is still working - show watching state and let supervision continue
    // It will analyze/steer at the next agent_end as normal
    updateUI(ctx, widgetState, state.getState(), {
      type: 'watching',
      reframeTier: state.getReframeTier(),
    });
  });

  // ---- Keep ctx fresh ----

  pi.on('turn_start', async (_event, ctx) => {
    currentCtx = ctx;
  });

  // ---- Mid-run steering: only when necessary ----
  // turn_end fires after each LLM sub-turn (tool-call cycle) while agent is still running.
  // We check only if:
  // 1. We just steered (to verify it worked) - immediate next turn
  // 2. Safety valve every 8th turn (to catch runaway drift)

  pi.on('turn_end', async (event, ctx) => {
    currentCtx = ctx;
    if (!state.isActive()) return;

    const shouldAnalyze = state.shouldAnalyzeMidRun(event.turnIndex);
    if (!shouldAnalyze) return;

    // Clear the justSteered flag since we're checking now
    state.clearJustSteered();

    let decision;
    try {
      decision = await analyze(ctx, state.getState()!, false /* agent still working */);
    } catch {
      return;
    }

    // Mid-run threshold: only intervene if clearly off track
    if (decision.action === 'steer' && decision.message && decision.confidence >= 0.85) {
      state.addIntervention({
        turnCount: state.getState()!.turnCount,
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
  // agent_end fires once per user prompt, always with the agent idle and waiting for input.
  // This is the critical checkpoint where we decide done/steer/continue.

  pi.on('agent_end', async (_event, ctx) => {
    currentCtx = ctx;
    if (!state.isActive()) return;

    state.incrementTurnCount();
    const s = state.getState()!;

    // Check for child subagent processes (extension-agnostic via process inspection)
    const subagentStatus = await checkChildPiProcesses();
    if (subagentStatus.hasActiveSubagents) {
      updateUI(ctx, widgetState, s, {
        type: 'waiting',
        message: `Waiting for ${subagentStatus.count} subagent(s)...`,
        turn: s.turnCount,
        reframeTier: state.getReframeTier(),
      });

      // Poll until subagents complete (or timeout)
      const { completed, finalStatus } = await waitForSubagents(2000, 120000);

      if (!completed && finalStatus.hasActiveSubagents) {
        // Timeout - subagents still running, but we need to proceed
        // Log this but continue with analysis
        ctx.ui.notify(
          `Supervisor: ${finalStatus.count} subagent(s) still running after timeout, proceeding with analysis`,
          'warning'
        );
      }

      // Subagents done (or timed out), update UI and proceed
      updateUI(ctx, widgetState, s, {
        type: 'analyzing',
        turn: s.turnCount,
        reframeTier: state.getReframeTier(),
      });
    }

    // Check for ineffective steering patterns and escalate reframe tier if needed
    const ineffectivePattern = state.detectIneffectivePattern();
    if (ineffectivePattern.detected && state.getReframeTier() < 4) {
      state.escalateReframeTier();
    }

    updateUI(ctx, widgetState, s, {
      type: 'analyzing',
      turn: s.turnCount,
      reframeTier: state.getReframeTier(),
    });

    const decision = await analyze(
      ctx,
      s,
      true /* always idle at agent_end */,
      ineffectivePattern,
      undefined,
      (accumulated) => {
        const thinking = extractThinking(accumulated);
        updateUI(ctx, widgetState, state.getState()!, {
          type: 'analyzing',
          turn: s.turnCount,
          reframeTier: state.getReframeTier(),
          thinking,
        });
      }
    );

    if (decision.action === 'steer' && decision.message) {
      idleSteers++;
      state.addIntervention({
        turnCount: s.turnCount,
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
      pi.sendUserMessage(decision.message);
    } else if (decision.action === 'done') {
      idleSteers = 0;
      state.resetReframeTier();
      updateUI(ctx, widgetState, state.getState(), { type: 'done' });
      state.stop();
      disposeSession(); // Clean up reusable session
      updateUI(ctx, widgetState, state.getState());
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
        idleSteers = 0;
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

        // Check if there's conversation history
        const hasConversation = !s?.active && hasUserMessages(ctx);
        if (!hasConversation) {
          ctx.ui.notify(
            'No conversation history found. Use /supervise <goal> to set an explicit goal.',
            'warning'
          );
          return;
        }

        // Only prompt for a model if none has been configured yet
        if (!s) {
          const apiKey = await ctx.modelRegistry.getApiKeyForProvider(provider);
          if (!apiKey) {
            ctx.ui.notify(
              `No API key for "${provider}/${modelId}" — pick a model with an available key.`,
              'warning'
            );
            const picked = await pickModel(ctx, provider, modelId);
            if (!picked) return; // user cancelled
            provider = picked.provider;
            modelId = picked.id;
          }
        }

        // Infer goal from conversation
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

        // Start supervision with inferred outcome
        state.start(inferred, provider, modelId);
        idleSteers = 0;
        updateUI(ctx, widgetState, state.getState());

        // Kickstart the agent if idle
        if (ctx.isIdle()) {
          pi.sendUserMessage(`Please start working on this goal: ${inferred}`, {
            deliverAs: 'followUp',
          });
        }

        ctx.ui.notify(`Supervisor active: "${truncateForNotify(inferred, 25)}"`, 'info');
        return;
      }

      // Resolve model settings: session state → global config → active session model
      const existing = state.getState();
      const globalModel = loadGlobalModel();
      const sessionModel = ctx.model;
      let provider =
        existing?.provider ?? globalModel?.provider ?? sessionModel?.provider ?? 'unknown';
      let modelId = existing?.modelId ?? globalModel?.modelId ?? sessionModel?.id ?? 'unknown';

      // If supervision is already active, append to the existing goal
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

      // Only prompt for a model if none has been configured yet
      if (!existing) {
        const apiKey = await ctx.modelRegistry.getApiKeyForProvider(provider);
        if (!apiKey) {
          ctx.ui.notify(
            `No API key for "${provider}/${modelId}" — pick a model with an available key.`,
            'warning'
          );
          const picked = await pickModel(ctx, provider, modelId);
          if (!picked) return; // user cancelled
          provider = picked.provider;
          modelId = picked.id;
        }
      }

      state.start(trimmed, provider, modelId);
      idleSteers = 0;
      updateUI(ctx, widgetState, state.getState());

      // Kickstart the agent if idle - the user just set a goal, they want work to start
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

      // Guard: supervision already active — model cannot modify it
      if (state.isActive()) {
        const s = state.getState()!;
        return text(
          `Supervision is already active and cannot be changed by the model.\n` +
            `Active outcome: "${s.outcome}"\n` +
            `Only the user can stop or modify supervision via /supervise.`
        );
      }

      // Resolve model from global config or active session model (AI cannot choose)
      const globalModel = loadGlobalModel();
      const sessionModel = ctx.model;
      const provider = globalModel?.provider ?? sessionModel?.provider ?? 'unknown';
      const modelId = globalModel?.modelId ?? sessionModel?.id ?? 'unknown';

      state.start(params.outcome, provider, modelId);
      idleSteers = 0;
      currentCtx = ctx;
      updateUI(ctx, widgetState, state.getState());

      // Kickstart the agent if idle - model-initiated supervision should trigger work
      if (ctx.isIdle()) {
        pi.sendUserMessage(`Please start working on this goal: ${params.outcome}`, {
          deliverAs: 'followUp',
        });
      }

      // Notify the user so they're aware supervision was initiated by the model
      ctx.ui.notify(
        `Supervisor started by agent: "${truncateForNotify(params.outcome, 30)}"`,
        'info'
      );

      return text(`Supervision active. Outcome: "${params.outcome}"`);
    },
  });
}
