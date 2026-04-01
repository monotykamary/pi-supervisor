/**
 * Supervisor UI — footer status indicator and widget.
 *
 * Footer: 🎯 emoji badge.
 * Widget line 1: ◉ Supervising · Goal: "…" · steers · action
 * Widget line 2: dim thinking text while analyzing (temporary)
 *
 * Toggle visibility with toggleWidget().
 */

import type { ExtensionContext } from '@mariozechner/pi-coding-agent';
import { truncateToWidth } from '@mariozechner/pi-tui';
import type { SupervisorState } from '../types.js';

const WIDGET_ID = 'supervisor';
const STATUS_ID = 'supervisor';

let _widgetVisible = true;

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

// Text truncation is now handled dynamically by truncateToWidth based on window width

/**
 * Update footer + widget. Call this every time state or action changes.
 * Clears both when state is null or inactive.
 */
export function updateUI(
  ctx: ExtensionContext,
  state: SupervisorState | null,
  action: WidgetAction = { type: 'watching' }
): void {
  if (!state || !state.active) {
    ctx.ui.setStatus(STATUS_ID, undefined);
    ctx.ui.setWidget(WIDGET_ID, undefined);
    return;
  }

  ctx.ui.setStatus(STATUS_ID, '🎯');

  if (!_widgetVisible) {
    ctx.ui.setWidget(WIDGET_ID, undefined);
    return;
  }

  const snap = {
    outcome: state.outcome,
    interventions: [...state.interventions],
  };
  const snapAction = action;

  ctx.ui.setWidget(WIDGET_ID, (_tui, theme) => {
    // Current action
    let actionStr: string;
    let thinking = '';
    switch (snapAction.type) {
      case 'watching':
        actionStr = theme.fg('dim', 'watching');
        break;
      case 'analyzing':
        actionStr = theme.fg('warning', `⟳ turn ${snapAction.turn}`);
        thinking = snapAction.thinking ?? '';
        break;
      case 'steering':
        actionStr = theme.fg('warning', 'steering');
        break;
      case 'done':
        actionStr = theme.fg('accent', '✓ done');
        break;
      case 'waiting':
        actionStr = theme.fg('warning', `⏳ ${snapAction.message}`);
        break;
    }

    // Build widget parts for middle truncation (goal is truncated, suffix is preserved)
    const sep = theme.fg('dim', ' · ');
    const header = `${theme.fg('accent', '◉')} ${theme.fg('accent', 'Supervising')}`;
    const goalLabel = `${theme.fg('dim', 'Goal:')} `;
    const goalQuoteOpen = theme.fg('muted', '"');
    const goalQuoteClose = theme.fg('muted', '"');

    // Suffix parts (preserved - not truncated)
    const steerCount = snap.interventions.length;
    const steers = steerCount > 0 ? theme.fg('dim', `↗ ${steerCount}`) : '';
    const reframeTier = snapAction.reframeTier ?? 0;
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

        if (!rawThinking) return [l1];

        // Wrap thinking text naturally into multiple lines
        const thinkingIndent = stripAnsi(thinkingPrefix).length;
        const thinkingLines: string[] = [];
        const words = rawThinking.split(' ');
        let currentLine = '';

        for (const word of words) {
          const testLine = currentLine ? `${currentLine} ${word}` : word;
          if (stripAnsi(testLine).length <= paddedWidth - thinkingIndent) {
            currentLine = testLine;
          } else {
            if (currentLine) {
              thinkingLines.push(thinkingPrefix + currentLine);
            }
            currentLine = word;
          }
        }
        if (currentLine) {
          thinkingLines.push(thinkingPrefix + currentLine);
        }

        return [l1, ...thinkingLines];
      },
      invalidate: () => {},
    };
  });
}
