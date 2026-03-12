import { describe, expect, it, vi } from "vitest";
import { SupervisorStateManager } from "../src/state.js";

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

describe("SupervisorStateManager", () => {
  describe("basic lifecycle", () => {
    it("starts inactive", () => {
      const api = createMockApi();
      const state = new SupervisorStateManager(api);
      expect(state.isActive()).toBe(false);
      expect(state.getState()).toBeNull();
    });

    it("starts supervision with correct initial state", () => {
      const api = createMockApi();
      const state = new SupervisorStateManager(api);
      
      state.start("Test goal", "anthropic", "claude-haiku");
      
      expect(state.isActive()).toBe(true);
      const s = state.getState();
      expect(s).not.toBeNull();
      expect(s!.outcome).toBe("Test goal");
      expect(s!.provider).toBe("anthropic");
      expect(s!.modelId).toBe("claude-haiku");
      expect(s!.interventions).toEqual([]);
      expect(s!.turnCount).toBe(0);
      expect(s!.snapshotBuffer).toEqual([]);
      expect(s!.justSteered).toBe(false);
    });

    it("stops supervision and marks inactive", () => {
      const api = createMockApi();
      const state = new SupervisorStateManager(api);
      
      state.start("Test goal", "anthropic", "claude-haiku");
      expect(state.isActive()).toBe(true);
      
      state.stop();
      expect(state.isActive()).toBe(false);
      expect(state.getState()!.active).toBe(false);
    });

    it("persists state on start and stop", () => {
      const api = createMockApi();
      const state = new SupervisorStateManager(api);
      
      state.start("Test goal", "anthropic", "claude-haiku");
      expect(api.appendEntry).toHaveBeenCalledTimes(1);
      expect(api.appendEntry).toHaveBeenCalledWith(
        "supervisor-state",
        expect.objectContaining({
          active: true,
          outcome: "Test goal",
        })
      );
      
      state.stop();
      expect(api.appendEntry).toHaveBeenCalledTimes(2);
      expect(api.appendEntry).toHaveBeenLastCalledWith(
        "supervisor-state",
        expect.objectContaining({ active: false })
      );
    });
  });

  describe("turn management", () => {
    it("increments turn count", () => {
      const api = createMockApi();
      const state = new SupervisorStateManager(api);
      state.start("Test goal", "anthropic", "claude-haiku");
      
      expect(state.getState()!.turnCount).toBe(0);
      state.incrementTurnCount();
      expect(state.getState()!.turnCount).toBe(1);
      state.incrementTurnCount();
      expect(state.getState()!.turnCount).toBe(2);
    });
  });

  describe("interventions", () => {
    it("adds intervention with correct data", () => {
      const api = createMockApi();
      const state = new SupervisorStateManager(api);
      state.start("Test goal", "anthropic", "claude-haiku");
      state.incrementTurnCount();
      
      const intervention = {
        turnCount: 1,
        message: "Please focus on X",
        reasoning: "Agent drifted",
        timestamp: Date.now(),
      };
      
      state.addIntervention(intervention);
      
      const s = state.getState()!;
      expect(s.interventions).toHaveLength(1);
      expect(s.interventions[0]).toEqual(intervention);
      expect(s.justSteered).toBe(true);
    });

    it("clears justSteered flag", () => {
      const api = createMockApi();
      const state = new SupervisorStateManager(api);
      state.start("Test goal", "anthropic", "claude-haiku");
      
      state.addIntervention({
        turnCount: 1,
        message: "Steer",
        reasoning: "Test",
        timestamp: Date.now(),
      });
      expect(state.getState()!.justSteered).toBe(true);
      
      state.clearJustSteered();
      expect(state.getState()!.justSteered).toBe(false);
    });

    it("does not add intervention when not active", () => {
      const api = createMockApi();
      const state = new SupervisorStateManager(api);
      
      state.addIntervention({
        turnCount: 1,
        message: "Steer",
        reasoning: "Test",
        timestamp: Date.now(),
      });
      
      // Should not throw, should just return
      expect(state.getState()).toBeNull();
    });
  });

  describe("shouldAnalyzeMidRun", () => {
    it("returns false when justSteered is false and turn not divisible by 8", () => {
      const api = createMockApi();
      const state = new SupervisorStateManager(api);
      state.start("Test goal", "anthropic", "claude-haiku");
      
      expect(state.shouldAnalyzeMidRun(1)).toBe(false);
      expect(state.shouldAnalyzeMidRun(2)).toBe(false);
      expect(state.shouldAnalyzeMidRun(7)).toBe(false);
    });

    it("returns true when justSteered is true", () => {
      const api = createMockApi();
      const state = new SupervisorStateManager(api);
      state.start("Test goal", "anthropic", "claude-haiku");
      
      state.addIntervention({
        turnCount: 1,
        message: "Steer",
        reasoning: "Test",
        timestamp: Date.now(),
      });
      
      expect(state.shouldAnalyzeMidRun(1)).toBe(true);
    });

    it("returns true every 8th turn (safety valve)", () => {
      const api = createMockApi();
      const state = new SupervisorStateManager(api);
      state.start("Test goal", "anthropic", "claude-haiku");
      
      expect(state.shouldAnalyzeMidRun(8)).toBe(true);
      expect(state.shouldAnalyzeMidRun(16)).toBe(true);
      expect(state.shouldAnalyzeMidRun(24)).toBe(true);
    });

    it("returns true when both conditions met", () => {
      const api = createMockApi();
      const state = new SupervisorStateManager(api);
      state.start("Test goal", "anthropic", "claude-haiku");
      
      state.addIntervention({
        turnCount: 1,
        message: "Steer",
        reasoning: "Test",
        timestamp: Date.now(),
      });
      
      // Both justSteered and 8th turn
      expect(state.shouldAnalyzeMidRun(8)).toBe(true);
    });

    it("returns false when not active", () => {
      const api = createMockApi();
      const state = new SupervisorStateManager(api);
      
      expect(state.shouldAnalyzeMidRun(8)).toBe(false);
    });
  });

  describe("model management", () => {
    it("updates model when active", () => {
      const api = createMockApi();
      const state = new SupervisorStateManager(api);
      state.start("Test goal", "anthropic", "claude-haiku");
      
      state.setModel("openai", "gpt-4o");
      
      const s = state.getState()!;
      expect(s.provider).toBe("openai");
      expect(s.modelId).toBe("gpt-4o");
    });

    it("does not update model when not active", () => {
      const api = createMockApi();
      const state = new SupervisorStateManager(api);
      
      // Should not throw
      state.setModel("openai", "gpt-4o");
      expect(state.getState()).toBeNull();
    });
  });

  describe("snapshot buffer", () => {
    it("updates and retrieves snapshot buffer", () => {
      const api = createMockApi();
      const state = new SupervisorStateManager(api);
      state.start("Test goal", "anthropic", "claude-haiku");
      
      const messages = [
        { role: "user" as const, content: "Hello" },
        { role: "assistant" as const, content: "Hi there" },
      ];
      
      state.updateSnapshotBuffer(messages);
      
      expect(state.getSnapshotBuffer()).toEqual(messages);
      expect(state.getState()!.lastAnalyzedTurn).toBe(0);
    });

    it("returns empty array when not active", () => {
      const api = createMockApi();
      const state = new SupervisorStateManager(api);
      
      expect(state.getSnapshotBuffer()).toEqual([]);
    });
  });
});
