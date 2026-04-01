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
let _storedAction: WidgetAction | null = null;
let _lastRenderedWidth = 80;
let _lastThinkingLines: string[] = [];
let _hiddenFromBottomCount = 0;

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
  if (_clearTimer) {
    clearTimeout(_clearTimer);
    _clearTimer = null;
  }
  if (_animationTimer) {
    clearTimeout(_animationTimer);
    _animationTimer = null;
  }
  _hiddenFromBottomCount = 0;

  // Start animation for done (inactive) or steering (active but intervening)
  const shouldAnimate = !state || !state.active || action.type === 'steering';

  if (shouldAnimate && _lastActiveState && _lastThinkingLines.length > 0) {
    _clearTimer = setTimeout(() => {
      startLineClearAnimation(ctx);
    }, CLEAR_DELAY_MS);
    const fallbackAction: WidgetAction =
      action.type === 'steering'
        ? { type: 'steering', message: '', reframeTier: action.reframeTier }
        : { type: 'done', reframeTier: 0 };
    _lastActionType = fallbackAction.type;
    _storedAction = fallbackAction;
    renderWithState(ctx, _lastActiveState, fallbackAction, _lastThinking, _hiddenFromBottomCount);
    return;
  }

  if (!state || !state.active) {
    _lastThinkingLines = [];
    ctx.ui.setStatus(STATUS_ID, undefined);
    ctx.ui.setWidget(WIDGET_ID, undefined);
    return;
  }

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

  renderWithState(ctx, _lastActiveState, action, _lastThinking, _hiddenFromBottomCount);
}

/** Start the line-by-line clear animation - hides lines from bottom to top */
function startLineClearAnimation(ctx: ExtensionContext): void {
  if (!_lastActiveState || _lastThinkingLines.length === 0) return;

  const isSteering = _lastActionType === 'steering';
  const targetVisibleCount = isSteering ? 1 : 0;

  const animateStep = () => {
    const currentVisible = _lastThinkingLines.length - _hiddenFromBottomCount;

    if (currentVisible <= targetVisibleCount) {
      if (isSteering && _lastThinkingLines.length > 0) {
        // Keep first (oldest) line, truncate end to fit with ... (avoid double …)
        const firstLine = _lastThinkingLines[0].replace(/^  /, '');
        const maxLen = Math.max(0, _lastRenderedWidth - 2 - 3); // 2 for indent, 3 for ...
        const truncated =
          firstLine.length > maxLen ? firstLine.slice(0, maxLen) + '...' : firstLine;
        _lastThinkingLines = ['  ' + truncated];
        _hiddenFromBottomCount = 0;
        // Use stored action to preserve reframe tier
        const reframeTier =
          _storedAction?.type === 'steering' ? (_storedAction.reframeTier ?? 0) : 0;
        renderWithState(
          ctx,
          _lastActiveState!,
          { type: 'steering', message: '', reframeTier },
          _lastThinkingLines[0],
          0
        );
        return;
      } else {
        _lastActiveState = null;
        _lastThinking = '';
        _lastThinkingLines = [];
        _hiddenFromBottomCount = 0;
        _storedAction = null;
        ctx.ui.setStatus(STATUS_ID, undefined);
        ctx.ui.setWidget(WIDGET_ID, undefined);
        return;
      }
    }

    _hiddenFromBottomCount++;
    const reframeTier = _storedAction?.type === 'steering' ? (_storedAction.reframeTier ?? 0) : 0;
    const fallbackAction: WidgetAction = isSteering
      ? { type: 'steering', message: '', reframeTier }
      : { type: 'done', reframeTier: 0 };
    renderWithState(ctx, _lastActiveState!, fallbackAction, '', _hiddenFromBottomCount);

    _animationTimer = setTimeout(animateStep, ANIMATION_STEP_MS);
  };

  animateStep();
}

function renderWithState(
  ctx: ExtensionContext,
  snap: { outcome: string; interventions: SupervisorIntervention[] },
  action: WidgetAction,
  lastThinking: string,
  hideFromBottom: number = 0
): void {
  ctx.ui.setWidget(WIDGET_ID, (_tui, theme) => {
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

    const sep = theme.fg('dim', ' · ');
    const isDone = action.type === 'done';
    const headerText = isDone ? 'Supervised' : 'Supervising';
    const header = `${theme.fg('accent', '◉')} ${theme.fg('accent', headerText)}`;
    const goalLabel = `${theme.fg('dim', 'Goal:')} `;
    const goalQuoteOpen = theme.fg('muted', '"');
    const goalQuoteClose = theme.fg('muted', '"');

    const steerCount = snap.interventions.length;
    const steers = steerCount > 0 ? theme.fg('dim', `↗ ${steerCount}`) : '';
    const reframeTier = action.reframeTier ?? 0;
    const reframeStr = reframeTier > 0 ? theme.fg('error', `↻${reframeTier}`) : '';
    const suffixParts = [steers, reframeStr, actionStr].filter(Boolean);

    const thinkingPrefix = theme.fg('dim', '  ');
    const rawThinking = thinking;

    return {
      render: (width: number) => {
        const paddedWidth = Math.max(0, width - 1);
        _lastRenderedWidth = paddedWidth;
        const suffix = suffixParts.length > 0 ? sep + suffixParts.join(sep) : '';
        const prefix = header + sep + goalLabel + goalQuoteOpen;

        const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
        const prefixWidth = stripAnsi(prefix).length;
        const suffixWidth = stripAnsi(suffix).length;
        const closeQuoteWidth = stripAnsi(goalQuoteClose).length;
        const availableForGoal = Math.max(
          0,
          paddedWidth - prefixWidth - suffixWidth - closeQuoteWidth
        );

        const rawGoal = snap.outcome;
        const truncatedGoal = truncateToWidth(rawGoal, availableForGoal);
        const goalText = theme.fg('muted', truncatedGoal);

        const line = prefix + goalText + goalQuoteClose + suffix;
        const l1 = truncateToWidth(line, paddedWidth);

        // During animation, hide lines from the bottom (keep top/oldest visible)
        if (hideFromBottom > 0 && _lastThinkingLines.length > 0) {
          const visibleCount = Math.max(0, _lastThinkingLines.length - hideFromBottom);
          const visibleLines = _lastThinkingLines
            .slice(0, visibleCount)
            .map((line) => theme.fg('dim', line));
          return [l1, ...visibleLines];
        }

        if (!rawThinking) {
          _lastThinkingLines = [];
          return [l1];
        }

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

        _lastThinkingLines = plainLines;
        return [l1, ...thinkingLines];
      },
      invalidate: () => {},
    };
  });
}
