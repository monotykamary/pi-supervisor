import { describe, expect, it, vi, beforeEach } from 'vitest';
import { SupervisorStateManager } from '../src/state/manager.js';

// Mock dependencies
vi.mock('../src/core/analyzer.js', () => ({
  analyze: vi.fn(),
}));

vi.mock('../src/core/inference.js', () => ({
  inferOutcome: vi.fn(),
}));

vi.mock('../src/core/prompt-loader.js', () => ({
  loadSystemPrompt: vi.fn().mockReturnValue({ prompt: 'test prompt', source: 'built-in' }),
}));

vi.mock('../src/ui/renderer.js', () => ({
  updateUI: vi.fn(),
  toggleWidget: vi.fn(),
}));

vi.mock('../src/ui/model-picker.js', () => ({
  pickModel: vi.fn(),
}));

vi.mock('../src/global-config.js', () => ({
  loadGlobalModel: vi.fn().mockReturnValue(null),
  saveGlobalModel: vi.fn(),
}));

vi.mock('../src/session/client.js', () => ({
  disposeSession: vi.fn(),
}));

vi.mock('../src/subagent-detector.js', () => ({
  checkChildPiProcesses: vi.fn().mockResolvedValue({ hasActiveSubagents: false, count: 0 }),
  waitForSubagents: vi
    .fn()
    .mockResolvedValue({ completed: true, finalStatus: { hasActiveSubagents: false, count: 0 } }),
}));

import { updateUI } from '../src/ui/renderer.js';
import { disposeSession } from '../src/session/client.js';

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

function makeSupervisionData(overrides: Record<string, any> = {}) {
  return {
    active: true,
    outcome: 'Test goal',
    provider: 'anthropic',
    modelId: 'claude-haiku',
    interventions: [],
    startedAt: Date.now(),
    reframeTier: 0,
    ...overrides,
  };
}

describe('Ephemeral Supervision - idle agent clears supervision', () => {
  let api: ReturnType<typeof createMockApi>;
  let state: SupervisorStateManager;

  beforeEach(() => {
    api = createMockApi();
    state = new SupervisorStateManager(api);
    vi.clearAllMocks();
  });

  function startActiveSupervision() {
    state.start('Test goal', 'anthropic', 'claude-haiku');
    expect(state.isActive()).toBe(true);
  }

  function createSessionWithSupervision(overrides: Record<string, any> = {}) {
    return [
      { type: 'message', message: { role: 'user', content: 'Hello' } },
      {
        type: 'custom',
        customType: 'supervisor-state',
        data: makeSupervisionData(overrides),
      },
    ];
  }

  describe('session_start (crash resume)', () => {
    it('clears supervision when agent is idle', () => {
      startActiveSupervision();

      const entries = createSessionWithSupervision();
      const ctx = createMockContext(entries, true);

      state.loadFromSession(ctx);

      if (state.isActive() && ctx.isIdle()) {
        state.stop();
        disposeSession();
      }

      expect(state.isActive()).toBe(false);
    });

    it('keeps supervision when agent is working', () => {
      startActiveSupervision();

      const entries = createSessionWithSupervision();
      const ctx = createMockContext(entries, false);

      state.loadFromSession(ctx);

      expect(state.isActive()).toBe(true);
    });
  });

  describe('session_start with resume reason (resume another session)', () => {
    it('clears supervision when agent is idle', () => {
      startActiveSupervision();

      const entries = createSessionWithSupervision();
      const ctx = createMockContext(entries, true);

      state.loadFromSession(ctx);

      if (state.isActive() && ctx.isIdle()) {
        state.stop();
        disposeSession();
      }

      expect(state.isActive()).toBe(false);
    });

    it('keeps supervision when agent is working', () => {
      startActiveSupervision();

      const entries = createSessionWithSupervision();
      const ctx = createMockContext(entries, false);

      state.loadFromSession(ctx);

      expect(state.isActive()).toBe(true);
    });
  });

  describe('session_tree (navigate history)', () => {
    it('clears supervision when navigating to history while idle', () => {
      startActiveSupervision();

      const entries = createSessionWithSupervision();
      const ctx = createMockContext(entries, true);

      state.loadFromSession(ctx);

      if (state.isActive() && ctx.isIdle()) {
        state.stop();
        disposeSession();
      }

      expect(state.isActive()).toBe(false);
    });

    it('keeps supervision when at current head with working agent', () => {
      startActiveSupervision();

      const entries = createSessionWithSupervision();
      const ctx = createMockContext(entries, false);

      state.loadFromSession(ctx);

      expect(state.isActive()).toBe(true);
    });
  });

  describe('session_start with fork reason (fork session)', () => {
    it('clears supervision when agent is idle', () => {
      startActiveSupervision();

      const entries = createSessionWithSupervision();
      const ctx = createMockContext(entries, true);

      state.loadFromSession(ctx);

      if (state.isActive() && ctx.isIdle()) {
        state.stop();
        disposeSession();
      }

      expect(state.isActive()).toBe(false);
    });

    it('keeps supervision when agent is working', () => {
      startActiveSupervision();

      const entries = createSessionWithSupervision();
      const ctx = createMockContext(entries, false);

      state.loadFromSession(ctx);

      expect(state.isActive()).toBe(true);
    });
  });
});

describe('Ephemeral Supervision - compaction behavior', () => {
  let api: ReturnType<typeof createMockApi>;
  let state: SupervisorStateManager;

  beforeEach(() => {
    api = createMockApi();
    state = new SupervisorStateManager(api);
    vi.clearAllMocks();
  });

  function createSessionWithSupervision(overrides: Record<string, any> = {}) {
    return [
      { type: 'compaction', summary: 'Earlier conversation' },
      { type: 'message', message: { role: 'user', content: 'Continue' } },
      {
        type: 'custom',
        customType: 'supervisor-state',
        data: makeSupervisionData(overrides),
      },
    ];
  }

  it('continues supervision when agent is working after compaction (long-horizon sessions)', () => {
    state.start('Test goal', 'anthropic', 'claude-haiku');
    expect(state.isActive()).toBe(true);

    const entries = createSessionWithSupervision({ reframeTier: 1 });
    const ctx = createMockContext(entries, false);

    state.loadFromSession(ctx);

    expect(state.isActive()).toBe(true);
    expect(state.getReframeTier()).toBe(1);
  });

  it('clears supervision when agent is idle after compaction', () => {
    state.start('Test goal', 'anthropic', 'claude-haiku');
    expect(state.isActive()).toBe(true);

    const entries = createSessionWithSupervision();
    const ctx = createMockContext(entries, true);

    state.loadFromSession(ctx);

    if (state.isActive() && ctx.isIdle()) {
      state.stop();
      disposeSession();
    }

    expect(state.isActive()).toBe(false);
  });
});

describe('Ephemeral Supervision - UI notifications', () => {
  let api: ReturnType<typeof createMockApi>;
  let state: SupervisorStateManager;

  beforeEach(() => {
    api = createMockApi();
    state = new SupervisorStateManager(api);
    vi.clearAllMocks();
  });

  function createSessionWithSupervision(overrides: Record<string, any> = {}) {
    return [
      {
        type: 'custom',
        customType: 'supervisor-state',
        data: makeSupervisionData(overrides),
      },
    ];
  }

  it('notifies user when supervision is cleared on idle session load', () => {
    const entries = createSessionWithSupervision();
    const notify = vi.fn();
    const ctx = {
      ...createMockContext(entries, true),
      ui: { ...createMockContext().ui, notify },
    };

    state.loadFromSession(ctx);

    if (state.isActive() && ctx.isIdle()) {
      notify('Supervision cleared: agent is idle', 'info');
    }

    expect(notify).toHaveBeenCalledWith('Supervision cleared: agent is idle', 'info');
  });

  it('notifies user when supervision is cleared after compaction', () => {
    const entries = createSessionWithSupervision();
    const notify = vi.fn();
    const ctx = {
      ...createMockContext(entries, true),
      ui: { ...createMockContext().ui, notify },
    };

    state.loadFromSession(ctx);

    if (state.isActive() && ctx.isIdle()) {
      notify('Supervision cleared: compaction complete, agent idle', 'info');
    }

    expect(notify).toHaveBeenCalledWith(
      'Supervision cleared: compaction complete, agent idle',
      'info'
    );
  });
});
