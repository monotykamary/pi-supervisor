import { describe, expect, it, vi } from 'vitest';
import { SupervisorStateManager } from '../src/state/manager.js';
import { detectMidRunSignals } from '../src/state/mid-run-signals.js';
import type { Message } from '@earendil-works/pi-ai';

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

function makeUserMessage(text: string): Message {
  return { role: 'user', content: text } as Message;
}

function makeAssistantMessage(text: string): Message {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
  } as unknown as Message;
}

function makeToolCallMessage(name: string, args: Record<string, unknown> = {}): Message {
  return {
    role: 'assistant',
    content: [{ type: 'toolCall', name, arguments: args }],
  } as unknown as Message;
}

function makeToolResultMessage(name: string, text: string, isError = false): Message {
  return {
    role: 'toolResult',
    toolName: name,
    content: text,
    isError,
  } as unknown as Message;
}

describe('SupervisorStateManager', () => {
  describe('reframe tier management', () => {
    it('initializes reframe tier to 0 on start', () => {
      const api = createMockApi();
      const state = new SupervisorStateManager(api);
      state.start('Test goal', 'anthropic', 'claude-haiku');

      expect(state.getReframeTier()).toBe(0);
      expect(state.getState()!.reframeTier).toBe(0);
    });

    it('escalates reframe tier up to max of 4', () => {
      const api = createMockApi();
      const state = new SupervisorStateManager(api);
      state.start('Test goal', 'anthropic', 'claude-haiku');

      state.escalateReframeTier();
      expect(state.getReframeTier()).toBe(1);

      state.escalateReframeTier();
      expect(state.getReframeTier()).toBe(2);

      state.escalateReframeTier();
      expect(state.getReframeTier()).toBe(3);

      state.escalateReframeTier();
      expect(state.getReframeTier()).toBe(4);

      state.escalateReframeTier();
      expect(state.getReframeTier()).toBe(4);
    });

    it('resets reframe tier to 0', () => {
      const api = createMockApi();
      const state = new SupervisorStateManager(api);
      state.start('Test goal', 'anthropic', 'claude-haiku');

      state.escalateReframeTier();
      state.escalateReframeTier();
      state.resetReframeTier();
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
  });

  describe('ineffective pattern detection', () => {
    it('returns no pattern with less than 2 interventions', () => {
      const api = createMockApi();
      const state = new SupervisorStateManager(api);
      state.start('Test goal', 'anthropic', 'claude-haiku');

      const pattern = state.detectIneffectivePattern();
      expect(pattern.detected).toBe(false);
    });

    it('detects similar messages', () => {
      const api = createMockApi();
      const state = new SupervisorStateManager(api);
      state.start('Test goal', 'anthropic', 'claude-haiku');

      state.addIntervention({
        message: 'Please implement the auth middleware',
        reasoning: 'Not done yet',
        timestamp: Date.now(),
      });

      state.addIntervention({
        message: 'Please implement the auth middleware now',
        reasoning: 'Still not done',
        timestamp: Date.now(),
      });

      const pattern = state.detectIneffectivePattern();
      expect(pattern.detected).toBe(true);
      expect(pattern.similarCount).toBe(2);
    });

    it('detects stagnation (no steer in a while)', () => {
      const api = createMockApi();
      const state = new SupervisorStateManager(api);
      state.start('Test goal', 'anthropic', 'claude-haiku');

      state.addIntervention({
        message: 'Focus on X',
        reasoning: 'Test',
        timestamp: Date.now() - 120_000,
      });

      const pattern = state.detectIneffectivePattern();
      expect(pattern.detected).toBe(true);
      expect(pattern.secondsSinceLastSteer).toBeGreaterThanOrEqual(60);
    });

    it('detects dissimilar messages as different', () => {
      const api = createMockApi();
      const state = new SupervisorStateManager(api);
      state.start('Test goal', 'anthropic', 'claude-haiku');

      state.addIntervention({
        message: 'Implement the database layer',
        reasoning: 'Need DB',
        timestamp: Date.now(),
      });

      state.addIntervention({
        message: 'Now create the API endpoints',
        reasoning: 'Need API',
        timestamp: Date.now(),
      });

      const pattern = state.detectIneffectivePattern();
      expect(pattern.detected).toBe(false);
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

      const s = state.getState()!;
      expect(s.active).toBe(true);
      expect(s.outcome).toBe('Test goal');
      expect(s.provider).toBe('anthropic');
      expect(s.modelId).toBe('claude-haiku');
      expect(s.interventions).toEqual([]);
      expect(s.justSteered).toBe(false);
      expect(s.idleSteers).toBe(0);
    });

    it('stops supervision and marks inactive', () => {
      const api = createMockApi();
      const state = new SupervisorStateManager(api);

      state.start('Test goal', 'anthropic', 'claude-haiku');
      state.stop();
      expect(state.isActive()).toBe(false);
      expect(state.getState()!.active).toBe(false);
    });
  });

  describe('interventions', () => {
    it('adds intervention and marks justSteered', () => {
      const api = createMockApi();
      const state = new SupervisorStateManager(api);
      state.start('Test goal', 'anthropic', 'claude-haiku');

      state.addIntervention({
        message: 'Please focus on X',
        reasoning: 'Agent drifted',
        timestamp: Date.now(),
      });

      const s = state.getState()!;
      expect(s.interventions).toHaveLength(1);
      expect(s.justSteered).toBe(true);
    });

    it('clears justSteered flag', () => {
      const api = createMockApi();
      const state = new SupervisorStateManager(api);
      state.start('Test goal', 'anthropic', 'claude-haiku');

      state.addIntervention({ message: 'Steer', reasoning: 'Test', timestamp: Date.now() });
      expect(state.getState()!.justSteered).toBe(true);

      state.clearJustSteered();
      expect(state.getState()!.justSteered).toBe(false);
    });

    it('does not add intervention when not active', () => {
      const api = createMockApi();
      const state = new SupervisorStateManager(api);

      state.addIntervention({ message: 'Steer', reasoning: 'Test', timestamp: Date.now() });
      expect(state.getState()).toBeNull();
    });
  });

  describe('persistence', () => {
    it('does not persist justSteered (ephemeral)', () => {
      const api = createMockApi();
      const state = new SupervisorStateManager(api);
      state.start('Test goal', 'anthropic', 'claude-haiku');

      state.addIntervention({ message: 'Steer', reasoning: 'Test', timestamp: Date.now() });

      const lastCall = api.appendEntry.mock.calls[api.appendEntry.mock.calls.length - 1];
      const persistedData = lastCall[1];
      expect(persistedData.justSteered).toBeUndefined();
      expect(persistedData.outcome).toBe('Test goal');
    });
  });

  describe('idle steers', () => {
    it('tracks idle steers count', () => {
      const api = createMockApi();
      const state = new SupervisorStateManager(api);
      state.start('Test goal', 'anthropic', 'claude-haiku');

      expect(state.getIdleSteers()).toBe(0);
      state.incrementIdleSteers();
      expect(state.getIdleSteers()).toBe(1);
      state.incrementIdleSteers();
      expect(state.getIdleSteers()).toBe(2);
    });

    it('resets idle steers', () => {
      const api = createMockApi();
      const state = new SupervisorStateManager(api);
      state.start('Test goal', 'anthropic', 'claude-haiku');

      state.incrementIdleSteers();
      state.incrementIdleSteers();
      state.resetIdleSteers();
      expect(state.getIdleSteers()).toBe(0);
    });
  });
});

describe('detectMidRunSignals', () => {
  it('returns just_steered when justSteered is true', () => {
    const signal = detectMidRunSignals([], true);
    expect(signal).toEqual({ type: 'just_steered' });
  });

  it('returns null for empty messages', () => {
    const signal = detectMidRunSignals([], false);
    expect(signal).toBeNull();
  });

  it('returns null for normal conversation with no signals', () => {
    const messages: Message[] = [
      makeUserMessage('Fix the bug'),
      makeAssistantMessage('Let me check the code'),
      makeToolCallMessage('Read', { file_path: 'src/auth.ts' }),
      makeToolResultMessage('Read', 'export function login() {}'),
      makeAssistantMessage('I see the issue'),
      makeToolCallMessage('Edit', { file_path: 'src/auth.ts' }),
      makeToolResultMessage('Edit', 'ok'),
    ];

    const signal = detectMidRunSignals(messages, false);
    expect(signal).toBeNull();
  });

  it('does not trigger on a single tool error', () => {
    const messages: Message[] = [
      makeToolCallMessage('bash', { command: 'npm test' }),
      makeToolResultMessage('bash', 'Command failed with exit code 1', true),
    ];

    const signal = detectMidRunSignals(messages, false);
    expect(signal).toBeNull();
  });

  it('detects consecutive tool errors', () => {
    const messages: Message[] = [
      makeToolCallMessage('Edit', { file_path: 'src/auth.ts' }),
      makeToolResultMessage('Edit', 'file not found', true),
      makeToolCallMessage('Edit', { file_path: 'src/auth.ts' }),
      makeToolResultMessage('Edit', 'file not found', true),
    ];

    const signal = detectMidRunSignals(messages, false);
    expect(signal).not.toBeNull();
    expect(signal!.type).toBe('tool_error');
  });

  it('does not trigger when a successful result breaks the error streak', () => {
    const messages: Message[] = [
      makeToolCallMessage('Edit', { file_path: 'src/auth.ts' }),
      makeToolResultMessage('Edit', 'file not found', true),
      makeToolCallMessage('Read', { file_path: 'src/auth.ts' }),
      makeToolResultMessage('Read', 'file content'),
      makeToolCallMessage('Edit', { file_path: 'src/auth.ts' }),
      makeToolResultMessage('Edit', 'failed again', true),
    ];

    // Only 1 consecutive error at the tail — the successful Read broke the streak
    const signal = detectMidRunSignals(messages, false);
    expect(signal).toBeNull();
  });

  it('detects file read loop', () => {
    const messages: Message[] = [
      makeToolCallMessage('Read', { file_path: 'src/auth.ts' }),
      makeToolResultMessage('Read', 'content'),
      makeToolCallMessage('Read', { file_path: 'src/auth.ts' }),
      makeToolResultMessage('Read', 'content'),
      makeToolCallMessage('Read', { file_path: 'src/auth.ts' }),
      makeToolResultMessage('Read', 'content'),
      makeToolCallMessage('Read', { file_path: 'src/auth.ts' }),
      makeToolResultMessage('Read', 'content'),
    ];

    const signal = detectMidRunSignals(messages, false);
    expect(signal).not.toBeNull();
    expect(signal!.type).toBe('file_read_loop');
    expect(signal!.detail).toContain('src/auth.ts');
  });

  it('resets read loop counter when file is edited', () => {
    const messages: Message[] = [
      makeToolCallMessage('Read', { file_path: 'src/auth.ts' }),
      makeToolResultMessage('Read', 'content'),
      makeToolCallMessage('Read', { file_path: 'src/auth.ts' }),
      makeToolResultMessage('Read', 'content'),
      makeToolCallMessage('Read', { file_path: 'src/auth.ts' }),
      makeToolResultMessage('Read', 'content'),
      // Edit resets the counter for this file
      makeToolCallMessage('Edit', { file_path: 'src/auth.ts' }),
      makeToolResultMessage('Edit', 'ok'),
      // More reads after edit — counter restarts from 0
      makeToolCallMessage('Read', { file_path: 'src/auth.ts' }),
      makeToolResultMessage('Read', 'content'),
    ];

    const signal = detectMidRunSignals(messages, false);
    expect(signal).toBeNull();
  });

  it('detects read-only stagnation', () => {
    const messages: Message[] = [];
    for (let i = 0; i < 8; i++) {
      messages.push(makeToolCallMessage('Grep', { pattern: `search-${i}` }));
      messages.push(makeToolResultMessage('Grep', 'no matches'));
    }

    const signal = detectMidRunSignals(messages, false);
    expect(signal).not.toBeNull();
    expect(signal!.type).toBe('read_only_stagnation');
    expect(signal!.detail).toContain('read-only');
  });

  it('does not trigger stagnation when edits are present', () => {
    const messages: Message[] = [];
    for (let i = 0; i < 5; i++) {
      messages.push(makeToolCallMessage('Read', { file_path: `src/file${i}.ts` }));
      messages.push(makeToolResultMessage('Read', 'content'));
    }
    // An edit breaks the stagnation streak
    messages.push(makeToolCallMessage('Edit', { file_path: 'src/file0.ts' }));
    messages.push(makeToolResultMessage('Edit', 'ok'));
    for (let i = 0; i < 5; i++) {
      messages.push(makeToolCallMessage('Read', { file_path: `src/file${i}.ts` }));
      messages.push(makeToolResultMessage('Read', 'content'));
    }

    const signal = detectMidRunSignals(messages, false);
    expect(signal).toBeNull();
  });

  it('marks bash with test/build commands as progress (not stagnation)', () => {
    const messages: Message[] = [];
    for (let i = 0; i < 5; i++) {
      messages.push(makeToolCallMessage('Read', { file_path: `src/file${i}.ts` }));
      messages.push(makeToolResultMessage('Read', 'content'));
    }
    messages.push(makeToolCallMessage('bash', { command: 'npm test' }));
    messages.push(makeToolResultMessage('bash', 'tests passed'));

    const signal = detectMidRunSignals(messages, false);
    expect(signal).toBeNull();
  });

  it('prioritizes consecutive tool_error over file_read_loop', () => {
    const messages: Message[] = [
      makeToolCallMessage('Read', { file_path: 'src/a.ts' }),
      makeToolResultMessage('Read', 'content'),
      makeToolCallMessage('Read', { file_path: 'src/a.ts' }),
      makeToolResultMessage('Read', 'content'),
      makeToolCallMessage('Read', { file_path: 'src/a.ts' }),
      makeToolResultMessage('Read', 'content'),
      makeToolCallMessage('Read', { file_path: 'src/a.ts' }),
      makeToolResultMessage('Read', 'error reading file', true),
      makeToolCallMessage('Read', { file_path: 'src/a.ts' }),
      makeToolResultMessage('Read', 'error reading file', true),
    ];

    const signal = detectMidRunSignals(messages, false);
    expect(signal).not.toBeNull();
    expect(signal!.type).toBe('tool_error');
  });
});
