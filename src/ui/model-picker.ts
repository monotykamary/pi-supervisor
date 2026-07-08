/**
 * model-picker — opens the supervisor's interactive model selector.
 *
 * Uses our own SupervisorModelSelectorComponent (a copy of pi-core's
 * ModelSelectorComponent) so the supervisor picker has the same look and
 * feel as pi's /model selector — DynamicBorder top/bottom, search, scope
 * toggle, navigation — while keeping the choice isolated from pi's global
 * default model. Selection respects pi-model-sort's last-used ordering.
 *
 * Returns the selected Model, or null if the user cancelled. The caller
 * decides what to do with the choice (e.g. save to supervisor-config.json).
 */

import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { Model } from '@earendil-works/pi-ai';
import { SupervisorModelSelectorComponent } from './model-settings-selector.js';

/**
 * Open the interactive model picker.
 * Returns the selected Model, or null if the user cancelled.
 */
export async function pickModel(
  ctx: ExtensionContext,
  currentProvider?: string,
  currentModelId?: string
): Promise<Model<any> | null> {
  // Resolve the currently-selected supervisor model (to pre-highlight it).
  // Falls back to undefined when the provider/modelId is unknown — the
  // selector handles an undefined current model gracefully.
  const currentModel =
    currentProvider && currentModelId
      ? ctx.modelRegistry.find(currentProvider, currentModelId)
      : undefined;

  return ctx.ui.custom<Model<any> | null>((tui, theme, _kb, done) => {
    const component = new SupervisorModelSelectorComponent(
      tui,
      theme,
      currentModel,
      ctx.modelRegistry,
      [], // no scoped-model cycling — show the full available model list
      (model) => done(model),
      () => done(null)
    );

    // Give focus so the search input is active immediately
    component.focused = true;

    return {
      render: (width) => component.render(width),
      invalidate: () => component.invalidate(),
      handleInput: (data) => {
        component.handleInput(data);
        tui.requestRender();
      },
    };
  });
}
