/**
 * Supervisor UI - footer status indicator and widget.
 *
 * Footer: 🎯 emoji badge.
 * Widget line 1: ◉ Supervising · Goal: "..." · steers · action
 * Widget line 2: dim thinking text while analyzing (temporary)
 *
 * Toggle visibility with toggleWidget().
 */

import type { ExtensionContext } from '@mariozechner/pi-coding-agent';
import { truncateToWidth } from '@mariozechner/pi-tui';
import type { SupervisorIntervention, SupervisorState } from '../types.js';

const WIDGET_ID = 'supervisor';
const STATUS_ID = 'supervisor';
const CLEAR_DELAY_MS = 15000;
const ANIMATION_STEP_MS = 500;

let _widgetVisible = true;
let _clearTimer: ReturnType<typeof setTimeout> | null = null;
let _animationTimer: ReturnType<typeof setTimeout> | null = null;
let _lastActiveState: { outcome: string; interventions: SupervisorIntervention[] } | null = null;
let _lastThinking = '';
let _lastActionType: WidgetAction['type'] = 'watching';
let _lastThinkingLines: string[] = []; // Actual rendered thinking lines (plain text with indent)
let _hiddenLineCount = 0; // Number of lines hidden from top during animation

/** Toggle the widget on/off. Returns the new visibility state. */
export function toggleWidget(): boolean {
  _widgetVisible = !_widgetVisible;
  return _widgetVisible;
}

export function isWidgetVisible(): boolean {
  return _widgetVisible;
}

export type WidgetAction =
  | { type: 'watching'; reframeTier?: number }
  | { type: 'analyzing'; turn: number; reframeTier?: number; thinking?: string }
  | { type: 'steering'; message: string; reframeTier?: number }
  | { type: 'done'; reframeTier?: number }
  | { type: 'waiting'; message: string; turn: number; reframeTier?: number };

/**
 * Update footer + widget. Call this every time state or action changes.
 * Clears both when state is null or inactive, with a 15-second delay and
 * line-by-line animation for clearing thoughts.
 */
export function updateUI(
  ctx: ExtensionContext,
  state: SupervisorState | null,
  action: WidgetAction = { type: 'watching' }
): void {
  // Cancel any pending timers when state updates
  if (_clearTimer) {
    clearTimeout(_clearTimer);
    _clearTimer = null;
  }
  if (_animationTimer) {
    clearTimeout(_animationTimer);
    _animationTimer = null;
  }
  // Reset animation state
  _hiddenLineCount = 0;

  if (!state || !state.active) {
    // State became inactive - start animation after delay
    if (_lastActiveState && _lastThinkingLines.length > 0) {
      _clearTimer = setTimeout(() => {
        startLineClearAnimation(ctx);
      }, CLEAR_DELAY_MS);
      // Continue rendering with last known state
      const fallbackAction: WidgetAction = { type: 'done', reframeTier: 0 };
      _lastActionType = 'done';
      renderWithState(ctx, _lastActiveState, fallbackAction, _lastThinking, _hiddenLineCount);
      return;
    }
    // No previous state or no thinking lines to animate, clear immediately
    _lastThinkingLines = [];
    ctx.ui.setStatus(STATUS_ID, undefined);
    ctx.ui.setWidget(WIDGET_ID, undefined);
    return;
  }

  // Active state - capture it for delayed clear
  _lastActiveState = {
    outcome: state.outcome,
    interventions: [...state.interventions],
  };
  _lastActionType = action.type;
  if (action.type === 'analyzing' && action.thinking) {
    _lastThinking = action.thinking;
  }

  ctx.ui.setStatus(STATUS_ID, '🎯');

  if (!_widgetVisible) {
    ctx.ui.setWidget(WIDGET_ID, undefined);
    return;
  }

  renderWithState(ctx, _lastActiveState, action, _lastThinking, _hiddenLineCount);
}

/** Start the line-by-line clear animation - hides lines from top to bottom */
function startLineClearAnimation(ctx: ExtensionContext): void {
  if (!_lastActiveState || _lastThinkingLines.length === 0) return;

  const isSteering = _lastActionType === 'steering';
  // For steering: keep 1 line (will be truncated to ... at end)
  // For done: clear all lines
  const targetHiddenCount = isSteering ? _lastThinkingLines.length - 1 : _lastThinkingLines.length;

  const animateStep = () => {
    if (_hiddenLineCount >= targetHiddenCount) {
      if (isSteering && _lastThinkingLines.length > 0) {
        // Keep last line truncated with ...
        const lastLine = _lastThinkingLines[_lastThinkingLines.length - 1].replace(/^  /, '');
        _lastThinkingLines = ['  ' + truncateToWidth(lastLine, 77) + '...'];
        _hiddenLineCount = 0;
        renderWithState(
          ctx,
          _lastActiveState!,
          { type: 'steering', message: '', reframeTier: 0 },
          _lastThinkingLines[0],
          0
        );
        return;
      } else {
        // Done state - clear everything
        _lastActiveState = null;
        _lastThinking = '';
        _lastThinkingLines = [];
        _hiddenLineCount = 0;
        ctx.ui.setStatus(STATUS_ID, undefined);
        ctx.ui.setWidget(WIDGET_ID, undefined);
        return;
      }
    }

    _hiddenLineCount++;
    const fallbackAction: WidgetAction = isSteering
      ? { type: 'steering', message: '', reframeTier: 0 }
      : { type: 'done', reframeTier: 0 };
    renderWithState(ctx, _lastActiveState!, fallbackAction, '', _hiddenLineCount);

    _animationTimer = setTimeout(animateStep, ANIMATION_STEP_MS);
  };

  animateStep();
}

function renderWithState(
  ctx: ExtensionContext,
  snap: { outcome: string; interventions: SupervisorIntervention[] },
  action: WidgetAction,
  lastThinking: string,
  hideFromTop: number = 0
): void {
  ctx.ui.setWidget(WIDGET_ID, (_tui, theme) => {
    // Current action
    let actionStr: string;
    let thinking = lastThinking;
    switch (action.type) {
      case 'watching':
        actionStr = theme.fg('dim', 'watching');
        break;
      case 'analyzing':
        actionStr = theme.fg('warning', `⟳ turn ${action.turn}`);
        thinking = action.thinking ?? lastThinking;
        break;
      case 'steering':
        actionStr = theme.fg('warning', 'steering');
        break;
      case 'done':
        actionStr = theme.fg('accent', '✓ done');
        break;
      case 'waiting':
        actionStr = theme.fg('warning', `⏳ ${action.message}`);
        break;
    }

    // Build widget parts for middle truncation (goal is truncated, suffix is preserved)
    const sep = theme.fg('dim', ' · ');
    const isDone = action.type === 'done';
    const headerText = isDone ? 'Supervised' : 'Supervising';
    const header = `${theme.fg('accent', '◉')} ${theme.fg('accent', headerText)}`;
    const goalLabel = `${theme.fg('dim', 'Goal:')} `;
    const goalQuoteOpen = theme.fg('muted', '"');
    const goalQuoteClose = theme.fg('muted', '"');

    // Suffix parts (preserved - not truncated)
    const steerCount = snap.interventions.length;
    const steers = steerCount > 0 ? theme.fg('dim', `↗ ${steerCount}`) : '';
    const reframeTier = action.reframeTier ?? 0;
    const reframeStr = reframeTier > 0 ? theme.fg('error', `↻${reframeTier}`) : '';
    const suffixParts = [steers, reframeStr, actionStr].filter(Boolean);

    const thinkingPrefix = theme.fg('dim', '  ');
    const rawThinking = thinking;

    return {
      render: (width: number) => {
        // Add 1 space padding on the right so widget doesn't hug the edge
        const paddedWidth = Math.max(0, width - 1);

        // Build suffix first (we want to preserve these)
        const suffix = suffixParts.length > 0 ? sep + suffixParts.join(sep) : '';
        const prefix = header + sep + goalLabel + goalQuoteOpen;

        // Calculate available space for goal text (using padded width)
        // Strip ANSI for accurate width calculation
        const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
        const prefixWidth = stripAnsi(prefix).length;
        const suffixWidth = stripAnsi(suffix).length;
        const closeQuoteWidth = stripAnsi(goalQuoteClose).length;
        const availableForGoal = Math.max(
          0,
          paddedWidth - prefixWidth - suffixWidth - closeQuoteWidth
        );

        // Truncate goal to fit available space
        const rawGoal = snap.outcome;
        const truncatedGoal = truncateToWidth(rawGoal, availableForGoal);
        const goalText = theme.fg('muted', truncatedGoal);

        // Assemble final line (truncated to padded width)
        const line = prefix + goalText + goalQuoteClose + suffix;
        const l1 = truncateToWidth(line, paddedWidth);

        // During animation, show stored lines with top lines hidden
        if (hideFromTop > 0 && _lastThinkingLines.length > 0) {
          const visibleLines = _lastThinkingLines
            .slice(hideFromTop)
            .map((line) => theme.fg('dim', line));
          return [l1, ...visibleLines];
        }

        if (!rawThinking) {
          _lastThinkingLines = [];
          return [l1];
        }

        // Wrap thinking text naturally into multiple lines with dim color
        const thinkingIndent = stripAnsi(thinkingPrefix).length;
        const thinkingWords = rawThinking.split(' ');
        const thinkingLines: string[] = [];
        const plainLines: string[] = [];
        let currentThinkingLine = '';
        let currentPlainLine = '';

        for (const word of thinkingWords) {
          const testLine = currentPlainLine ? `${currentPlainLine} ${word}` : word;
          if (testLine.length <= paddedWidth - thinkingIndent) {
            currentPlainLine = testLine;
            currentThinkingLine = currentThinkingLine ? `${currentThinkingLine} ${word}` : word;
          } else {
            if (currentThinkingLine) {
              thinkingLines.push(thinkingPrefix + theme.fg('dim', currentThinkingLine));
              plainLines.push('  ' + currentPlainLine);
            }
            currentPlainLine = word;
            currentThinkingLine = word;
          }
        }
        if (currentThinkingLine) {
          thinkingLines.push(thinkingPrefix + theme.fg('dim', currentThinkingLine));
          plainLines.push('  ' + currentPlainLine);
        }

        // Store plain wrapped lines for animation
        _lastThinkingLines = plainLines;

        return [l1, ...thinkingLines];
      },
      invalidate: () => {},
    };
  });
}
