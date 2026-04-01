import { describe, expect, it, vi, beforeEach } from 'vitest';
import { updateUI, toggleWidget } from '../src/ui/status-widget.js';
import type { SupervisorState } from '../src/types.js';

// Mock the TUI module
vi.mock('@mariozechner/pi-tui', () => ({
  truncateToWidth: (text: string, width: number) => {
    if (text.length <= width) return text;
    return text.slice(0, width);
  },
}));

// Helper to create mock ExtensionContext
function createMockCtx() {
  const setStatusMock = vi.fn();
  const setWidgetMock = vi.fn();

  return {
    ui: {
      setStatus: setStatusMock,
      setWidget: setWidgetMock,
      notify: vi.fn(),
      select: vi.fn(),
    },
    sessionManager: {
      getBranch: vi.fn(() => []),
    },
    model: { provider: 'test', id: 'test-model' },
  } as any;
}

// Helper to create a mock supervisor state
function createMockState(overrides?: Partial<SupervisorState>): SupervisorState {
  return {
    active: true,
    outcome: 'Test goal',
    interventions: [],
    turnCount: 1,
    justSteered: false,
    lastAnalyzedTurn: 0,
    snapshotBuffer: [],
    reframeTier: 0,
    lastSteerTurn: -1,
    ...overrides,
  };
}

describe('status-widget', () => {
  beforeEach(() => {
    // Reset widget visibility before each test
    while (!toggleWidget()) {
      // Toggle until visible
    }
  });

  describe('thought clearing behavior', () => {
    it('clears old thoughts immediately when new thinking arrives', () => {
      const ctx = createMockCtx();
      const state = createMockState();

      // First call with initial thinking content
      updateUI(ctx, state, {
        type: 'analyzing',
        turn: 1,
        thinking: 'Initial thinking content that is long enough to wrap',
      });

      // Verify widget was set with initial thinking
      expect(ctx.ui.setWidget).toHaveBeenCalled();
      const firstWidgetCall = ctx.ui.setWidget.mock.calls[0];
      expect(firstWidgetCall[0]).toBe('supervisor');

      // Second call with new/different thinking content (simulating agent_end with new analysis)
      updateUI(ctx, state, {
        type: 'analyzing',
        turn: 2,
        thinking: 'Completely new thinking content for turn 2',
      });

      // Verify widget was updated again
      expect(ctx.ui.setWidget).toHaveBeenCalledTimes(2);

      // Get the render function from the second call
      const secondWidgetCall = ctx.ui.setWidget.mock.calls[1];
      const widgetFactory = secondWidgetCall[1];
      const mockTheme = {
        fg: (color: string, text: string) => text,
      };
      const widget = widgetFactory(null, mockTheme);

      // Render with enough width to see the content
      const lines = widget.render(100);

      // Should contain the new thinking, not the old
      const allText = lines.join(' ');
      expect(allText).toContain('Completely new thinking');
      expect(allText).not.toContain('Initial thinking content');
    });

    it('does not flash back old thoughts when clear animation is interrupted', () => {
      const ctx = createMockCtx();
      const state = createMockState();

      // Step 1: Set initial thinking content
      updateUI(ctx, state, {
        type: 'analyzing',
        turn: 1,
        thinking: 'First analysis thinking content that will be cleared',
      });

      // Step 2: Trigger the clear animation by going to watching state (simulating 15s delay completion)
      // First we need to trigger the clear timer - this happens when we go to a non-analyzing state
      // or when state becomes inactive. Let's use a steering action which triggers the animation.
      updateUI(ctx, state, {
        type: 'steering',
        message: 'Please focus',
      });

      // Step 3: Now simulate agent_end firing with new analyzing content
      // This is the key test - if old thoughts flash back, the bug exists
      updateUI(ctx, state, {
        type: 'analyzing',
        turn: 2,
        thinking: 'Fresh analysis after steering',
      });

      // Get the final widget state
      const lastCall = ctx.ui.setWidget.mock.calls[ctx.ui.setWidget.mock.calls.length - 1];
      const widgetFactory = lastCall[1];
      const mockTheme = {
        fg: (color: string, text: string) => text,
      };
      const widget = widgetFactory(null, mockTheme);
      const lines = widget.render(100);

      // Verify fresh content is shown, old content is not flashed back
      const allText = lines.join(' ');
      expect(allText).toContain('Fresh analysis after steering');
      expect(allText).not.toContain('First analysis thinking');
    });

    it('preserves animation state when same thinking content is updated', () => {
      const ctx = createMockCtx();
      const state = createMockState();

      // First call with thinking
      updateUI(ctx, state, {
        type: 'analyzing',
        turn: 1,
        thinking: 'Streaming thinking content',
      });

      // Second call with same thinking (simulating streaming update with same content)
      updateUI(ctx, state, {
        type: 'analyzing',
        turn: 1,
        thinking: 'Streaming thinking content',
      });

      // Should still have the content (not cleared since it's the same)
      const lastCall = ctx.ui.setWidget.mock.calls[ctx.ui.setWidget.mock.calls.length - 1];
      const widgetFactory = lastCall[1];
      const mockTheme = {
        fg: (color: string, text: string) => text,
      };
      const widget = widgetFactory(null, mockTheme);
      const lines = widget.render(100);

      const allText = lines.join(' ');
      expect(allText).toContain('Streaming thinking content');
    });

    it('clears thoughts when going to done state', () => {
      const ctx = createMockCtx();
      const state = createMockState();

      // First set some thinking
      updateUI(ctx, state, {
        type: 'analyzing',
        turn: 1,
        thinking: 'Analysis in progress',
      });

      // Then go to done state
      updateUI(ctx, state, { type: 'done' });

      // Should trigger clear timer setup (but not immediately clear)
      // The clear animation should be scheduled
      const lastCall = ctx.ui.setWidget.mock.calls[ctx.ui.setWidget.mock.calls.length - 1];
      const widgetFactory = lastCall[1];
      const mockTheme = {
        fg: (color: string, text: string) => text,
      };
      const widget = widgetFactory(null, mockTheme);
      const lines = widget.render(100);

      // The done action should show the done indicator
      const allText = lines.join(' ');
      expect(allText).toContain('done');
    });

    it('handles transition from cleared state to new analysis', async () => {
      const ctx = createMockCtx();
      const state = createMockState();

      // Initial analysis
      updateUI(ctx, state, {
        type: 'analyzing',
        turn: 1,
        thinking: 'Initial analysis',
      });

      // Go to done (triggers clear)
      updateUI(ctx, state, { type: 'done' });

      // Simulate another agent_end with new analysis
      // This should show new thinking, not old
      updateUI(ctx, state, {
        type: 'analyzing',
        turn: 2,
        thinking: 'New analysis after completion',
      });

      const lastCall = ctx.ui.setWidget.mock.calls[ctx.ui.setWidget.mock.calls.length - 1];
      const widgetFactory = lastCall[1];
      const mockTheme = {
        fg: (color: string, text: string) => text,
      };
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

      // Hide the widget
      toggleWidget();

      updateUI(ctx, state, {
        type: 'analyzing',
        turn: 1,
        thinking: 'Should not be visible',
      });

      // Should set widget to undefined when hidden
      expect(ctx.ui.setWidget).toHaveBeenCalledWith('supervisor', undefined);
    });
  });
});
