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
let _animatedLines: string[] = [];
let _animationStep = 0;

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
  _animatedLines = [];
  _animationStep = 0;

  if (!state || !state.active) {
    // State became inactive - start animation after delay
    if (_lastActiveState) {
      _clearTimer = setTimeout(() => {
        startClearAnimation(ctx);
      }, CLEAR_DELAY_MS);
      // Continue rendering with last known state
      const fallbackAction: WidgetAction = { type: 'done', reframeTier: 0 };
      _lastActionType = 'done';
      renderWithState(
        ctx,
        _lastActiveState,
        fallbackAction,
        _lastThinking,
        _animatedLines,
        _animationStep
      );
      return;
    }
    // No previous state to show, clear immediately
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

  renderWithState(ctx, _lastActiveState, action, _lastThinking, _animatedLines, _animationStep);
}

/** Start the line-by-line clear animation */
function startClearAnimation(ctx: ExtensionContext): void {
  if (!_lastActiveState) return;

  const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
  const thinkingPrefix = '  ';
  const paddedWidth = 80;

  // Calculate wrapped thinking lines
  const thinkingWords = _lastThinking.split(' ');
  const thinkingLines: string[] = [];
  let currentLine = '';

  for (const word of thinkingWords) {
    const testLine = currentLine ? `${currentLine} ${word}` : word;
    if (stripAnsi(testLine).length <= paddedWidth - thinkingPrefix.length) {
      currentLine = testLine;
    } else {
      if (currentLine) thinkingLines.push(currentLine);
      currentLine = word;
    }
  }
  if (currentLine) thinkingLines.push(currentLine);

  const isSteering = _lastActionType === 'steering';
  const totalLines = isSteering ? Math.max(0, thinkingLines.length - 1) : thinkingLines.length;

  const animateStep = (step: number) => {
    _animationStep = step;

    if (step >= totalLines) {
      if (isSteering && thinkingLines.length > 0) {
        // Keep last line truncated for steering mode
        const lastLine = thinkingLines[thinkingLines.length - 1];
        const truncated =
          truncateToWidth(lastLine, paddedWidth - thinkingPrefix.length - 3) + '...';
        _animatedLines = [thinkingPrefix + truncated];
        _lastThinking = _animatedLines[0];
        renderWithState(
          ctx,
          _lastActiveState!,
          { type: 'steering', message: '', reframeTier: 0 },
          _lastThinking,
          _animatedLines,
          step
        );
        return;
      } else {
        // Done state - clear everything after animation
        _lastActiveState = null;
        _lastThinking = '';
        _animatedLines = [];
        ctx.ui.setStatus(STATUS_ID, undefined);
        ctx.ui.setWidget(WIDGET_ID, undefined);
        return;
      }
    }

    // Build progressively emptying lines (from top, keeping bottom)
    _animatedLines = thinkingLines.slice(step).map((line) => '  ' + line);
    const fallbackAction: WidgetAction = isSteering
      ? { type: 'steering', message: '', reframeTier: 0 }
      : { type: 'done', reframeTier: 0 };
    renderWithState(ctx, _lastActiveState!, fallbackAction, _lastThinking, _animatedLines, step);

    _animationTimer = setTimeout(() => animateStep(step + 1), ANIMATION_STEP_MS);
  };

  animateStep(0);
}

function renderWithState(
  ctx: ExtensionContext,
  snap: { outcome: string; interventions: SupervisorIntervention[] },
  action: WidgetAction,
  lastThinking: string,
  animatedLines: string[] = [],
  animationStep: number = 0
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
    const rawThinking = animatedLines.length > 0 ? '' : thinking;

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

        // If animating, show the progressively cleared lines
        if (animatedLines.length > 0) {
          const dimAnimatedLines = animatedLines.map((line) => theme.fg('dim', line));
          return [l1, ...dimAnimatedLines];
        }

        if (!rawThinking) return [l1];

        // Wrap thinking text naturally into multiple lines with dim color
        const thinkingIndent = stripAnsi(thinkingPrefix).length;
        const thinkingWords = rawThinking.split(' ');
        const thinkingLines: string[] = [];
        let currentThinkingLine = '';

        for (const word of thinkingWords) {
          const testLine = currentThinkingLine ? `${currentThinkingLine} ${word}` : word;
          if (testLine.length <= paddedWidth - thinkingIndent) {
            currentThinkingLine = testLine;
          } else {
            if (currentThinkingLine) {
              thinkingLines.push(thinkingPrefix + theme.fg('dim', currentThinkingLine));
            }
            currentThinkingLine = word;
          }
        }
        if (currentThinkingLine) {
          thinkingLines.push(thinkingPrefix + theme.fg('dim', currentThinkingLine));
        }

        return [l1, ...thinkingLines];
      },
      invalidate: () => {},
    };
  });
}
