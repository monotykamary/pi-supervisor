/**
 * SupervisorStateManager — manages in-memory supervisor state and session persistence.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { SupervisorState, SupervisorIntervention, ConversationMessage } from "./types.js";

const ENTRY_TYPE = "supervisor-state";

export const DEFAULT_PROVIDER = "anthropic";
export const DEFAULT_MODEL_ID = "claude-haiku-4-5-20251001";

export class SupervisorStateManager {
  private state: SupervisorState | null = null;
  private pi: ExtensionAPI;

  constructor(pi: ExtensionAPI) {
    this.pi = pi;
  }

  start(outcome: string, provider: string, modelId: string): void {
    this.state = {
      active: true,
      outcome,
      provider,
      modelId,
      interventions: [],
      startedAt: Date.now(),
      turnCount: 0,
      snapshotBuffer: [],
      lastAnalyzedTurn: -1,
      justSteered: false,
    };
    this.persist();
  }

  stop(): void {
    if (!this.state) return;
    this.state.active = false;
    this.persist();
  }

  isActive(): boolean {
    return this.state?.active === true;
  }

  getState(): SupervisorState | null {
    return this.state;
  }

  addIntervention(intervention: SupervisorIntervention): void {
    if (!this.state) return;
    this.state.interventions.push(intervention);
    this.state.justSteered = true;
    this.persist();
  }

  clearJustSteered(): void {
    if (!this.state) return;
    this.state.justSteered = false;
  }

  incrementTurnCount(): void {
    if (!this.state) return;
    this.state.turnCount++;
  }

  setModel(provider: string, modelId: string): void {
    if (!this.state) return;
    this.state.provider = provider;
    this.state.modelId = modelId;
    this.persist();
  }

  updateSnapshotBuffer(messages: ConversationMessage[]): void {
    if (!this.state) return;
    this.state.snapshotBuffer = messages;
    this.state.lastAnalyzedTurn = this.state.turnCount;
  }

  getSnapshotBuffer(): ConversationMessage[] {
    return this.state?.snapshotBuffer ?? [];
  }

  shouldAnalyzeMidRun(turnIndex: number): boolean {
    if (!this.state) return false;
    // Check if we just steered (verify it worked), or safety valve every 8th turn
    if (this.state.justSteered) return true;
    if (turnIndex > 0 && turnIndex % 8 === 0) return true;
    return false;
  }

  /** Restore state from session entries (finds the most recent supervisor-state entry). */
  loadFromSession(ctx: ExtensionContext): void {
    const entries = ctx.sessionManager.getBranch();
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (entry.type === "custom" && (entry as any).customType === ENTRY_TYPE) {
        const loaded = (entry as any).data as SupervisorState;
        // Restore ephemeral fields
        this.state = {
          ...loaded,
          snapshotBuffer: [],
          lastAnalyzedTurn: -1,
          justSteered: false,
        };
        return;
      }
    }
    this.state = null;
  }

  private persist(): void {
    if (!this.state) return;
    // Don't persist ephemeral fields
    const { snapshotBuffer, lastAnalyzedTurn, justSteered, ...toPersist } = this.state;
    this.pi.appendEntry(ENTRY_TYPE, toPersist);
  }
}
