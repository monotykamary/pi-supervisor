import { describe, expect, it, vi, beforeEach } from 'vitest';
import { updateUI, toggleWidget } from '../src/ui/renderer.js';
import { createInitialState, type WidgetState } from '../src/ui/types.js';
import type { SupervisorState } from '../src/types.js';

vi.mock('@earendil-works/pi-tui', () => ({
  truncateToWidth: (text: string, width: number) => {
    if (text.length <= width) return text;
    return text.slice(0, width);
  },
}));

function createMockCtx() {
  const setWidgetMock = vi.fn();
  return {
    ui: {
      setWidget: setWidgetMock,
      notify: vi.fn(),
    },
    sessionManager: {
      getBranch: vi.fn(() => []),
    },
    model: { provider: 'test', id: 'test-model' },
  } as any;
}

function createMockState(overrides?: Partial<SupervisorState>): SupervisorState {
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

function createWidgetState(): WidgetState {
  return createInitialState();
}

const mockTheme = {
  fg: (_color: string, text: string) => text,
};

describe('status-widget', () => {
  let widgetState: WidgetState;

  beforeEach(() => {
    widgetState = createWidgetState();
  });

  describe('thought clearing behavior', () => {
    it('clears old thoughts immediately when new thinking arrives', () => {
      const ctx = createMockCtx();
      const state = createMockState();

      updateUI(ctx, widgetState, state, {
        type: 'analyzing',
        thinking: 'Initial thinking content that is long enough to wrap',
      });

      expect(ctx.ui.setWidget).toHaveBeenCalled();

      updateUI(ctx, widgetState, state, {
        type: 'analyzing',
        thinking: 'Completely new thinking content for turn 2',
      });

      const lastCall = ctx.ui.setWidget.mock.calls[ctx.ui.setWidget.mock.calls.length - 1];
      const widgetFactory = lastCall[1];
      const widget = widgetFactory(null, mockTheme);
      const lines = widget.render(100);

      const allText = lines.join(' ');
      expect(allText).toContain('Completely new thinking');
      expect(allText).not.toContain('Initial thinking content');
    });

    it('immediately clears thinking when leaving analyzing for steering', () => {
      const ctx = createMockCtx();
      const state = createMockState();

      updateUI(ctx, widgetState, state, {
        type: 'analyzing',
        thinking: 'Analysis thinking that should disappear immediately on steer',
      });

      updateUI(ctx, widgetState, state, {
        type: 'steering',
        message: 'Please fix this issue',
        reframeTier: 0,
      });

      const lastCall = ctx.ui.setWidget.mock.calls[ctx.ui.setWidget.mock.calls.length - 1];
      const widgetFactory = lastCall[1];
      const widget = widgetFactory(null, mockTheme);
      const lines = widget.render(100);

      expect(lines.length).toBe(1);
      const allText = lines.join(' ');
      expect(allText).toContain('steering');
      expect(allText).not.toContain('Analysis thinking');
    });

    it('does not accumulate stale thinking through multiple rapid steers', () => {
      const ctx = createMockCtx();
      const state = createMockState();

      updateUI(ctx, widgetState, state, {
        type: 'analyzing',
        thinking: 'Initial analysis content',
      });

      for (let i = 0; i < 5; i++) {
        updateUI(ctx, widgetState, state, {
          type: 'steering',
          message: `Steer ${i + 1}`,
          reframeTier: 0,
        });
      }

      const lastCall = ctx.ui.setWidget.mock.calls[ctx.ui.setWidget.mock.calls.length - 1];
      const widgetFactory = lastCall[1];
      const widget = widgetFactory(null, mockTheme);
      const lines = widget.render(100);

      expect(lines.length).toBe(1);
      const allText = lines.join(' ');
      expect(allText).not.toContain('Initial analysis');
      expect(allText).toContain('steering');
    });

    it('keeps thinking visible when leaving analyzing for done state', () => {
      const ctx = createMockCtx();
      const state = createMockState();

      updateUI(ctx, widgetState, state, {
        type: 'analyzing',
        thinking: 'Analysis that should remain visible on done',
      });

      updateUI(ctx, widgetState, state, { type: 'done' });

      const lastCall = ctx.ui.setWidget.mock.calls[ctx.ui.setWidget.mock.calls.length - 1];
      const widgetFactory = lastCall[1];
      const widget = widgetFactory(null, mockTheme);
      const lines = widget.render(100);

      // Done state should show thinking lines (they animate away later)
      expect(lines.length).toBeGreaterThan(1);
      const allText = lines.join(' ');
      expect(allText).toContain('done');
      expect(allText).toContain('Analysis that should remain visible on done');
    });

    it('does not flash old thoughts when re-entering analyzing after steering', () => {
      const ctx = createMockCtx();
      const state = createMockState();

      updateUI(ctx, widgetState, state, {
        type: 'analyzing',
        thinking: 'First round of analysis',
      });

      updateUI(ctx, widgetState, state, {
        type: 'steering',
        message: 'Fix this',
      });

      updateUI(ctx, widgetState, state, {
        type: 'analyzing',
        thinking: 'Fresh second round analysis',
      });

      const lastCall = ctx.ui.setWidget.mock.calls[ctx.ui.setWidget.mock.calls.length - 1];
      const widgetFactory = lastCall[1];
      const widget = widgetFactory(null, mockTheme);
      const lines = widget.render(100);

      const allText = lines.join(' ');
      expect(allText).toContain('Fresh second round');
      expect(allText).not.toContain('First round');
    });

    it('handles transition from cleared state to new analysis', () => {
      const ctx = createMockCtx();
      const state = createMockState();

      updateUI(ctx, widgetState, state, {
        type: 'analyzing',
        thinking: 'Initial analysis',
      });

      updateUI(ctx, widgetState, state, { type: 'done' });

      updateUI(ctx, widgetState, state, {
        type: 'analyzing',
        thinking: 'New analysis after completion',
      });

      const lastCall = ctx.ui.setWidget.mock.calls[ctx.ui.setWidget.mock.calls.length - 1];
      const widgetFactory = lastCall[1];
      const widget = widgetFactory(null, mockTheme);
      const lines = widget.render(100);

      const allText = lines.join(' ');
      expect(allText).toContain('New analysis after completion');
      expect(allText).not.toContain('Initial analysis');
    });
  });

  describe('widget visibility', () => {
    it('hides widget when toggle is off', () => {
      const ctx = createMockCtx();
      const state = createMockState();

      toggleWidget(widgetState);

      updateUI(ctx, widgetState, state, {
        type: 'analyzing',
        thinking: 'Should not be visible',
      });

      expect(ctx.ui.setWidget).toHaveBeenCalledWith('supervisor', undefined);
    });
  });

  describe('goal rendering', () => {
    it('sanitizes newlines in the goal to keep the header on a single line', () => {
      const ctx = createMockCtx();
      const state = createMockState({
        outcome: 'Fix two bugs\n1. Bug 2 (PRIMARY): PtyTreeRow',
      });

      updateUI(ctx, widgetState, state, { type: 'watching' });

      const lastCall = ctx.ui.setWidget.mock.calls[ctx.ui.setWidget.mock.calls.length - 1];
      const widgetFactory = lastCall[1];
      const widget = widgetFactory(null, mockTheme);
      const lines = widget.render(100);

      expect(lines.length).toBe(1);
      expect(lines[0]).toContain('Fix two bugs 1. Bug 2 (PRIMARY): PtyTreeRow');
    });
  });
});
