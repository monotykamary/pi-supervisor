import { describe, expect, it, vi } from "vitest";
import { loadSystemPrompt, SNAPSHOT_LIMIT, updateSnapshot, buildUserPrompt, getReframeGuidance } from "../src/engine.js";
import type { SupervisorState } from "../src/types.js";

// Mock fs for loadSystemPrompt tests
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
  };
});

vi.mock("node:os", async () => {
  return {
    homedir: () => "/home/test",
  };
});

import { existsSync, readFileSync } from "node:fs";

describe("loadSystemPrompt", () => {
  it("returns built-in prompt when no files exist", () => {
    vi.mocked(existsSync).mockReturnValue(false);
    
    const result = loadSystemPrompt("/test/cwd");
    
    expect(result.source).toBe("built-in");
    expect(result.prompt).toContain("You are a supervisor");
    expect(result.prompt).toContain("Response schema");
  });

  it("loads project SUPERVISOR.md when it exists", () => {
    vi.mocked(existsSync).mockImplementation((path) => {
      return String(path).includes("/test/cwd/.pi/SUPERVISOR.md");
    });
    vi.mocked(readFileSync).mockReturnValue("Custom project prompt");
    
    const result = loadSystemPrompt("/test/cwd");
    
    expect(result.source).toBe("/test/cwd/.pi/SUPERVISOR.md");
    expect(result.prompt).toBe("Custom project prompt");
  });

  it("falls back to global when project doesn't exist", () => {
    vi.mocked(existsSync).mockImplementation((path) => {
      return String(path).includes("/home/test/.pi/agent/SUPERVISOR.md");
    });
    vi.mocked(readFileSync).mockReturnValue("Global prompt");
    
    const result = loadSystemPrompt("/test/cwd");
    
    expect(result.source).toBe("/home/test/.pi/agent/SUPERVISOR.md");
    expect(result.prompt).toBe("Global prompt");
  });

  it("prefers project over global", () => {
    vi.mocked(existsSync).mockReturnValue(true); // Both exist
    vi.mocked(readFileSync).mockReturnValue("Project wins");
    
    const result = loadSystemPrompt("/test/cwd");
    
    expect(result.source).toBe("/test/cwd/.pi/SUPERVISOR.md");
  });
});

describe("SNAPSHOT_LIMIT", () => {
  it("is set to 6 messages", () => {
    expect(SNAPSHOT_LIMIT).toBe(6);
  });
});

describe("updateSnapshot", () => {
  it("returns existing buffer when turn already analyzed", () => {
    const mockCtx = {
      sessionManager: {
        getBranch: () => [],
      },
    } as any;
    
    const state: SupervisorState = {
      active: true,
      outcome: "Test",
      provider: "anthropic",
      modelId: "claude",
      interventions: [],
      startedAt: Date.now(),
      turnCount: 5,
      snapshotBuffer: [
        { role: "user", content: "Old" },
      ],
      lastAnalyzedTurn: 5, // Already analyzed this turn
    };
    
    const result = updateSnapshot(mockCtx, state);
    
    // Should return existing buffer limited to SNAPSHOT_LIMIT
    expect(result).toEqual([{ role: "user", content: "Old" }]);
  });

  it("updates lastAnalyzedTurn after building snapshot", () => {
    const mockCtx = {
      sessionManager: {
        getBranch: () => [],
      },
    } as any;
    
    const state: SupervisorState = {
      active: true,
      outcome: "Test",
      provider: "anthropic",
      modelId: "claude",
      interventions: [],
      startedAt: Date.now(),
      turnCount: 3,
      snapshotBuffer: [],
      lastAnalyzedTurn: -1,
    };
    
    updateSnapshot(mockCtx, state);
    
    expect(state.lastAnalyzedTurn).toBe(3);
  });
});

describe("getReframeGuidance", () => {
  it("returns empty string for tier 0 without ineffective pattern", () => {
    const result = getReframeGuidance(0);
    expect(result).toBe("");
  });

  it("returns pattern warning even for tier 0 when ineffective pattern detected", () => {
    const result = getReframeGuidance(0, { detected: true, similarCount: 2, turnsSinceLastSteer: 3 });
    expect(result).toContain("INEFFECTIVE PATTERN DETECTED");
  });

  it("returns tier 1 guidance", () => {
    const result = getReframeGuidance(1);
    expect(result).toContain("REFRAME TIER 1");
    expect(result).toContain("DIRECTIVE");
    expect(result).toContain("extremely specific");
  });

  it("returns tier 2 guidance", () => {
    const result = getReframeGuidance(2);
    expect(result).toContain("REFRAME TIER 2");
    expect(result).toContain("SUBGOAL");
    expect(result).toContain("smaller, verifiable milestone");
  });

  it("returns tier 3 guidance", () => {
    const result = getReframeGuidance(3);
    expect(result).toContain("REFRAME TIER 3");
    expect(result).toContain("PIVOT");
    expect(result).toContain("completely different strategy");
  });

  it("returns tier 4 guidance", () => {
    const result = getReframeGuidance(4);
    expect(result).toContain("REFRAME TIER 4");
    expect(result).toContain("MINIMAL SLICE");
    expect(result).toContain("smallest working version");
  });

  it("includes ineffective pattern warning when detected", () => {
    const result = getReframeGuidance(2, { detected: true, similarCount: 2, turnsSinceLastSteer: 3 });
    expect(result).toContain("INEFFECTIVE PATTERN DETECTED");
    expect(result).toContain("Last 2 steering messages");
    expect(result).toContain("no progress in 3 turns");
  });

  it("does not include pattern warning when not detected", () => {
    const result = getReframeGuidance(2, { detected: false, similarCount: 1, turnsSinceLastSteer: 1 });
    expect(result).not.toContain("INEFFECTIVE PATTERN DETECTED");
  });
});

describe("buildUserPrompt", () => {
  it("includes reframe guidance when tier > 0", () => {
    const state: SupervisorState = {
      active: true,
      outcome: "Implement auth",
      provider: "anthropic",
      modelId: "claude",
      interventions: [],
      startedAt: Date.now(),
      turnCount: 1,
      reframeTier: 2,
    };
    
    const result = buildUserPrompt(state, [], true);
    expect(result).toContain("REFRAME TIER 2");
    expect(result).toContain("SUBGOAL");
  });

  it("does not include reframe guidance when tier is 0", () => {
    const state: SupervisorState = {
      active: true,
      outcome: "Implement auth",
      provider: "anthropic",
      modelId: "claude",
      interventions: [],
      startedAt: Date.now(),
      turnCount: 1,
      reframeTier: 0,
    };
    
    const result = buildUserPrompt(state, [], true);
    expect(result).not.toContain("REFRAME TIER");
  });

  it("includes ineffective pattern warning in prompt", () => {
    const state: SupervisorState = {
      active: true,
      outcome: "Implement auth",
      provider: "anthropic",
      modelId: "claude",
      interventions: [
        { turnCount: 1, message: "Focus on auth", reasoning: "Test", timestamp: Date.now() },
      ],
      startedAt: Date.now(),
      turnCount: 4,
      reframeTier: 1,
    };
    
    const ineffectivePattern = { detected: true, similarCount: 1, turnsSinceLastSteer: 3 };
    const result = buildUserPrompt(state, [], true, ineffectivePattern);
    
    expect(result).toContain("INEFFECTIVE PATTERN DETECTED");
    expect(result).toContain("no progress in 3 turns");
  });

  it("includes outcome and agent status", () => {
    const state: SupervisorState = {
      active: true,
      outcome: "Build API",
      provider: "anthropic",
      modelId: "claude",
      interventions: [],
      startedAt: Date.now(),
      turnCount: 1,
    };
    
    const result = buildUserPrompt(state, [], true);
    expect(result).toContain("DESIRED OUTCOME:");
    expect(result).toContain("Build API");
    expect(result).toContain("AGENT STATUS: IDLE");
  });

  it("shows WORKING status when agent is not idle", () => {
    const state: SupervisorState = {
      active: true,
      outcome: "Build API",
      provider: "anthropic",
      modelId: "claude",
      interventions: [],
      startedAt: Date.now(),
      turnCount: 1,
    };
    
    const result = buildUserPrompt(state, [], false);
    expect(result).toContain("AGENT STATUS: WORKING");
  });

  it("includes conversation messages in prompt", () => {
    const state: SupervisorState = {
      active: true,
      outcome: "Build API",
      provider: "anthropic",
      modelId: "claude",
      interventions: [],
      startedAt: Date.now(),
      turnCount: 1,
    };
    
    const snapshot = [
      { role: "user" as const, content: "Hello" },
      { role: "assistant" as const, content: "Hi there" },
    ];
    
    const result = buildUserPrompt(state, snapshot, true);
    expect(result).toContain("USER: Hello");
    expect(result).toContain("ASSISTANT: Hi there");
  });

  it("includes intervention history", () => {
    const state: SupervisorState = {
      active: true,
      outcome: "Build API",
      provider: "anthropic",
      modelId: "claude",
      interventions: [
        { turnCount: 1, message: "Focus on X", reasoning: "Drift", timestamp: 123456 },
      ],
      startedAt: Date.now(),
      turnCount: 2,
    };
    
    const result = buildUserPrompt(state, [], true);
    expect(result).toContain("PREVIOUS INTERVENTIONS BY YOU:");
    expect(result).toContain("[1] Turn 1:");
    expect(result).toContain("Focus on X");
  });
});
