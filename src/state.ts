/**
 * SupervisorStateManager — manages in-memory supervisor state and session persistence.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { SupervisorState, SupervisorIntervention, ConversationMessage, ReframeTier } from "./types.js";

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
      reframeTier: 0,
      lastSteerTurn: -1,
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
    this.state.lastSteerTurn = intervention.turnCount;
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

  // ---- Reframe tier management ----

  getReframeTier(): ReframeTier {
    return this.state?.reframeTier ?? 0;
  }

  escalateReframeTier(): void {
    if (!this.state) return;
    const current = this.state.reframeTier ?? 0;
    if (current < 4) {
      this.state.reframeTier = (current + 1) as ReframeTier;
      this.persist();
    }
  }

  resetReframeTier(): void {
    if (!this.state) return;
    this.state.reframeTier = 0;
    this.persist();
  }

  /**
   * Detect if recent interventions show a pattern of ineffectiveness.
   * Returns similarity info if the last 2+ steering messages are similar.
   */
  detectIneffectivePattern(): { detected: boolean; similarCount: number; turnsSinceLastSteer: number } {
    if (!this.state) return { detected: false, similarCount: 0, turnsSinceLastSteer: 0 };

    const turnsSinceLastSteer = this.state.turnCount - (this.state.lastSteerTurn ?? 0);

    // Check stagnation: no progress after 3+ turns since last steer
    const stagnating = this.state.lastSteerTurn !== undefined && this.state.lastSteerTurn >= 0 && turnsSinceLastSteer >= 3;

    const recent = this.state.interventions.slice(-3);
    if (recent.length < 2) {
      // Still detect stagnation even with fewer than 2 interventions
      return { detected: stagnating, similarCount: recent.length, turnsSinceLastSteer };
    }

    // Simple similarity: check if messages share common keywords or have similar length
    const messages = recent.map(iv => iv.message.toLowerCase());
    let similarCount = 1;

    for (let i = 1; i < messages.length; i++) {
      if (this.areMessagesSimilar(messages[i - 1], messages[i])) {
        similarCount++;
      }
    }

    // Detected if 2+ recent messages are similar OR stagnating (no progress after 3+ turns)
    const detected = similarCount >= 2 || stagnating;

    return { detected, similarCount, turnsSinceLastSteer };
  }

  private areMessagesSimilar(a: string, b: string): boolean {
    // Simple similarity heuristics
    const normalize = (s: string) => s.replace(/[^\w\s]/g, '').trim();
    const normA = normalize(a);
    const normB = normalize(b);

    // Exact match after normalization
    if (normA === normB) return true;

    // Check for common directive keywords
    const directiveWords = ['focus', 'implement', 'add', 'fix', 'create', 'build', 'need', 'should', 'must'];
    const aDirectives = directiveWords.filter(w => normA.includes(w));
    const bDirectives = directiveWords.filter(w => normB.includes(w));

    // If they share 2+ directive words, likely similar
    const commonDirectives = aDirectives.filter(w => bDirectives.includes(w));
    if (commonDirectives.length >= 2) return true;

    // Length similarity (within 30%)
    const lenRatio = Math.min(normA.length, normB.length) / Math.max(normA.length, normB.length);
    if (lenRatio > 0.7 && commonDirectives.length >= 1) return true;

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
    // Don't persist ephemeral fields that are runtime-only
    const { snapshotBuffer, lastAnalyzedTurn, justSteered, ...toPersist } = this.state;
    this.pi.appendEntry(ENTRY_TYPE, toPersist);
  }
}
