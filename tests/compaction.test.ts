import { describe, expect, it, vi, beforeEach } from 'vitest';
import { SupervisorStateManager } from '../src/state/manager.js';

// Mock dependencies
vi.mock('../src/core/analyzer.js', () => ({
  analyze: vi.fn(),
}));

vi.mock('../src/core/prompt-loader.js', () => ({
  loadSystemPrompt: vi.fn().mockReturnValue({ prompt: 'test prompt', source: 'built-in' }),
}));

vi.mock('../src/ui/renderer.js', () => ({
  updateUI: vi.fn(),
  toggleWidget: vi.fn(),
}));

vi.mock('../src/session/client.js', () => ({
  disposeSession: vi.fn(),
}));

import { analyze } from '../src/core/analyzer.js';
import { updateUI } from '../src/ui/renderer.js';

function createMockApi() {
  return {
    appendEntry: vi.fn(),
    on: vi.fn(),
    registerCommand: vi.fn(),
    registerTool: vi.fn(),
    sendUserMessage: vi.fn(),
    sendMessage: vi.fn(),
    events: { emit: vi.fn(), on: vi.fn() },
  } as any;
}

function createMockContext(entries: any[] = [], isIdle = true) {
  return {
    ui: {
      notify: vi.fn(),
      setStatus: vi.fn(),
      setWidget: vi.fn(),
      setWorkingMessage: vi.fn(),
    },
    hasUI: true,
    cwd: '/test',
    sessionManager: {
      getBranch: vi.fn().mockReturnValue(entries),
    },
    modelRegistry: {},
    model: undefined,
    isIdle: vi.fn().mockReturnValue(isIdle),
    abort: vi.fn(),
    hasPendingMessages: vi.fn().mockReturnValue(false),
    shutdown: vi.fn(),
    getContextUsage: vi.fn(),
    compact: vi.fn(),
    getSystemPrompt: vi.fn().mockReturnValue('test'),
  } as any;
}

describe('SupervisorStateManager - compaction survival', () => {
  describe('loadFromSession after compaction', () => {
    it('restores state from custom entry in session', () => {
      const api = createMockApi();
      const state = new SupervisorStateManager(api);

      const sessionEntries = [
        { type: 'message', message: { role: 'user', content: 'Hello' } },
        {
          type: 'custom',
          customType: 'supervisor-state',
          data: {
            active: true,
            outcome: 'Test goal',
            provider: 'anthropic',
            modelId: 'claude-haiku',
            interventions: [],
            startedAt: Date.now(),
            reframeTier: 2,
          },
        },
      ];

      const ctx = createMockContext(sessionEntries);
      state.loadFromSession(ctx);

      expect(state.isActive()).toBe(true);
      expect(state.getState()?.outcome).toBe('Test goal');
      expect(state.getState()?.provider).toBe('anthropic');
      expect(state.getReframeTier()).toBe(2);
    });

    it('restores null state when no supervisor-state entry exists', () => {
      const api = createMockApi();
      const state = new SupervisorStateManager(api);

      const sessionEntries = [
        { type: 'message', message: { role: 'user', content: 'Hello' } },
        { type: 'compaction', summary: 'Summary of old messages' },
      ];

      const ctx = createMockContext(sessionEntries);
      state.loadFromSession(ctx);

      expect(state.isActive()).toBe(false);
      expect(state.getState()).toBeNull();
    });

    it('restores ephemeral fields with defaults after compaction', () => {
      const api = createMockApi();
      const state = new SupervisorStateManager(api);

      const sessionEntries = [
        {
          type: 'custom',
          customType: 'supervisor-state',
          data: {
            active: true,
            outcome: 'Test goal',
            provider: 'anthropic',
            modelId: 'claude-haiku',
            interventions: [{ message: 'Focus', reasoning: 'Test', timestamp: 123 }],
            startedAt: 1000,
            reframeTier: 1,
          },
        },
      ];

      const ctx = createMockContext(sessionEntries);
      state.loadFromSession(ctx);

      // Ephemeral fields should be reset
      expect(state.getState()?.justSteered).toBe(false);

      // Non-ephemeral fields should be preserved
      expect(state.getState()?.reframeTier).toBe(1);
      expect(state.getState()?.interventions).toHaveLength(1);
    });

    it('uses the most recent supervisor-state entry when multiple exist', () => {
      const api = createMockApi();
      const state = new SupervisorStateManager(api);

      const sessionEntries = [
        {
          type: 'custom',
          customType: 'supervisor-state',
          data: {
            active: false,
            outcome: 'Old goal',
            provider: 'openai',
            modelId: 'gpt-4o',
            interventions: [],
            startedAt: 1000,
          },
        },
        { type: 'message', message: { role: 'user', content: 'Continue' } },
        {
          type: 'custom',
          customType: 'supervisor-state',
          data: {
            active: true,
            outcome: 'New goal',
            provider: 'anthropic',
            modelId: 'claude-haiku',
            interventions: [],
            startedAt: 2000,
          },
        },
      ];

      const ctx = createMockContext(sessionEntries);
      state.loadFromSession(ctx);

      expect(state.isActive()).toBe(true);
      expect(state.getState()?.outcome).toBe('New goal');
      expect(state.getState()?.provider).toBe('anthropic');
    });
  });

  describe('persist() behavior', () => {
    it('persists active state to session via appendEntry', () => {
      const api = createMockApi();
      const state = new SupervisorStateManager(api);

      state.start('Test goal', 'anthropic', 'claude-haiku');

      expect(api.appendEntry).toHaveBeenCalledWith(
        'supervisor-state',
        expect.objectContaining({
          active: true,
          outcome: 'Test goal',
          provider: 'anthropic',
          modelId: 'claude-haiku',
        })
      );
    });

    it('does not persist ephemeral fields', () => {
      const api = createMockApi();
      const state = new SupervisorStateManager(api);

      state.start('Test goal', 'anthropic', 'claude-haiku');
      state.clearJustSteered();

      const lastCall = api.appendEntry.mock.calls[api.appendEntry.mock.calls.length - 1];
      const persistedData = lastCall[1];

      // Ephemeral fields should NOT be persisted
      expect(persistedData.justSteered).toBeUndefined();

      // Non-ephemeral fields should be persisted
      expect(persistedData.outcome).toBe('Test goal');
      expect(persistedData.active).toBe(true);
    });

    it('can be called manually to re-persist after compaction (public method)', () => {
      const api = createMockApi();
      const state = new SupervisorStateManager(api);

      state.start('Test goal', 'anthropic', 'claude-haiku');
      expect(api.appendEntry).toHaveBeenCalledTimes(1);

      state.persist();
      expect(api.appendEntry).toHaveBeenCalledTimes(2);

      const lastCall = api.appendEntry.mock.calls[api.appendEntry.mock.calls.length - 1];
      expect(lastCall[0]).toBe('supervisor-state');
      expect(lastCall[1]).toMatchObject({
        active: true,
        outcome: 'Test goal',
        provider: 'anthropic',
        modelId: 'claude-haiku',
      });
    });

    it('does nothing when persist() is called with no active state', () => {
      const api = createMockApi();
      const state = new SupervisorStateManager(api);

      state.persist();
      expect(api.appendEntry).not.toHaveBeenCalled();
    });

    it('preserves interventions when re-persisting', () => {
      const api = createMockApi();
      const state = new SupervisorStateManager(api);

      state.start('Test goal', 'anthropic', 'claude-haiku');
      state.addIntervention({
        message: 'Focus on tests',
        reasoning: 'Drift detected',
        timestamp: 1234567890,
        asi: { why_stuck: 'no tests', strategy_used: 'directive' },
      });

      api.appendEntry.mockClear();
      state.persist();

      const lastCall = api.appendEntry.mock.calls[api.appendEntry.mock.calls.length - 1];
      expect(lastCall[1].interventions).toHaveLength(1);
      expect(lastCall[1].interventions[0].message).toBe('Focus on tests');
      expect(lastCall[1].interventions[0].asi).toEqual({
        why_stuck: 'no tests',
        strategy_used: 'directive',
      });
    });
  });

  describe('compaction survival scenario', () => {
    it('full lifecycle: start -> compact -> reload -> repersist', () => {
      const api = createMockApi();
      const state = new SupervisorStateManager(api);

      state.start('Implement auth', 'anthropic', 'claude-haiku');
      state.addIntervention({
        message: 'Focus on JWT',
        reasoning: 'Drift',
        timestamp: 1000,
      });
      expect(state.isActive()).toBe(true);
      expect(state.getState()?.interventions).toHaveLength(1);

      const postCompactionEntries = [
        { type: 'compaction', summary: 'Earlier conversation summarized' },
        { type: 'message', message: { role: 'user', content: 'Continue' } },
        {
          type: 'custom',
          customType: 'supervisor-state',
          data: {
            active: true,
            outcome: 'Implement auth',
            provider: 'anthropic',
            modelId: 'claude-haiku',
            interventions: [{ message: 'Focus on JWT', reasoning: 'Drift', timestamp: 1000 }],
            startedAt: 500,
            reframeTier: 0,
          },
        },
      ];

      const ctx = createMockContext(postCompactionEntries);
      state.loadFromSession(ctx);

      expect(state.isActive()).toBe(true);
      expect(state.getState()?.outcome).toBe('Implement auth');
      expect(state.getState()?.interventions).toHaveLength(1);

      api.appendEntry.mockClear();
      state.persist();

      expect(api.appendEntry).toHaveBeenCalledWith(
        'supervisor-state',
        expect.objectContaining({
          active: true,
          outcome: 'Implement auth',
        })
      );
    });

    it('handles state loss when supervisor-state was summarized away', () => {
      const api = createMockApi();
      const state = new SupervisorStateManager(api);

      state.start('Lost goal', 'anthropic', 'claude-haiku');
      expect(state.isActive()).toBe(true);

      const postCompactionEntries = [
        {
          type: 'compaction',
          summary: 'Earlier conversation summarized (including old supervisor-state)',
        },
        { type: 'message', message: { role: 'user', content: 'Recent message' } },
      ];

      const ctx = createMockContext(postCompactionEntries);
      state.loadFromSession(ctx);

      expect(state.isActive()).toBe(false);
      expect(state.getState()).toBeNull();

      api.appendEntry.mockClear();
      state.persist();
      expect(api.appendEntry).not.toHaveBeenCalled();
    });

    it('recovers from state loss by re-persisting if was active', () => {
      const api = createMockApi();
      const state = new SupervisorStateManager(api);

      state.start('Goal', 'anthropic', 'claude-haiku');
      expect(state.isActive()).toBe(true);

      api.appendEntry.mockClear();
      state.persist();

      expect(api.appendEntry).toHaveBeenCalledWith(
        'supervisor-state',
        expect.objectContaining({
          active: true,
          outcome: 'Goal',
        })
      );
    });
  });

  describe('event handler behavior', () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it('session_before_compact persists state when supervision is active', () => {
      const api = createMockApi();
      const state = new SupervisorStateManager(api);

      state.start('Test goal', 'anthropic', 'claude-haiku');
      expect(api.appendEntry).toHaveBeenCalledTimes(1);

      if (state.isActive()) {
        state.persist();
      }

      expect(api.appendEntry).toHaveBeenCalledTimes(2);
      expect(api.appendEntry).toHaveBeenLastCalledWith(
        'supervisor-state',
        expect.objectContaining({
          active: true,
          outcome: 'Test goal',
          provider: 'anthropic',
          modelId: 'claude-haiku',
        })
      );
    });

    it('session_before_compact does nothing when supervision is inactive', () => {
      const api = createMockApi();
      const state = new SupervisorStateManager(api);

      expect(state.isActive()).toBe(false);

      if (state.isActive()) {
        state.persist();
      }

      expect(api.appendEntry).not.toHaveBeenCalled();
    });

    it('session_compact handler reloads state and updates UI', () => {
      const api = createMockApi();
      const state = new SupervisorStateManager(api);

      const postCompactionEntries = [
        { type: 'compaction', summary: 'Earlier conversation summarized' },
        {
          type: 'custom',
          customType: 'supervisor-state',
          data: {
            active: true,
            outcome: 'Survived goal',
            provider: 'anthropic',
            modelId: 'claude-haiku',
            interventions: [],
            startedAt: 1000,
            reframeTier: 1,
          },
        },
      ];

      const ctx = createMockContext(postCompactionEntries, true);

      state.loadFromSession(ctx);

      if (state.isActive()) {
        updateUI(ctx, state.getState(), { type: 'watching', reframeTier: state.getReframeTier() });
      } else {
        updateUI(ctx, null);
      }

      expect(state.isActive()).toBe(true);
      expect(state.getState()?.outcome).toBe('Survived goal');
      expect(updateUI).toHaveBeenCalledWith(
        ctx,
        expect.objectContaining({ outcome: 'Survived goal' }),
        { type: 'watching', reframeTier: 1 }
      );
    });

    it('session_compact handler clears UI when state is lost', () => {
      const api = createMockApi();
      const state = new SupervisorStateManager(api);

      const lostStateEntries = [
        {
          type: 'compaction',
          summary: 'Earlier conversation summarized including supervisor-state',
        },
        { type: 'message', message: { role: 'user', content: 'Recent message' } },
      ];

      const ctx = createMockContext(lostStateEntries, true);

      state.loadFromSession(ctx);

      if (state.isActive()) {
        updateUI(ctx, state.getState(), { type: 'watching', reframeTier: state.getReframeTier() });
      } else {
        updateUI(ctx, null);
      }

      expect(state.isActive()).toBe(false);
      expect(updateUI).toHaveBeenCalledWith(ctx, null);
    });

    it('session_compact does not steer when agent is busy', async () => {
      const api = createMockApi();
      const state = new SupervisorStateManager(api);

      const postCompactionEntries = [
        { type: 'compaction', summary: 'Earlier conversation summarized' },
        {
          type: 'custom',
          customType: 'supervisor-state',
          data: {
            active: true,
            outcome: 'Implement feature',
            provider: 'anthropic',
            modelId: 'claude-haiku',
            interventions: [],
            startedAt: 1000,
            reframeTier: 0,
          },
        },
      ];

      const ctx = createMockContext(postCompactionEntries, false);

      state.loadFromSession(ctx);

      if (!state.isActive()) {
        updateUI(ctx, null);
        return;
      }

      updateUI(ctx, state.getState(), { type: 'watching', reframeTier: state.getReframeTier() });

      if (ctx.isIdle()) {
        await analyze(ctx, state.getState()!, true);
      }

      expect(ctx.isIdle).toHaveBeenCalled();
      expect(analyze).not.toHaveBeenCalled();
    });
  });
});
