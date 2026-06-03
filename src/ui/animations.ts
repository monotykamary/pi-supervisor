/**
 * Animation utilities for the supervisor widget.
 */

import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { WidgetState, WidgetAction } from './types.js';
import type { SupervisorIntervention } from '../types.js';
import { WIDGET_ID, ANIMATION_STEP_MS } from './types.js';

/** Type for the render function callback */
export type RenderFn = (
  ctx: ExtensionContext,
  snap: { outcome: string; interventions: SupervisorIntervention[] },
  action: WidgetAction,
  lastThinking: string,
  hideFromBottom: number
) => void;

/** Start the line-by-line clear animation - hides lines from bottom to top */
export function startLineClearAnimation(
  ctx: ExtensionContext,
  state: WidgetState,
  renderFn: RenderFn
): void {
  if (!state.lastActiveState) return;

  const actionType = state.lastActionType;
  const isSupervisorDone = actionType === 'done';
  const hasThinkingLines = state.lastThinkingLines.length > 0;
  const targetVisibleCount = 0;

  // Build the completion action based on what we're transitioning to
  const getCompletionAction = (): WidgetAction => {
    if (actionType === 'steering') {
      const reframeTier =
        state.storedAction?.type === 'steering' ? (state.storedAction.reframeTier ?? 0) : 0;
      return { type: 'steering', message: '', reframeTier };
    }
    if (isSupervisorDone) {
      return { type: 'done', reframeTier: 0 };
    }
    if (actionType === 'waiting') {
      const message =
        state.storedAction?.type === 'waiting' ? state.storedAction.message : '';
      const reframeTier =
        state.storedAction?.type === 'waiting' ? (state.storedAction.reframeTier ?? 0) : 0;
      return { type: 'waiting', message, reframeTier };
    }
    if (actionType === 'inferring') {
      return { type: 'inferring' };
    }
    // watching or other active states
    const reframeTier =
      state.storedAction && 'reframeTier' in state.storedAction
        ? (state.storedAction.reframeTier ?? 0)
        : 0;
    return { type: actionType, reframeTier } as WidgetAction;
  };

  const animateStep = () => {
    const currentVisible = state.lastThinkingLines.length - state.hiddenFromBottomCount;

    // No thinking lines: skip straight to completion (clear or final render)
    if (!hasThinkingLines || currentVisible <= targetVisibleCount) {
      // Animation complete
      state.lastThinkingLines = [];
      state.hiddenFromBottomCount = 0;
      state.lastThinking = '';

      if (isSupervisorDone) {
        // Done: clear the widget entirely
        state.lastActiveState = null;
        state.storedAction = null;
        ctx.ui.setWidget(WIDGET_ID, undefined);
      } else if (actionType === 'inferring') {
        // Inferring: render with empty outcome (no goal yet)
        const inferSnap = {
          outcome: '',
          interventions: state.lastActiveState?.interventions ?? [],
        };
        renderFn(ctx, inferSnap, { type: 'inferring' }, '', 0);
      } else {
        // Steering/watching/other: render the final state with no thinking
        renderFn(ctx, state.lastActiveState!, getCompletionAction(), '', 0);
      }
      return;
    }

    state.hiddenFromBottomCount++;
    renderFn(ctx, state.lastActiveState!, getCompletionAction(), '', state.hiddenFromBottomCount);

    state.animationTimer = setTimeout(animateStep, ANIMATION_STEP_MS);
  };

  animateStep();
}
