/**
 * SupervisorStateManager — manages in-memory supervisor state and session persistence.
 */

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { SupervisorState, SupervisorIntervention, ReframeTier } from '../types.js';
import { detectIneffectivePattern, type IneffectivePattern } from './patterns.js';
import {
  getReframeTier,
  escalateReframeTier as escalateReframeTierInState,
  resetReframeTier as resetReframeTierInState,
} from './reframe.js';

const ENTRY_TYPE = 'supervisor-state';

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
      reframeTier: 0,
      idleSteers: 0,
      justSteered: false,
    };
    this.persist();
  }

  stop(): void {
    if (!this.state) return;
    this.state.active = false;
    this.state.outcome = '';
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

  incrementIdleSteers(): void {
    if (!this.state) return;
    this.state.idleSteers = (this.state.idleSteers ?? 0) + 1;
  }

  resetIdleSteers(): void {
    if (!this.state) return;
    this.state.idleSteers = 0;
  }

  getIdleSteers(): number {
    return this.state?.idleSteers ?? 0;
  }

  setModel(provider: string, modelId: string): void {
    if (!this.state) return;
    this.state.provider = provider;
    this.state.modelId = modelId;
    this.persist();
  }

  updateOutcome(outcome: string): void {
    if (!this.state) return;
    this.state.outcome = outcome;
    this.persist();
  }

  // ---- Reframe tier management ----

  getReframeTier(): ReframeTier {
    return getReframeTier(this.state);
  }

  escalateReframeTier(): void {
    if (!this.state) return;
    if (escalateReframeTierInState(this.state)) {
      this.persist();
    }
  }

  resetReframeTier(): void {
    if (!this.state) return;
    resetReframeTierInState(this.state);
    this.persist();
  }

  // ---- Pattern detection ----

  detectIneffectivePattern(): IneffectivePattern {
    if (!this.state) return { detected: false, similarCount: 0, secondsSinceLastSteer: 0 };
    return detectIneffectivePattern(this.state);
  }

  // ---- Persistence ----

  loadFromSession(ctx: ExtensionContext): void {
    const entries = ctx.sessionManager.getBranch();
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (entry.type === 'custom' && (entry as any).customType === ENTRY_TYPE) {
        const loaded = (entry as any).data as SupervisorState;
        this.state = {
          ...loaded,
          justSteered: false,
        };
        return;
      }
    }
    this.state = null;
  }

  persist(): void {
    if (!this.state) return;
    const { justSteered, ...toPersist } = this.state;
    this.pi.appendEntry(ENTRY_TYPE, toPersist);
  }
}
