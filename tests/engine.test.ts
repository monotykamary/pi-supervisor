import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { SupervisorState } from '../src/types.js';

// Mock fs for loadSystemPrompt tests
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
  };
});

vi.mock('node:os', async () => {
  return {
    homedir: () => '/home/test',
  };
});

import { existsSync, readFileSync } from 'node:fs';
import {
  loadSystemPrompt,
  buildUserPrompt,
  getReframeGuidance,
  inferOutcome,
} from '../src/core/index.js';
import { SupervisorSession } from '../src/session/supervisor-session.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('loadSystemPrompt', () => {
  it('returns built-in prompt when no files exist', () => {
    vi.mocked(existsSync).mockReturnValue(false);

    const result = loadSystemPrompt('/test/cwd');

    expect(result.source).toBe('built-in');
    expect(result.prompt).toContain('You are a supervisor');
    expect(result.prompt).toContain('Response schema');
  });

  it('loads project SUPERVISOR.md when it exists', () => {
    vi.mocked(existsSync).mockImplementation((path) => {
      return String(path).includes('/test/cwd/.pi/SUPERVISOR.md');
    });
    vi.mocked(readFileSync).mockReturnValue('Custom project prompt');

    const result = loadSystemPrompt('/test/cwd');

    expect(result.source).toBe('/test/cwd/.pi/SUPERVISOR.md');
    expect(result.prompt).toBe('Custom project prompt');
  });

  it("falls back to global when project doesn't exist", () => {
    vi.mocked(existsSync).mockImplementation((path) => {
      return String(path).includes('/home/test/.pi/agent/SUPERVISOR.md');
    });
    vi.mocked(readFileSync).mockReturnValue('Global prompt');

    const result = loadSystemPrompt('/test/cwd');

    expect(result.source).toBe('/home/test/.pi/agent/SUPERVISOR.md');
    expect(result.prompt).toBe('Global prompt');
  });

  it('prefers project over global', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue('Project wins');

    const result = loadSystemPrompt('/test/cwd');

    expect(result.source).toBe('/test/cwd/.pi/SUPERVISOR.md');
  });

  it('built-in prompt includes cheating prevention section', () => {
    vi.mocked(existsSync).mockReturnValue(false);

    const result = loadSystemPrompt('/test/cwd');

    expect(result.source).toBe('built-in');
    expect(result.prompt).toContain('CHEATING PREVENTION');
    expect(result.prompt).toContain('Unverified Claims');
    expect(result.prompt).toContain('Test Manipulation');
    expect(result.prompt).toContain('Metric Gaming');
    expect(result.prompt).toContain('Short-Circuiting');
    expect(result.prompt).toContain('Contradictions');
  });

  it('built-in prompt includes ASI loop section', () => {
    vi.mocked(existsSync).mockReturnValue(false);

    const result = loadSystemPrompt('/test/cwd');

    expect(result.source).toBe('built-in');
    expect(result.prompt).toContain('CLOSING THE ASI LOOP');
    expect(result.prompt).toContain(
      'ASI (Actionable Side Information) is your memory across turns'
    );
    expect(result.prompt).toContain('READ your past ASI entries');
    expect(result.prompt).toContain('REQUIRED when steering');
  });
});

describe('getReframeGuidance', () => {
  it('returns empty string for tier 0 without ineffective pattern', () => {
    const result = getReframeGuidance(0);
    expect(result).toBe('');
  });

  it('returns pattern warning even for tier 0 when ineffective pattern detected', () => {
    const result = getReframeGuidance(0, {
      detected: true,
      similarCount: 2,
      secondsSinceLastSteer: 90,
    });
    expect(result).toContain('INEFFECTIVE PATTERN DETECTED');
  });

  it('returns tier 1 guidance', () => {
    const result = getReframeGuidance(1);
    expect(result).toContain('REFRAME TIER 1');
    expect(result).toContain('DIRECTIVE');
    expect(result).toContain('extremely specific');
  });

  it('returns tier 2 guidance', () => {
    const result = getReframeGuidance(2);
    expect(result).toContain('REFRAME TIER 2');
    expect(result).toContain('SUBGOAL');
    expect(result).toContain('smaller, verifiable milestone');
  });

  it('returns tier 3 guidance', () => {
    const result = getReframeGuidance(3);
    expect(result).toContain('REFRAME TIER 3');
    expect(result).toContain('PIVOT');
    expect(result).toContain('completely different strategy');
  });

  it('returns tier 4 guidance', () => {
    const result = getReframeGuidance(4);
    expect(result).toContain('REFRAME TIER 4');
    expect(result).toContain('MINIMAL SLICE');
    expect(result).toContain('smallest working version');
  });

  it('includes ineffective pattern warning when detected', () => {
    const result = getReframeGuidance(2, {
      detected: true,
      similarCount: 2,
      secondsSinceLastSteer: 90,
    });
    expect(result).toContain('INEFFECTIVE PATTERN DETECTED');
    expect(result).toContain('Last 2 steering messages');
    expect(result).toContain('90s since last steer');
  });

  it('does not include pattern warning when not detected', () => {
    const result = getReframeGuidance(2, {
      detected: false,
      similarCount: 1,
      secondsSinceLastSteer: 10,
    });
    expect(result).not.toContain('INEFFECTIVE PATTERN DETECTED');
  });
});

describe('buildUserPrompt', () => {
  it('includes reframe guidance when tier > 0', () => {
    const state: SupervisorState = {
      active: true,
      outcome: 'Implement auth',
      provider: 'anthropic',
      modelId: 'claude',
      interventions: [],
      startedAt: Date.now(),
      reframeTier: 2,
    };

    const result = buildUserPrompt(state, '[Session Goal]\n- Do stuff', true);
    expect(result).toContain('REFRAME TIER 2');
    expect(result).toContain('SUBGOAL');
  });

  it('does not include reframe guidance when tier is 0', () => {
    const state: SupervisorState = {
      active: true,
      outcome: 'Implement auth',
      provider: 'anthropic',
      modelId: 'claude',
      interventions: [],
      startedAt: Date.now(),
      reframeTier: 0,
    };

    const result = buildUserPrompt(state, '[Session Goal]\n- Do stuff', true);
    expect(result).not.toContain('REFRAME TIER');
  });

  it('includes ineffective pattern warning in prompt', () => {
    const state: SupervisorState = {
      active: true,
      outcome: 'Implement auth',
      provider: 'anthropic',
      modelId: 'claude',
      interventions: [{ message: 'Focus on auth', reasoning: 'Test', timestamp: Date.now() }],
      startedAt: Date.now(),
      reframeTier: 1,
    };

    const ineffectivePattern = { detected: true, similarCount: 1, secondsSinceLastSteer: 90 };
    const result = buildUserPrompt(state, '[Session Goal]\n- Do stuff', true, ineffectivePattern);

    expect(result).toContain('INEFFECTIVE PATTERN DETECTED');
    expect(result).toContain('90s since last steer');
  });

  it('includes outcome and agent status', () => {
    const state: SupervisorState = {
      active: true,
      outcome: 'Build API',
      provider: 'anthropic',
      modelId: 'claude',
      interventions: [],
      startedAt: Date.now(),
    };

    const result = buildUserPrompt(state, '[Session Goal]\n- Do stuff', true);
    expect(result).toContain('DESIRED OUTCOME:');
    expect(result).toContain('Build API');
    expect(result).toContain('AGENT STATUS: IDLE');
  });

  it('shows WORKING status when agent is not idle', () => {
    const state: SupervisorState = {
      active: true,
      outcome: 'Build API',
      provider: 'anthropic',
      modelId: 'claude',
      interventions: [],
      startedAt: Date.now(),
    };

    const result = buildUserPrompt(state, '[Session Goal]\n- Do stuff', false);
    expect(result).toContain('AGENT STATUS: WORKING');
  });

  it('includes structured conversation context', () => {
    const state: SupervisorState = {
      active: true,
      outcome: 'Build API',
      provider: 'anthropic',
      modelId: 'claude',
      interventions: [],
      startedAt: Date.now(),
    };

    const contextText =
      '[Session Goal]\n- Build auth\n[Outstanding Context]\n- [ERROR] build failed';
    const result = buildUserPrompt(state, contextText, true);
    expect(result).toContain('STRUCTURED CONVERSATION CONTEXT:');
    expect(result).toContain('[Session Goal]');
    expect(result).toContain('Build auth');
  });

  it('includes intervention history', () => {
    const state: SupervisorState = {
      active: true,
      outcome: 'Build API',
      provider: 'anthropic',
      modelId: 'claude',
      interventions: [{ message: 'Focus on X', reasoning: 'Drift', timestamp: 123456 }],
      startedAt: Date.now(),
    };

    const result = buildUserPrompt(state, '', true);
    expect(result).toContain('YOUR INTERVENTION HISTORY (with ASI observations):');
    expect(result).toContain('[1]');
    expect(result).toContain('Focus on X');
  });

  it('includes ASI from previous interventions', () => {
    const state: SupervisorState = {
      active: true,
      outcome: 'Build API',
      provider: 'anthropic',
      modelId: 'claude',
      interventions: [
        {
          message: 'Focus on tests',
          reasoning: 'Drift',
          timestamp: 123456,
          asi: {
            why_stuck: 'agent refactoring without tests',
            strategy_used: 'directive',
          },
        },
      ],
      startedAt: Date.now(),
    };

    const result = buildUserPrompt(state, '', true);
    expect(result).toContain('ASI {');
    expect(result).toContain('why_stuck: "agent refactoring without tests"');
    expect(result).toContain('strategy_used: "directive"');
  });

  it('surfaces recurring ASI patterns in summary', () => {
    const state: SupervisorState = {
      active: true,
      outcome: 'Build API',
      provider: 'anthropic',
      modelId: 'claude',
      interventions: [
        {
          message: 'Focus on tests',
          reasoning: 'Drift',
          timestamp: 123456,
          asi: { suspicious_claim: true, pattern: 'unverified' },
        },
        {
          message: 'Verify the output',
          reasoning: 'Contradiction',
          timestamp: 123457,
          asi: { suspicious_claim: true, pattern: 'contradicted' },
        },
        {
          message: 'Show proof',
          reasoning: 'Unverified',
          timestamp: 123458,
          asi: { requires_proof: true },
        },
      ],
      startedAt: Date.now(),
    };

    const result = buildUserPrompt(state, '', true);
    expect(result).toContain('ASI PATTERN SUMMARY');
    expect(result).toContain('Pattern seen 2x: "suspicious_claim"');
    expect(result).toContain('⚠️ Previous interventions flagged suspicious claims');
  });

  it('warns about verification failures in ASI summary', () => {
    const state: SupervisorState = {
      active: true,
      outcome: 'Build API',
      provider: 'anthropic',
      modelId: 'claude',
      interventions: [
        {
          message: 'Focus on tests',
          reasoning: 'Drift',
          timestamp: 123456,
          asi: { claim_status: 'contradicted_by_tool_output' },
        },
        {
          message: 'Verify the output',
          reasoning: 'Contradiction',
          timestamp: 123457,
          asi: { claim_status: 'unverified' },
        },
        {
          message: 'Show proof',
          reasoning: 'Unverified',
          timestamp: 123458,
          asi: { claim_status: 'contradicted_by_tool_output' },
        },
      ],
      startedAt: Date.now(),
    };

    const result = buildUserPrompt(state, '', true);
    expect(result).toContain('ASI PATTERN SUMMARY');
    expect(result).toContain('⚠️ 3 interventions involved unverified/contradicted claims');
    expect(result).toContain('agent has pattern of unreliable reporting');
  });

  it('detects suspicious keywords in ASI values', () => {
    const state: SupervisorState = {
      active: true,
      outcome: 'Build API',
      provider: 'anthropic',
      modelId: 'claude',
      interventions: [
        {
          message: 'Check for cheating',
          reasoning: 'Suspicious',
          timestamp: 123456,
          asi: { observation: 'agent_attempted_to_fake_test_results' },
        },
      ],
      startedAt: Date.now(),
    };

    const result = buildUserPrompt(state, '', true);
    expect(result).toContain('ASI PATTERN SUMMARY');
    expect(result).toContain('⚠️ Previous interventions flagged suspicious claims');
  });

  it('handles empty ASI gracefully', () => {
    const state: SupervisorState = {
      active: true,
      outcome: 'Build API',
      provider: 'anthropic',
      modelId: 'claude',
      interventions: [
        {
          message: 'Focus on X',
          reasoning: 'Drift',
          timestamp: 123456,
        },
      ],
      startedAt: Date.now(),
    };

    const result = buildUserPrompt(state, '', true);
    expect(result).toContain('[1] "Focus on X"');
    expect(result).not.toContain('ASI {}');
    expect(result).not.toContain('ASI PATTERN SUMMARY');
  });

  it('shows fallback when no context available', () => {
    const state: SupervisorState = {
      active: true,
      outcome: 'Build API',
      provider: 'anthropic',
      modelId: 'claude',
      interventions: [],
      startedAt: Date.now(),
    };

    const result = buildUserPrompt(state, '', true);
    expect(result).toContain('No conversation context available');
  });
});

describe('inferOutcome', () => {
  let ensureStartedSpy: ReturnType<typeof vi.spyOn>;
  let promptSpy: ReturnType<typeof vi.spyOn>;
  let disposeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    ensureStartedSpy = vi.spyOn(SupervisorSession.prototype, 'ensureStarted');
    promptSpy = vi.spyOn(SupervisorSession.prototype, 'prompt');
    disposeSpy = vi.spyOn(SupervisorSession.prototype, 'dispose');

    ensureStartedSpy.mockResolvedValue(true);
    promptSpy.mockResolvedValue('Build auth system');
  });

  afterEach(() => {
    ensureStartedSpy.mockRestore();
    promptSpy.mockRestore();
    disposeSpy.mockRestore();
  });

  it('returns null when sessionManager has no branch entries', async () => {
    const mockCtx = {
      sessionManager: {
        getBranch: () => [],
      },
      modelRegistry: {
        find: () => ({ name: 'test-model' }),
      },
    } as any;

    const result = await inferOutcome(mockCtx, 'anthropic', 'claude');
    expect(result).toBeNull();
  });

  it('returns null when model not found in registry', async () => {
    const mockCtx = {
      sessionManager: {
        getBranch: () => [{ type: 'message', message: { role: 'user', content: 'Hello' } }],
      },
      modelRegistry: {
        find: () => null,
      },
    } as any;

    ensureStartedSpy.mockResolvedValue(false);

    const result = await inferOutcome(mockCtx, 'anthropic', 'claude');
    expect(result).toBeNull();
  });

  it('returns null when session fails to start', async () => {
    const mockCtx = {
      sessionManager: {
        getBranch: () => [
          {
            type: 'message',
            message: { role: 'user', content: [{ type: 'text', text: 'Build auth' }] },
          },
        ],
      },
      modelRegistry: {
        find: () => ({ name: 'test-model' }),
      },
    } as any;

    ensureStartedSpy.mockResolvedValue(false);

    const result = await inferOutcome(mockCtx, 'anthropic', 'claude');
    expect(result).toBeNull();
  });

  it('extracts outcome successfully', async () => {
    const mockCtx = {
      sessionManager: {
        getBranch: () => [
          {
            type: 'message',
            message: { role: 'user', content: [{ type: 'text', text: 'Build auth' }] },
          },
        ],
      },
      modelRegistry: {
        find: () => ({ name: 'test-model' }),
      },
    } as any;

    promptSpy.mockResolvedValue('Add JWT authentication with refresh tokens');

    const result = await inferOutcome(mockCtx, 'anthropic', 'claude');

    expect(result).toBe('Add JWT authentication with refresh tokens');
  });

  it('cleans up result: removes quotes, newlines, and limits length', async () => {
    const mockCtx = {
      sessionManager: {
        getBranch: () => [
          {
            type: 'message',
            message: { role: 'user', content: [{ type: 'text', text: 'Build auth' }] },
          },
        ],
      },
      modelRegistry: {
        find: () => ({ name: 'test-model' }),
      },
    } as any;

    promptSpy.mockResolvedValue('"Fix the\nbug in the handler"');

    const result = await inferOutcome(mockCtx, 'anthropic', 'claude');

    expect(result).toBe('Fix the bug in the handler');
    expect(result.length).toBeLessThanOrEqual(200);
  });

  it('returns null when prompt returns null', async () => {
    const mockCtx = {
      sessionManager: {
        getBranch: () => [
          {
            type: 'message',
            message: { role: 'user', content: [{ type: 'text', text: 'Build auth' }] },
          },
        ],
      },
      modelRegistry: {
        find: () => ({ name: 'test-model' }),
      },
    } as any;

    promptSpy.mockResolvedValue(null);

    const result = await inferOutcome(mockCtx, 'anthropic', 'claude');

    expect(result).toBeNull();
  });

  it('returns null when exception thrown', async () => {
    const mockCtx = {
      sessionManager: {
        getBranch: () => [
          {
            type: 'message',
            message: { role: 'user', content: [{ type: 'text', text: 'Build auth' }] },
          },
        ],
      },
      modelRegistry: {
        find: () => ({ name: 'test-model' }),
      },
    } as any;

    ensureStartedSpy.mockRejectedValue(new Error('Network error'));

    const result = await inferOutcome(mockCtx, 'anthropic', 'claude');

    expect(result).toBeNull();
  });

  it('uses goal extraction system prompt', async () => {
    const mockCtx = {
      sessionManager: {
        getBranch: () => [
          {
            type: 'message',
            message: { role: 'user', content: [{ type: 'text', text: 'Build auth' }] },
          },
        ],
      },
      modelRegistry: {
        find: () => ({ name: 'test-model' }),
      },
    } as any;

    await inferOutcome(mockCtx, 'anthropic', 'claude');

    expect(ensureStartedSpy).toHaveBeenCalledWith(
      mockCtx,
      'anthropic',
      'claude',
      expect.stringContaining('goal extraction')
    );
  });
});
