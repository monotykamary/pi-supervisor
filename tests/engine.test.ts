import { describe, expect, it, vi } from "vitest";
import { loadSystemPrompt, SNAPSHOT_LIMIT, updateSnapshot } from "../src/engine.js";
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
