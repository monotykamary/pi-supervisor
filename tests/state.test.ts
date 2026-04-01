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

describe('SupervisorStateManager', () => {
  describe('reframe tier management', () => {
    it('initializes reframe tier to 0 on start', () => {
      const api = createMockApi();
      const state = new SupervisorStateManager(api);
      state.start('Test goal', 'anthropic', 'claude-haiku');

      expect(state.getReframeTier()).toBe(0);
      expect(state.getState()!.reframeTier).toBe(0);
      expect(state.getState()!.lastSteerTurn).toBe(-1);
    });

    it('escalates reframe tier up to max of 4', () => {
      const api = createMockApi();
      const state = new SupervisorStateManager(api);
      state.start('Test goal', 'anthropic', 'claude-haiku');

      expect(state.getReframeTier()).toBe(0);

      state.escalateReframeTier();
      expect(state.getReframeTier()).toBe(1);

      state.escalateReframeTier();
      expect(state.getReframeTier()).toBe(2);

      state.escalateReframeTier();
      expect(state.getReframeTier()).toBe(3);

      state.escalateReframeTier();
      expect(state.getReframeTier()).toBe(4);

      // Should not go above 4
      state.escalateReframeTier();
      expect(state.getReframeTier()).toBe(4);
    });

    it('resets reframe tier to 0', () => {
      const api = createMockApi();
      const state = new SupervisorStateManager(api);
      state.start('Test goal', 'anthropic', 'claude-haiku');

      state.escalateReframeTier();
      state.escalateReframeTier();
      expect(state.getReframeTier()).toBe(2);

      state.resetReframeTier();
      expect(state.getReframeTier()).toBe(0);
    });

    it('returns 0 when not active', () => {
      const api = createMockApi();
      const state = new SupervisorStateManager(api);
      expect(state.getReframeTier()).toBe(0);
    });

    it('persists reframe tier changes', () => {
      const api = createMockApi();
      const state = new SupervisorStateManager(api);
      state.start('Test goal', 'anthropic', 'claude-haiku');

      state.escalateReframeTier();

      expect(api.appendEntry).toHaveBeenLastCalledWith(
        'supervisor-state',
        expect.objectContaining({ reframeTier: 1 })
      );
    });

    it('tracks lastSteerTurn when adding intervention', () => {
      const api = createMockApi();
      const state = new SupervisorStateManager(api);
      state.start('Test goal', 'anthropic', 'claude-haiku');
      state.incrementTurnCount();
      state.incrementTurnCount();

      state.addIntervention({
        turnCount: 2,
        message: 'Please focus on X',
        reasoning: 'Agent drifted',
        timestamp: Date.now(),
      });

      expect(state.getState()!.lastSteerTurn).toBe(2);
    });
  });

  describe('ineffective pattern detection', () => {
    it('returns no pattern with less than 2 interventions', () => {
      const api = createMockApi();
      const state = new SupervisorStateManager(api);
      state.start('Test goal', 'anthropic', 'claude-haiku');

      const pattern = state.detectIneffectivePattern();
      expect(pattern.detected).toBe(false);
      expect(pattern.similarCount).toBe(0);
    });

    it('detects similar messages', () => {
      const api = createMockApi();
      const state = new SupervisorStateManager(api);
      state.start('Test goal', 'anthropic', 'claude-haiku');

      // Add similar interventions
      state.incrementTurnCount();
      state.addIntervention({
        turnCount: 1,
        message: 'Please implement the auth middleware',
        reasoning: 'Not done yet',
        timestamp: Date.now(),
      });

      state.incrementTurnCount();
      state.addIntervention({
        turnCount: 2,
        message: 'Please implement the auth middleware now',
        reasoning: 'Still not done',
        timestamp: Date.now(),
      });

      const pattern = state.detectIneffectivePattern();
      expect(pattern.detected).toBe(true);
      expect(pattern.similarCount).toBe(2);
    });

    it('detects lack of progress (3+ turns since steer)', () => {
      const api = createMockApi();
      const state = new SupervisorStateManager(api);
      state.start('Test goal', 'anthropic', 'claude-haiku');

      // Add intervention
      state.incrementTurnCount();
      state.addIntervention({
        turnCount: 1,
        message: 'Focus on X',
        reasoning: 'Test',
        timestamp: Date.now(),
      });

      // Advance 3 turns without steering
      state.incrementTurnCount(); // turn 2
      state.incrementTurnCount(); // turn 3
      state.incrementTurnCount(); // turn 4

      const pattern = state.detectIneffectivePattern();
      expect(pattern.detected).toBe(true);
      expect(pattern.turnsSinceLastSteer).toBe(3);
    });

    it('does not detect pattern when progress is being made', () => {
      const api = createMockApi();
      const state = new SupervisorStateManager(api);
      state.start('Test goal', 'anthropic', 'claude-haiku');

      // Add intervention
      state.incrementTurnCount();
      state.addIntervention({
        turnCount: 1,
        message: 'Focus on X',
        reasoning: 'Test',
        timestamp: Date.now(),
      });

      // Only 2 turns since steer
      state.incrementTurnCount();
      state.incrementTurnCount();

      const pattern = state.detectIneffectivePattern();
      expect(pattern.detected).toBe(false);
      expect(pattern.turnsSinceLastSteer).toBe(2);
    });

    it('detects dissimilar messages as different', () => {
      const api = createMockApi();
      const state = new SupervisorStateManager(api);
      state.start('Test goal', 'anthropic', 'claude-haiku');

      state.incrementTurnCount();
      state.addIntervention({
        turnCount: 1,
        message: 'Implement the database layer',
        reasoning: 'Need DB',
        timestamp: Date.now(),
      });

      state.incrementTurnCount();
      state.addIntervention({
        turnCount: 2,
        message: 'Now create the API endpoints',
        reasoning: 'Need API',
        timestamp: Date.now(),
      });

      const pattern = state.detectIneffectivePattern();
      expect(pattern.detected).toBe(false);
      expect(pattern.similarCount).toBe(1);
    });
  });

  describe('basic lifecycle', () => {
    it('starts inactive', () => {
      const api = createMockApi();
      const state = new SupervisorStateManager(api);
      expect(state.isActive()).toBe(false);
      expect(state.getState()).toBeNull();
    });

    it('starts supervision with correct initial state', () => {
      const api = createMockApi();
      const state = new SupervisorStateManager(api);

      state.start('Test goal', 'anthropic', 'claude-haiku');

      expect(state.isActive()).toBe(true);
      const s = state.getState();
      expect(s).not.toBeNull();
      expect(s!.outcome).toBe('Test goal');
      expect(s!.provider).toBe('anthropic');
      expect(s!.modelId).toBe('claude-haiku');
      expect(s!.interventions).toEqual([]);
      expect(s!.turnCount).toBe(0);
      expect(s!.snapshotBuffer).toEqual([]);
      expect(s!.justSteered).toBe(false);
    });

    it('stops supervision and marks inactive', () => {
      const api = createMockApi();
      const state = new SupervisorStateManager(api);

      state.start('Test goal', 'anthropic', 'claude-haiku');
      expect(state.isActive()).toBe(true);

      state.stop();
      expect(state.isActive()).toBe(false);
      expect(state.getState()!.active).toBe(false);
    });

    it('persists state on start and stop', () => {
      const api = createMockApi();
      const state = new SupervisorStateManager(api);

      state.start('Test goal', 'anthropic', 'claude-haiku');
      expect(api.appendEntry).toHaveBeenCalledTimes(1);
      expect(api.appendEntry).toHaveBeenCalledWith(
        'supervisor-state',
        expect.objectContaining({
          active: true,
          outcome: 'Test goal',
        })
      );

      state.stop();
      expect(api.appendEntry).toHaveBeenCalledTimes(2);
      expect(api.appendEntry).toHaveBeenLastCalledWith(
        'supervisor-state',
        expect.objectContaining({ active: false })
      );
    });
  });

  describe('turn management', () => {
    it('increments turn count', () => {
      const api = createMockApi();
      const state = new SupervisorStateManager(api);
      state.start('Test goal', 'anthropic', 'claude-haiku');

      expect(state.getState()!.turnCount).toBe(0);
      state.incrementTurnCount();
      expect(state.getState()!.turnCount).toBe(1);
      state.incrementTurnCount();
      expect(state.getState()!.turnCount).toBe(2);
    });
  });

  describe('interventions', () => {
    it('adds intervention with correct data', () => {
      const api = createMockApi();
      const state = new SupervisorStateManager(api);
      state.start('Test goal', 'anthropic', 'claude-haiku');
      state.incrementTurnCount();

      const intervention = {
        turnCount: 1,
        message: 'Please focus on X',
        reasoning: 'Agent drifted',
        timestamp: Date.now(),
      };

      state.addIntervention(intervention);

      const s = state.getState()!;
      expect(s.interventions).toHaveLength(1);
      expect(s.interventions[0]).toEqual(intervention);
      expect(s.justSteered).toBe(true);
    });

    it('clears justSteered flag', () => {
      const api = createMockApi();
      const state = new SupervisorStateManager(api);
      state.start('Test goal', 'anthropic', 'claude-haiku');

      state.addIntervention({
        turnCount: 1,
        message: 'Steer',
        reasoning: 'Test',
        timestamp: Date.now(),
      });
      expect(state.getState()!.justSteered).toBe(true);

      state.clearJustSteered();
      expect(state.getState()!.justSteered).toBe(false);
    });

    it('does not add intervention when not active', () => {
      const api = createMockApi();
      const state = new SupervisorStateManager(api);

      state.addIntervention({
        turnCount: 1,
        message: 'Steer',
        reasoning: 'Test',
        timestamp: Date.now(),
      });

      // Should not throw, should just return
      expect(state.getState()).toBeNull();
    });
  });

  describe('shouldAnalyzeMidRun', () => {
    it('returns false when justSteered is false and turn not divisible by 8', () => {
      const api = createMockApi();
      const state = new SupervisorStateManager(api);
      state.start('Test goal', 'anthropic', 'claude-haiku');

      expect(state.shouldAnalyzeMidRun(1)).toBe(false);
      expect(state.shouldAnalyzeMidRun(2)).toBe(false);
      expect(state.shouldAnalyzeMidRun(7)).toBe(false);
    });

    it('returns true when justSteered is true', () => {
      const api = createMockApi();
      const state = new SupervisorStateManager(api);
      state.start('Test goal', 'anthropic', 'claude-haiku');

      state.addIntervention({
        turnCount: 1,
        message: 'Steer',
        reasoning: 'Test',
        timestamp: Date.now(),
      });

      expect(state.shouldAnalyzeMidRun(1)).toBe(true);
    });

    it('returns true every 8th turn (safety valve)', () => {
      const api = createMockApi();
      const state = new SupervisorStateManager(api);
      state.start('Test goal', 'anthropic', 'claude-haiku');

      expect(state.shouldAnalyzeMidRun(8)).toBe(true);
      expect(state.shouldAnalyzeMidRun(16)).toBe(true);
      expect(state.shouldAnalyzeMidRun(24)).toBe(true);
    });

    it('returns true when both conditions met', () => {
      const api = createMockApi();
      const state = new SupervisorStateManager(api);
      state.start('Test goal', 'anthropic', 'claude-haiku');

      state.addIntervention({
        turnCount: 1,
        message: 'Steer',
        reasoning: 'Test',
        timestamp: Date.now(),
      });

      // Both justSteered and 8th turn
      expect(state.shouldAnalyzeMidRun(8)).toBe(true);
    });

    it('returns false when not active', () => {
      const api = createMockApi();
      const state = new SupervisorStateManager(api);

      expect(state.shouldAnalyzeMidRun(8)).toBe(false);
    });
  });

  describe('model management', () => {
    it('updates model when active', () => {
      const api = createMockApi();
      const state = new SupervisorStateManager(api);
      state.start('Test goal', 'anthropic', 'claude-haiku');

      state.setModel('openai', 'gpt-4o');

      const s = state.getState()!;
      expect(s.provider).toBe('openai');
      expect(s.modelId).toBe('gpt-4o');
    });

    it('does not update model when not active', () => {
      const api = createMockApi();
      const state = new SupervisorStateManager(api);

      // Should not throw
      state.setModel('openai', 'gpt-4o');
      expect(state.getState()).toBeNull();
    });
  });

  describe('snapshot buffer', () => {
    it('updates and retrieves snapshot buffer', () => {
      const api = createMockApi();
      const state = new SupervisorStateManager(api);
      state.start('Test goal', 'anthropic', 'claude-haiku');

      const messages = [
        { role: 'user' as const, content: 'Hello' },
        { role: 'assistant' as const, content: 'Hi there' },
      ];

      state.updateSnapshotBuffer(messages);

      expect(state.getSnapshotBuffer()).toEqual(messages);
      expect(state.getState()!.lastAnalyzedTurn).toBe(0);
    });

    it('returns empty array when not active', () => {
      const api = createMockApi();
      const state = new SupervisorStateManager(api);

      expect(state.getSnapshotBuffer()).toEqual([]);
    });
  });
});
