/**
 * settings-panel.ts — Interactive settings overlay for the supervisor.
 *
 * Uses pi-tui's SettingsList component to provide a navigable settings UI
 * with cycling values, submenu support (model picker), and live updates.
 *
 * Opened via `/supervise` (no args) or `/supervise settings`.
 *
 * Removed: sensitivity setting (now automatic)
 */

import { SettingsList, type SettingItem, type SettingsListTheme } from '@mariozechner/pi-tui';
import { ModelSelectorComponent, SettingsManager } from '@mariozechner/pi-coding-agent';
import type { ExtensionContext } from '@mariozechner/pi-coding-agent';
import type { SupervisorState } from '../types.js';
import { isWidgetVisible } from './status-widget.js';

export interface SettingsResult {
  model?: { provider: string; modelId: string };
  widget?: boolean;
  action?: 'stop' | 'start';
}

/**
 * Open the interactive settings panel.
 * Returns the changes the user made, or null if cancelled.
 */
export async function openSettings(
  ctx: ExtensionContext,
  state: SupervisorState | null,
  defaultProvider: string,
  defaultModelId: string
): Promise<SettingsResult | null> {
  const currentProvider = state?.provider ?? defaultProvider;
  const currentModelId = state?.modelId ?? defaultModelId;
  const isActive = state?.active === true;

  const result: SettingsResult = {};

  return ctx.ui.custom<SettingsResult | null>((tui, theme, _kb, done) => {
    const makeModelSubmenu = (currentValue: string, submenuDone: (selected?: string) => void) => {
      const [prov, mid] = currentValue.includes('/')
        ? [currentValue.split('/')[0], currentValue.split('/').slice(1).join('/')]
        : [currentProvider, currentValue];
      const currentModel = ctx.modelRegistry.find(prov, mid);
      const settingsManager = SettingsManager.inMemory();
      const component = new ModelSelectorComponent(
        tui,
        currentModel,
        settingsManager,
        ctx.modelRegistry,
        [],
        (model) => {
          result.model = { provider: model.provider, modelId: model.id };
          submenuDone(`${model.provider}/${model.id}`);
        },
        () => submenuDone()
      );
      component.focused = true;
      return component;
    };

    const items: SettingItem[] = [
      {
        id: 'model',
        label: 'Model',
        description: 'Supervisor LLM model (Enter to browse)',
        currentValue: `${currentProvider}/${currentModelId}`,
        submenu: makeModelSubmenu,
      },
      {
        id: 'widget',
        label: 'Widget',
        description: 'Show/hide the supervisor widget in the footer',
        currentValue: isWidgetVisible() ? 'visible' : 'hidden',
        values: ['visible', 'hidden'],
      },
    ];

    if (isActive) {
      items.push({
        id: 'outcome',
        label: 'Outcome',
        description: `Steers: ${state!.interventions.length} · Turns: ${state!.turnCount}`,
        currentValue: `"${state!.outcome.length > 60 ? state!.outcome.slice(0, 59) + '…' : state!.outcome}"`,
      });
      items.push({
        id: 'stop',
        label: 'Stop Supervision',
        description: 'Stop the active supervisor',
        currentValue: '',
        values: ['confirm'],
      });
    }

    const settingsTheme: SettingsListTheme = {
      label: (text, selected) =>
        selected ? theme.bold(theme.fg('accent', text)) : theme.fg('dim', text),
      value: (text, selected) => (selected ? theme.fg('accent', text) : theme.fg('muted', text)),
      description: (text) => theme.fg('dim', text),
      cursor: theme.fg('accent', '❯ '),
      hint: (text) => theme.fg('dim', text),
    };

    const settingsList = new SettingsList(
      items,
      12,
      settingsTheme,
      (id, newValue) => {
        if (id === 'widget') {
          result.widget = newValue === 'visible';
        } else if (id === 'stop' && newValue === 'confirm') {
          result.action = 'stop';
          done(result);
        }
      },
      () => {
        // Cancel — return null if no changes, or partial result if some changes were made
        const hasChanges = result.model || result.widget !== undefined;
        done(hasChanges ? result : null);
      }
    );

    return {
      render: (width: number) => {
        const lines: string[] = [];
        const title = isActive
          ? `${theme.fg('accent', '◉')} ${theme.bold('Supervisor Settings')} ${theme.fg('dim', '(active)')}`
          : `${theme.fg('dim', '○')} ${theme.bold('Supervisor Settings')}`;
        lines.push(title);
        lines.push(theme.fg('dim', '─'.repeat(Math.min(40, width))));
        lines.push(...settingsList.render(width));
        return lines;
      },
      invalidate: () => settingsList.invalidate(),
      handleInput: (data: string) => {
        settingsList.handleInput(data);
        tui.requestRender();
      },
    };
  });
}
