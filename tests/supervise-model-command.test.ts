import { describe, expect, it, vi, beforeEach } from 'vitest';

// Mock collaborators so importing the extension entry point is lightweight.
vi.mock('../src/core/analyzer.js', () => ({ analyze: vi.fn() }));
vi.mock('../src/core/inference.js', () => ({ inferOutcome: vi.fn() }));
vi.mock('../src/core/prompt-loader.js', () => ({
  loadSystemPrompt: vi.fn().mockReturnValue({ prompt: 'p', source: 'built-in' }),
}));
vi.mock('../src/ui/renderer.js', () => ({ updateUI: vi.fn(), toggleWidget: vi.fn() }));
vi.mock('../src/ui/model-picker.js', () => ({ pickModel: vi.fn() }));
vi.mock('../src/global-config.js', () => ({
  loadGlobalModel: vi.fn().mockReturnValue(null),
  saveGlobalModel: vi.fn(),
}));
vi.mock('../src/session/client.js', () => ({ disposeSession: vi.fn() }));
vi.mock('../src/subagent-detector.js', () => ({
  checkChildPiProcesses: vi.fn().mockResolvedValue({ hasActiveSubagents: false, count: 0 }),
  waitForSubagents: vi
    .fn()
    .mockResolvedValue({ completed: true, finalStatus: { hasActiveSubagents: false, count: 0 } }),
}));
vi.mock('../src/compaction/index.js', () => ({
  extractMessages: vi.fn().mockReturnValue([]),
  buildCompactionSummary: vi.fn(),
  formatForSupervisor: vi.fn(),
}));

import piSupervisor from '../src/index.js';
import { pickModel } from '../src/ui/model-picker.js';
import { loadGlobalModel, saveGlobalModel } from '../src/global-config.js';
import { updateUI } from '../src/ui/renderer.js';

function createMockApi() {
  let superviseDef:
    | {
        handler: (args: string, ctx: any) => Promise<void>;
        getArgumentCompletions?: (prefix: string) => any[] | null;
      }
    | undefined;
  const api = {
    appendEntry: vi.fn(),
    on: vi.fn(),
    registerCommand: vi.fn((name: string, def: any) => {
      if (name === 'supervise') superviseDef = def;
    }),
    registerTool: vi.fn(),
    sendUserMessage: vi.fn(),
    sendMessage: vi.fn(),
    setModel: vi.fn().mockResolvedValue(true),
    events: { emit: vi.fn(), on: vi.fn() },
  } as any;
  return { api, getSupervise: () => superviseDef };
}

function createMockCtx(overrides: { isIdle?: boolean; cwd?: string } = {}) {
  return {
    ui: {
      notify: vi.fn(),
      custom: vi.fn(),
      setWidget: vi.fn(),
      setFooter: vi.fn(),
      setHeader: vi.fn(),
      setStatus: vi.fn(),
      setWorkingMessage: vi.fn(),
    },
    hasUI: true,
    cwd: overrides.cwd ?? '/test/project',
    sessionManager: { getBranch: vi.fn().mockReturnValue([]) },
    modelRegistry: {
      getApiKeyForProvider: vi.fn().mockResolvedValue('test-key'),
      find: vi.fn(),
      getAvailable: vi.fn().mockReturnValue([]),
    },
    model: { provider: 'anthropic', id: 'claude-haiku' },
    isIdle: vi.fn().mockReturnValue(overrides.isIdle ?? true),
    abort: vi.fn(),
    hasPendingMessages: vi.fn().mockReturnValue(false),
    shutdown: vi.fn(),
    getContextUsage: vi.fn(),
    compact: vi.fn(),
    getSystemPrompt: vi.fn().mockReturnValue('test system prompt'),
  } as any;
}

describe('/supervise model command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(loadGlobalModel).mockReturnValue(null);
  });

  it('exposes subcommand autocomplete including model', () => {
    const { api, getSupervise } = createMockApi();
    piSupervisor(api);
    const getArgumentCompletions = getSupervise()!.getArgumentCompletions!;

    expect(getArgumentCompletions('')).toEqual([
      { value: 'model', label: 'model', description: 'Pick the supervisor model' },
      { value: 'stop', label: 'stop', description: 'Stop active supervision' },
      { value: 'widget', label: 'widget', description: 'Toggle the status widget' },
    ]);
    expect(getArgumentCompletions('m')).toEqual([
      { value: 'model', label: 'model', description: 'Pick the supervisor model' },
    ]);
    expect(getArgumentCompletions('s')).toEqual([
      { value: 'stop', label: 'stop', description: 'Stop active supervision' },
    ]);
    // Free-form goal text (no subcommand match) yields no suggestions
    expect(getArgumentCompletions('refactor auth')).toBeNull();
  });

  it('saves the picked model and notifies when supervision is inactive', async () => {
    const { api, getSupervise } = createMockApi();
    piSupervisor(api);
    const handler = getSupervise()!.handler;
    const ctx = createMockCtx();

    vi.mocked(pickModel).mockResolvedValue({ provider: 'openai', id: 'gpt-4o' } as any);

    await handler('model', ctx);

    // Pre-highlights the chat model (no active state, no global config)
    expect(pickModel).toHaveBeenCalledWith(ctx, 'anthropic', 'claude-haiku');
    expect(saveGlobalModel).toHaveBeenCalledWith('/test/project', {
      provider: 'openai',
      modelId: 'gpt-4o',
    });
    // Not active → widget not refreshed
    expect(updateUI).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining('Supervisor model set to openai/gpt-4o'),
      'info'
    );
  });

  it('notifies cancelled and does not save when the picker is dismissed', async () => {
    const { api, getSupervise } = createMockApi();
    piSupervisor(api);
    const handler = getSupervise()!.handler;
    const ctx = createMockCtx();

    vi.mocked(pickModel).mockResolvedValue(null);

    await handler('model', ctx);

    expect(saveGlobalModel).not.toHaveBeenCalled();
    expect(updateUI).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith('Supervisor model selection cancelled.', 'info');
  });

  it('updates the live session model and refreshes the widget when supervision is active', async () => {
    const { api, getSupervise } = createMockApi();
    piSupervisor(api);
    const handler = getSupervise()!.handler;
    const ctx = createMockCtx({ isIdle: true });

    // Start active supervision with the explicit-goal path (API key present)
    await handler('Refactor auth module', ctx);
    expect(api.sendUserMessage).toHaveBeenCalled();

    updateUI.mockClear();
    api.appendEntry.mockClear();

    vi.mocked(pickModel).mockResolvedValue({ provider: 'openai', id: 'gpt-4o' } as any);

    await handler('model', ctx);

    // Pre-highlights the active session model, not the chat model
    expect(pickModel).toHaveBeenCalledWith(ctx, 'anthropic', 'claude-haiku');
    expect(saveGlobalModel).toHaveBeenCalledWith('/test/project', {
      provider: 'openai',
      modelId: 'gpt-4o',
    });
    // Active → widget refreshed
    expect(updateUI).toHaveBeenCalled();
    // state.setModel() persisted the new model into the session
    const lastEntry = api.appendEntry.mock.calls[api.appendEntry.mock.calls.length - 1];
    expect(lastEntry[1].provider).toBe('openai');
    expect(lastEntry[1].modelId).toBe('gpt-4o');
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining('Supervisor model set to openai/gpt-4o'),
      'info'
    );
  });
});
