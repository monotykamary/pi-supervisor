/**
 * pi-supervisor — A pi extension that supervises the chat and steers it toward a defined outcome.
 *
 * Commands:
 *   /supervise <outcome>          — start supervising
 *   /supervise                    — open settings, or infer goal if conversation exists
 *   /supervise stop               — stop supervision
 *   /supervise status             — show current status widget
 *   /supervise model              — open interactive model picker (pi-style)
 *   /supervise model <p/modelId>  — set model directly (scripting)
 *   /supervise sensitivity <low|medium|high> — adjust steering sensitivity
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { SupervisorStateManager, DEFAULT_PROVIDER, DEFAULT_MODEL_ID, DEFAULT_SENSITIVITY } from "./state.js";
import { analyze, inferOutcome, loadSystemPrompt } from "./engine.js";
import { updateUI, toggleWidget, isWidgetVisible, type WidgetAction } from "./ui/status-widget.js";
import { pickModel } from "./ui/model-picker.js";
import { openSettings } from "./ui/settings-panel.js";
import {
  loadGlobalModel,
  saveGlobalModel,
  loadGlobalSensitivity,
  saveGlobalSensitivity,
} from "./global-config.js";
import type { Sensitivity } from "./types.js";
import { Type } from "@sinclair/typebox";

/**
 * Extract partial reasoning text from the supervisor's streaming JSON response.
 * Works on incomplete JSON while the model is still generating.
 */
function extractThinking(accumulated: string): string {
  // Find the "reasoning" key and capture content after the opening quote
  const keyIdx = accumulated.indexOf('"reasoning"');
  if (keyIdx === -1) return "";
  const after = accumulated.slice(keyIdx + '"reasoning"'.length);
  const openMatch = after.match(/^\s*:\s*"/);
  if (!openMatch) return "";
  const content = after.slice(openMatch[0].length);
  // If the closing quote has arrived, take only what's inside; otherwise take all (streaming)
  const closeIdx = content.search(/(?<!\\)"/);
  const raw = closeIdx === -1 ? content : content.slice(0, closeIdx);
  return raw.replace(/\\n/g, " ").replace(/\\"/g, '"').trim();
}

// After this many consecutive idle-state steers with no "done", run a lenient final evaluation.
const MAX_IDLE_STEERS = 5;

/** Check if the session has any user messages in its history. */
function hasUserMessages(ctx: ExtensionContext): boolean {
  const entries = ctx.sessionManager.getBranch();
  for (const entry of entries) {
    if (entry.type === "message") {
      const msg = (entry as any).message;
      if (msg?.role === "user") {
        const content = typeof msg.content === "string"
          ? msg.content
          : Array.isArray(msg.content)
            ? msg.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n").trim()
            : "";
        if (content && content.length > 0) return true;
      }
    }
  }
  return false;
}

export default function (pi: ExtensionAPI) {
  const state = new SupervisorStateManager(pi);
  let currentCtx: ExtensionContext | undefined;
  let idleSteers = 0; // consecutive agent_end steers; reset on done/stop/new supervision

  // ---- Session lifecycle: restore state ----

  const onSessionLoad = (ctx: ExtensionContext) => {
    currentCtx = ctx;
    state.loadFromSession(ctx);
    updateUI(ctx, state.getState());
  };

  pi.on("session_start", async (_event, ctx) => onSessionLoad(ctx));
  pi.on("session_switch", async (_event, ctx) => onSessionLoad(ctx));
  pi.on("session_fork", async (_event, ctx) => onSessionLoad(ctx));
  pi.on("session_tree", async (_event, ctx) => onSessionLoad(ctx));

  // ---- Keep ctx fresh ----

  pi.on("turn_start", async (_event, ctx) => {
    currentCtx = ctx;
  });

  // ---- Mid-turn steering: medium and high sensitivity ----
  // turn_end fires after each LLM sub-turn (tool-call cycle) while the agent is still running.
  // low:    no mid-run checks at all
  // medium: check every 3rd tool cycle (turns 2, 5, 8, …), confidence >= 0.9
  // high:   check every tool cycle from turn 2, confidence >= 0.85

  pi.on("turn_end", async (event, ctx) => {
    currentCtx = ctx;
    if (!state.isActive()) return;
    const s = state.getState()!;

    if (s.sensitivity === "low") return;
    if (event.turnIndex < 2) return; // let the agent settle before intervening
    if (s.sensitivity === "medium" && (event.turnIndex - 2) % 3 !== 0) return;

    let decision;
    try {
      decision = await analyze(ctx, s, false /* agent still working */, false /* can't stagnate mid-turn */);
    } catch {
      return;
    }

    // Higher bar for medium — less willing to disrupt productive work
    const threshold = s.sensitivity === "medium" ? 0.9 : 0.85;
    if (decision.action === "steer" && decision.message && decision.confidence >= threshold) {
      state.addIntervention({
        turnCount: s.turnCount,
        message: decision.message,
        reasoning: decision.reasoning,
        timestamp: Date.now(),
      });
      updateUI(ctx, state.getState(), { type: "steering", message: decision.message });
      pi.sendUserMessage(decision.message, { deliverAs: "steer" });
    }
  });

  // ---- After each agent run: analyze + steer ----
  // agent_end fires once per user prompt, always with the agent idle and waiting for input.
  // This is the critical checkpoint for all sensitivity levels.

  pi.on("agent_end", async (_event, ctx) => {
    currentCtx = ctx;
    if (!state.isActive()) return;

    state.incrementTurnCount();
    const s = state.getState()!;

    // Stagnation: too many steers with no "done" → final lenient evaluation
    const stagnating = idleSteers >= MAX_IDLE_STEERS;

    updateUI(ctx, s, { type: "analyzing", turn: s.turnCount });

    const decision = await analyze(ctx, s, true /* always idle at agent_end */, stagnating, undefined, (accumulated) => {
      const thinking = extractThinking(accumulated);
      updateUI(ctx, state.getState()!, { type: "analyzing", turn: s.turnCount, thinking });
    });

    if (decision.action === "steer" && decision.message) {
      idleSteers++;
      state.addIntervention({
        turnCount: s.turnCount,
        message: decision.message,
        reasoning: decision.reasoning,
        timestamp: Date.now(),
      });
      updateUI(ctx, state.getState(), { type: "steering", message: decision.message });
      pi.sendUserMessage(decision.message);
    } else if (decision.action === "done") {
      idleSteers = 0;
      updateUI(ctx, state.getState(), { type: "done" });
      const suffix = stagnating ? ` (stopped after ${MAX_IDLE_STEERS} steering attempts — goal substantially achieved)` : "";
      ctx.ui.notify(`Supervisor: outcome achieved! "${s.outcome}"${suffix}`, "info");
      state.stop();
      updateUI(ctx, state.getState());
    } else {
      updateUI(ctx, state.getState(), { type: "watching" });
    }
  });

  // ---- /supervise command ----

  pi.registerCommand("supervise", {
    description: "Supervise the chat toward a desired outcome (/supervise <outcome>)",
    handler: async (args, ctx) => {
      currentCtx = ctx;
      const trimmed = args?.trim() ?? "";

      // --- subcommands ---

      if (trimmed === "widget") {
        const visible = toggleWidget();
        if (state.isActive()) {
          updateUI(ctx, state.getState());
        }
        ctx.ui.notify(`Supervisor widget ${visible ? "shown" : "hidden"}.`, "info");
        return;
      }

      if (trimmed === "stop") {
        if (!state.isActive()) {
          ctx.ui.notify("Supervisor is not active.", "warning");
          return;
        }
        state.stop();
        idleSteers = 0;
        updateUI(ctx, state.getState());
        ctx.ui.notify("Supervisor stopped.", "info");
        return;
      }

      if (trimmed === "status") {
        const s = state.getState();
        if (!s) {
          ctx.ui.notify("No active supervision. Use /supervise <outcome> to start.", "info");
          return;
        }
        // Open the interactive settings panel (same as bare /supervise)
        const globalModel = loadGlobalModel();
        const globalSensitivity = loadGlobalSensitivity();
        const sessionModel = ctx.model;
        const defaultProvider = s?.provider ?? globalModel?.provider ?? sessionModel?.provider ?? DEFAULT_PROVIDER;
        const defaultModelId = s?.modelId ?? globalModel?.modelId ?? sessionModel?.id ?? DEFAULT_MODEL_ID;
        const defaultSensitivity = s?.sensitivity ?? globalSensitivity ?? DEFAULT_SENSITIVITY;
        const result = await openSettings(ctx, s, defaultProvider, defaultModelId, defaultSensitivity);
        if (result?.model) {
          if (state.isActive()) state.setModel(result.model.provider, result.model.modelId);
          saveGlobalModel(result.model.provider, result.model.modelId);
        }
        if (result?.sensitivity) {
          if (state.isActive()) state.setSensitivity(result.sensitivity);
          saveGlobalSensitivity(result.sensitivity);
        }
        if (result?.widget !== undefined && result.widget !== isWidgetVisible()) toggleWidget();
        if (result?.action === "stop" && state.isActive()) { state.stop(); idleSteers = 0; }
        updateUI(ctx, state.getState());
        return;
      }

      if (trimmed === "model" || trimmed.startsWith("model ")) {
        const spec = trimmed.slice(5).trim(); // "" when no args

        if (!spec) {
          // No args → open the interactive pi-style model picker
          const s = state.getState();
          const picked = await pickModel(ctx, s?.provider, s?.modelId);
          if (!picked) return; // user cancelled

          const provider = picked.provider;
          const modelId = picked.id;

          if (state.isActive()) {
            state.setModel(provider, modelId);
            updateUI(ctx, state.getState());
          }
          saveGlobalModel(provider, modelId);
          ctx.ui.notify(
            `Supervisor model set to ${provider}/${modelId}${state.isActive() ? "" : " (takes effect on next /supervise)"} · saved globally`,
            "info"
          );
          return;
        }

        // Args provided → direct assignment (for scripting)
        const slashIdx = spec.indexOf("/");
        let provider: string;
        let modelId: string;
        if (slashIdx === -1) {
          provider = state.getState()?.provider ?? DEFAULT_PROVIDER;
          modelId = spec;
        } else {
          provider = spec.slice(0, slashIdx);
          modelId = spec.slice(slashIdx + 1);
        }

        if (state.isActive()) {
          state.setModel(provider, modelId);
          updateUI(ctx, state.getState());
        }
        saveGlobalModel(provider, modelId);
        ctx.ui.notify(
          `Supervisor model set to ${provider}/${modelId}${state.isActive() ? "" : " (takes effect on next /supervise)"} · saved globally`,
          "info"
        );
        return;
      }

      if (trimmed.startsWith("sensitivity ")) {
        const level = trimmed.slice(12).trim() as Sensitivity;
        if (level !== "low" && level !== "medium" && level !== "high") {
          ctx.ui.notify("Usage: /supervise sensitivity <low|medium|high>", "warning");
          return;
        }
        saveGlobalSensitivity(level);
        if (!state.isActive()) {
          ctx.ui.notify(`Sensitivity set to "${level}" · saved globally (takes effect on next /supervise).`, "info");
        } else {
          state.setSensitivity(level);
          updateUI(ctx, state.getState());
          ctx.ui.notify(`Supervisor sensitivity set to "${level}" · saved globally`, "info");
        }
        return;
      }

      // --- interactive settings panel ---

      if (!trimmed || trimmed === "settings") {
        const s = state.getState();
        const globalModel = loadGlobalModel();
        const globalSensitivity = loadGlobalSensitivity();
        const sessionModel = ctx.model;
        const defaultProvider = s?.provider ?? globalModel?.provider ?? sessionModel?.provider ?? DEFAULT_PROVIDER;
        const defaultModelId = s?.modelId ?? globalModel?.modelId ?? sessionModel?.id ?? DEFAULT_MODEL_ID;
        const defaultSensitivity = s?.sensitivity ?? globalSensitivity ?? DEFAULT_SENSITIVITY;

        // Check if there's conversation history and no active supervision
        const hasConversation = !s?.active && hasUserMessages(ctx);

        if (hasConversation) {
          // Offer to infer outcome from conversation
          const choice = await ctx.ui.select(
            "Supervision options:",
            [
              "Infer goal from conversation",
              "Open settings panel",
              "Cancel"
            ]
          );

          if (choice === "Cancel" || choice === undefined) {
            return;
          }

          if (choice === "Infer goal from conversation") {
            ctx.ui.setStatus("supervisor", "Inferring goal from conversation...");
            const inferred = await inferOutcome(ctx, defaultProvider, defaultModelId);
            ctx.ui.setStatus("supervisor", undefined);

            if (!inferred) {
              ctx.ui.notify("Could not infer goal from conversation. Opening settings panel.", "warning");
              // Fall through to settings panel
            } else {
              // Start supervision immediately with inferred outcome and global settings
              state.start(inferred, defaultProvider, defaultModelId, defaultSensitivity);
              idleSteers = 0;
              updateUI(ctx, state.getState());

              const { source } = loadSystemPrompt(ctx.cwd);
              const promptLabel = source === "built-in" ? "built-in prompt" : source.replace(ctx.cwd, ".");
              ctx.ui.notify(
                `Supervisor active: "${inferred.slice(0, 50)}${inferred.length > 50 ? "…" : ""}" | ${defaultProvider}/${defaultModelId} | ${promptLabel}`,
                "info"
              );
              return;
            }
          }
          // If "Open settings panel" or inference failed, fall through
        }

        const result = await openSettings(ctx, s, defaultProvider, defaultModelId, defaultSensitivity);
        if (!result) return; // user cancelled with no changes

        // Apply model change
        if (result.model) {
          const { provider: p, modelId: m } = result.model;
          if (state.isActive()) {
            state.setModel(p, m);
          }
          saveGlobalModel(p, m);
          ctx.ui.notify(
            `Supervisor model set to ${p}/${m}${state.isActive() ? "" : " (takes effect on next /supervise)"} · saved globally`,
            "info"
          );
        }

        // Apply sensitivity change
        if (result.sensitivity) {
          if (state.isActive()) {
            state.setSensitivity(result.sensitivity);
          }
          saveGlobalSensitivity(result.sensitivity);
          ctx.ui.notify(`Supervisor sensitivity set to "${result.sensitivity}" · saved globally`, "info");
        }

        // Apply widget toggle
        if (result.widget !== undefined) {
          const currentlyVisible = isWidgetVisible();
          if (result.widget !== currentlyVisible) {
            toggleWidget();
          }
        }

        // Apply stop action
        if (result.action === "stop" && state.isActive()) {
          state.stop();
          idleSteers = 0;
          ctx.ui.notify("Supervisor stopped.", "info");
        }

        updateUI(ctx, state.getState());
        return;
      }

      // Resolve model settings: session state → global config → active session model → built-in defaults
      const existing = state.getState();
      const globalModel = loadGlobalModel();
      const globalSensitivity = loadGlobalSensitivity();
      const sessionModel = ctx.model;
      let provider = existing?.provider ?? globalModel?.provider ?? sessionModel?.provider ?? DEFAULT_PROVIDER;
      let modelId  = existing?.modelId  ?? globalModel?.modelId  ?? sessionModel?.id      ?? DEFAULT_MODEL_ID;
      const sensitivity = existing?.sensitivity ?? globalSensitivity ?? DEFAULT_SENSITIVITY;

      // Only prompt for a model if none has been configured yet
      if (!existing) {
        const apiKey = await ctx.modelRegistry.getApiKeyForProvider(provider);
        if (!apiKey) {
          ctx.ui.notify(`No API key for "${provider}/${modelId}" — pick a model with an available key.`, "warning");
          const picked = await pickModel(ctx, provider, modelId);
          if (!picked) return; // user cancelled
          provider = picked.provider;
          modelId = picked.id;
        }
      }

      state.start(trimmed, provider, modelId, sensitivity);
      idleSteers = 0;
      updateUI(ctx, state.getState());

      const { source } = loadSystemPrompt(ctx.cwd);
      const promptLabel = source === "built-in" ? "built-in prompt" : source.replace(ctx.cwd, ".");
      ctx.ui.notify(
        `Supervisor active: "${trimmed.slice(0, 50)}${trimmed.length > 50 ? "…" : ""}" | ${provider}/${modelId} | ${promptLabel}`,
        "info"
      );
    },
  });

  // ---- Tool: model can initiate supervision but never modify an active session ----

  pi.registerTool({
    name: "start_supervision",
    label: "Start Supervision",
    description:
      "Activate the supervisor to track the conversation toward a specific outcome. " +
      "The supervisor will observe every turn and steer the agent if it drifts. " +
      "Once supervision is active it is locked — only the user can change or stop it.",
    parameters: Type.Object({
      outcome: Type.String({
        description:
          "The desired end-state to supervise toward. Be specific and measurable " +
          "(e.g. 'Implement JWT auth with refresh tokens and full test coverage').",
      }),
      sensitivity: Type.Optional(Type.Union([
        Type.Literal("low"),
        Type.Literal("medium"),
        Type.Literal("high"),
      ], {
        description:
          "How aggressively to steer. low = only when seriously off track, " +
          "medium = on mild drift (default), high = proactively + mid-turn checks.",
      })),
      model: Type.Optional(Type.String({
        description:
          "Supervisor model as 'provider/modelId' (e.g. 'anthropic/claude-haiku-4-5-20251001'). " +
          "Defaults to workspace config, then the active chat model.",
      })),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      const text = (msg: string) => ({ content: [{ type: "text" as const, text: msg }], details: undefined });

      // Guard: supervision already active — model cannot modify it
      if (state.isActive()) {
        const s = state.getState()!;
        return text(
          `Supervision is already active and cannot be changed by the model.\n` +
          `Active outcome: "${s.outcome}"\n` +
          `Only the user can stop or modify supervision via /supervise.`
        );
      }

      // Resolve sensitivity
      const globalSensitivity = loadGlobalSensitivity();
      const sensitivity: Sensitivity = params.sensitivity ?? globalSensitivity ?? DEFAULT_SENSITIVITY;

      // Resolve model: tool param → global config → active session model → built-in default
      let provider: string;
      let modelId: string;
      if (params.model) {
        const slash = params.model.indexOf("/");
        provider = slash === -1 ? DEFAULT_PROVIDER : params.model.slice(0, slash);
        modelId  = slash === -1 ? params.model     : params.model.slice(slash + 1);
      } else {
        const globalModel = loadGlobalModel();
        const sessionModel   = ctx.model;
        provider = globalModel?.provider ?? sessionModel?.provider ?? DEFAULT_PROVIDER;
        modelId  = globalModel?.modelId  ?? sessionModel?.id      ?? DEFAULT_MODEL_ID;
      }

      state.start(params.outcome, provider, modelId, sensitivity);
      idleSteers = 0;
      currentCtx = ctx;
      updateUI(ctx, state.getState());

      const { source } = loadSystemPrompt(ctx.cwd);
      const promptLabel = source === "built-in" ? "built-in prompt" : ".pi/SUPERVISOR.md";

      // Notify the user so they're aware supervision was initiated by the model
      ctx.ui.notify(
        `Supervisor started by agent: "${params.outcome.slice(0, 60)}${params.outcome.length > 60 ? "…" : ""}" | ${provider}/${modelId} | sensitivity: ${sensitivity} | ${promptLabel}`,
        "info"
      );

      return text(`Supervision active. Outcome: "${params.outcome}" | ${provider}/${modelId} | sensitivity: ${sensitivity}`);
    },
  });
}
