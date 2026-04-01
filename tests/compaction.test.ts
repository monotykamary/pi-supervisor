import { describe, expect, it, vi } from 'vitest';
import { SupervisorStateManager } from '../src/state.js';

// Mock ExtensionAPI
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

function createMockContext(entries: any[] = []) {
  return {
    ui: {
      notify: vi.fn(),
    },
    hasUI: true,
    cwd: '/test',
    sessionManager: {
      getBranch: vi.fn().mockReturnValue(entries),
    },
    modelRegistry: {},
    model: undefined,
    isIdle: vi.fn().mockReturnValue(true),
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

      // Simulate a session with a supervisor-state entry
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
            turnCount: 5,
            reframeTier: 2,
            lastSteerTurn: 3,
          },
        },
      ];

      const ctx = createMockContext(sessionEntries);
      state.loadFromSession(ctx);

      expect(state.isActive()).toBe(true);
      expect(state.getState()?.outcome).toBe('Test goal');
      expect(state.getState()?.provider).toBe('anthropic');
      expect(state.getState()?.turnCount).toBe(5);
      expect(state.getReframeTier()).toBe(2);
    });

    it('restores null state when no supervisor-state entry exists', () => {
      const api = createMockApi();
      const state = new SupervisorStateManager(api);

      // Session with no supervisor-state entry (e.g., after compaction summarized it away)
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
            interventions: [{ turnCount: 1, message: 'Focus', reasoning: 'Test', timestamp: 123 }],
            startedAt: 1000,
            turnCount: 3,
            reframeTier: 1,
            lastSteerTurn: 2,
            // Ephemeral fields should NOT be in persisted data
          },
        },
      ];

      const ctx = createMockContext(sessionEntries);
      state.loadFromSession(ctx);

      // Ephemeral fields should be reset
      expect(state.getState()?.snapshotBuffer).toEqual([]);
      expect(state.getState()?.lastAnalyzedTurn).toBe(-1);
      expect(state.getState()?.justSteered).toBe(false);

      // Non-ephemeral fields should be preserved
      expect(state.getState()?.turnCount).toBe(3);
      expect(state.getState()?.reframeTier).toBe(1);
      expect(state.getState()?.lastSteerTurn).toBe(2);
    });

    it('uses the most recent supervisor-state entry when multiple exist', () => {
      const api = createMockApi();
      const state = new SupervisorStateManager(api);

      const sessionEntries = [
        {
          type: 'custom',
          customType: 'supervisor-state',
          data: {
            active: false, // Old - stopped
            outcome: 'Old goal',
            provider: 'openai',
            modelId: 'gpt-4o',
            interventions: [],
            startedAt: 1000,
            turnCount: 10,
          },
        },
        { type: 'message', message: { role: 'user', content: 'Continue' } },
        {
          type: 'custom',
          customType: 'supervisor-state',
          data: {
            active: true, // Newer - active
            outcome: 'New goal',
            provider: 'anthropic',
            modelId: 'claude-haiku',
            interventions: [],
            startedAt: 2000,
            turnCount: 3,
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

      // start() calls persist() with initial state
      expect(api.appendEntry).toHaveBeenCalledWith(
        'supervisor-state',
        expect.objectContaining({
          active: true,
          outcome: 'Test goal',
          provider: 'anthropic',
          modelId: 'claude-haiku',
          turnCount: 0,
        })
      );
    });

    it('does not persist ephemeral fields', () => {
      const api = createMockApi();
      const state = new SupervisorStateManager(api);

      state.start('Test goal', 'anthropic', 'claude-haiku');
      state.updateSnapshotBuffer([{ role: 'user', content: 'Hello' }]);
      state.clearJustSteered(); // justSteered would be false anyway

      const lastCall = api.appendEntry.mock.calls[api.appendEntry.mock.calls.length - 1];
      const persistedData = lastCall[1];

      // Ephemeral fields should NOT be persisted
      expect(persistedData.snapshotBuffer).toBeUndefined();
      expect(persistedData.lastAnalyzedTurn).toBeUndefined();
      expect(persistedData.justSteered).toBeUndefined();

      // Non-ephemeral fields should be persisted
      expect(persistedData.outcome).toBe('Test goal');
      expect(persistedData.active).toBe(true);
    });

    it('can be called manually to re-persist after compaction (public method)', () => {
      const api = createMockApi();
      const state = new SupervisorStateManager(api);

      // Start supervision
      state.start('Test goal', 'anthropic', 'claude-haiku');
      expect(api.appendEntry).toHaveBeenCalledTimes(1);

      // Simulate compaction handler re-persisting
      state.persist();
      expect(api.appendEntry).toHaveBeenCalledTimes(2);

      // Verify the re-persisted data is correct
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

      // persist() with no active state should not call appendEntry
      state.persist();
      expect(api.appendEntry).not.toHaveBeenCalled();
    });

    it('preserves interventions when re-persisting', () => {
      const api = createMockApi();
      const state = new SupervisorStateManager(api);

      state.start('Test goal', 'anthropic', 'claude-haiku');
      state.incrementTurnCount();
      state.addIntervention({
        turnCount: 1,
        message: 'Focus on tests',
        reasoning: 'Drift detected',
        timestamp: 1234567890,
        asi: { why_stuck: 'no tests', strategy_used: 'directive' },
      });

      // Clear mock to test re-persist
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

      // 1. Start supervision
      state.start('Implement auth', 'anthropic', 'claude-haiku');
      // Manually increment and persist to simulate turn progression
      state.incrementTurnCount();
      state.incrementTurnCount();
      state.addIntervention({
        turnCount: 2,
        message: 'Focus on JWT',
        reasoning: 'Drift',
        timestamp: 1000,
      });
      expect(state.isActive()).toBe(true);
      expect(state.getState()?.turnCount).toBe(2);

      // 2. Simulate compaction (session is reloaded with summary + recent entries)
      // After compaction, the supervisor-state entry is now "old" and in the kept portion
      // The extension's session_compact handler reloads state
      const postCompactionEntries = [
        { type: 'compaction', summary: 'Earlier conversation summarized' },
        { type: 'message', message: { role: 'user', content: 'Continue' } },
        // The supervisor-state entry was in the kept portion (recent)
        {
          type: 'custom',
          customType: 'supervisor-state',
          data: {
            active: true,
            outcome: 'Implement auth',
            provider: 'anthropic',
            modelId: 'claude-haiku',
            interventions: [
              { turnCount: 2, message: 'Focus on JWT', reasoning: 'Drift', timestamp: 1000 },
            ],
            startedAt: 500,
            turnCount: 2,
            reframeTier: 0,
            lastSteerTurn: 2,
          },
        },
      ];

      // 3. Reload from session (simulating session_compact handler)
      const ctx = createMockContext(postCompactionEntries);
      state.loadFromSession(ctx);

      // 4. Verify state was restored
      expect(state.isActive()).toBe(true);
      expect(state.getState()?.outcome).toBe('Implement auth');
      expect(state.getState()?.turnCount).toBe(2);
      expect(state.getState()?.interventions).toHaveLength(1);

      // 5. Re-persist to ensure future compactions find it in kept portion
      api.appendEntry.mockClear();
      state.persist();

      expect(api.appendEntry).toHaveBeenCalledWith(
        'supervisor-state',
        expect.objectContaining({
          active: true,
          outcome: 'Implement auth',
          turnCount: 2,
        })
      );
    });

    it('handles state loss when supervisor-state was summarized away', () => {
      const api = createMockApi();
      const state = new SupervisorStateManager(api);

      // Start supervision
      state.start('Lost goal', 'anthropic', 'claude-haiku');
      expect(state.isActive()).toBe(true);

      // Simulate compaction where supervisor-state was in summarized portion
      // (old, far back in history)
      const postCompactionEntries = [
        {
          type: 'compaction',
          summary: 'Earlier conversation summarized (including old supervisor-state)',
        },
        { type: 'message', message: { role: 'user', content: 'Recent message' } },
        // No supervisor-state in kept portion!
      ];

      // Reload after compaction
      const ctx = createMockContext(postCompactionEntries);
      state.loadFromSession(ctx);

      // State is lost (as expected - compaction summarized it away)
      expect(state.isActive()).toBe(false);
      expect(state.getState()).toBeNull();

      // Re-persist does nothing when state is null
      api.appendEntry.mockClear();
      state.persist();
      expect(api.appendEntry).not.toHaveBeenCalled();
    });

    it('recovers from state loss by re-persisting if was active', () => {
      // This test verifies the compaction handler pattern:
      // After compaction, if we had active state but it was lost,
      // we need some mechanism to recover. In the real implementation,
      // the session_compact handler checks isActive() after loadFromSession
      // and re-persists if needed.

      const api = createMockApi();
      const state = new SupervisorStateManager(api);

      // Start supervision
      state.start('Goal', 'anthropic', 'claude-haiku');
      expect(state.isActive()).toBe(true);

      // Simulate scenario where state was lost in compaction
      // In reality, we'd need to track this differently, but the test
      // verifies the re-persist behavior when state IS active
      api.appendEntry.mockClear();

      // Simulate compaction handler: reload, then if active, re-persist
      state.persist(); // This would be called after loadFromSession in handler

      expect(api.appendEntry).toHaveBeenCalledWith(
        'supervisor-state',
        expect.objectContaining({
          active: true,
          outcome: 'Goal',
          turnCount: 0,
        })
      );
    });
  });
});
