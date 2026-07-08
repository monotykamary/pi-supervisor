/**
 * SupervisorModelSelectorComponent — a copy of pi-core's ModelSelectorComponent
 * used by the supervisor's own model picker (/supervise model).
 *
 * Copies pi-core's /model selector to the tee:
 *   - DynamicBorder top + bottom borders
 *   - Spacer-separated layout
 *   - all/scoped scope toggle (Tab) with hint text
 *   - search Input (fuzzy filter, mirrors getModelSelectorSearchText)
 *   - up/down navigation with wrap-around
 *   - Enter to select, Escape/Ctrl+C to cancel
 *   - scroll indicator + selected-model name line
 *   - error/empty-state handling
 *
 * Intentional differences from pi-core (the reasons we copy instead of reuse):
 *   - Theme is passed in. pi-core imports a global `theme` singleton, which is
 *     unsafe under jiti (the extension host keeps a separate module cache and
 *     the global theme may be undefined — see DynamicBorder's note). Passing
 *     the live theme in keeps borders and colors correct in extension mode.
 *   - No SettingsManager. pi-core's handleSelect() writes the choice into pi's
 *     global default model (the user's main chat model). The supervisor must
 *     NOT change the user's main model — it picks its own supervisor model,
 *     persisted by the caller to .pi/supervisor-config.json.
 *   - Sort respects pi-model-sort's last-used order when installed (see
 *     ./model-sort.ts), so the supervisor picker matches the user's /model
 *     ordering. Falls back to pi-core's provider sort otherwise.
 */

import {
  Container,
  fuzzyFilter,
  getKeybindings,
  Input,
  Spacer,
  Text,
  type TUI,
} from '@earendil-works/pi-tui';
import {
  DynamicBorder,
  keyHint,
  type ModelRegistry,
  type Theme,
} from '@earendil-works/pi-coding-agent';
import { modelsAreEqual, type Model } from '@earendil-works/pi-ai';
import {
  buildModelKey,
  hasUsageData,
  readModelSortLastUsed,
  sortByLastUsed,
  type LastUsedMap,
} from './model-sort.js';

interface ModelItem {
  provider: string;
  id: string;
  model: Model<any>;
}

interface ScopedModel {
  model: Model<any>;
  thinkingLevel?: string;
}

/**
 * Replicates pi-core's internal getModelSelectorSearchText (not exported from
 * the public API). Ranks exact provider-prefixed queries before proxy
 * provider IDs like openrouter/openai/gpt-5, so the bare model ID is kept out
 * of the leading position.
 */
function getModelSelectorSearchText(item: { id: string; provider: string; name?: string }): string {
  const { id, provider } = item;
  const name = item.name ? ` ${item.name}` : '';
  return `${provider} ${provider}/${id} ${provider} ${id}${name}`;
}

function currentModelKey(model: Model<any> | undefined): string | null {
  if (!model?.provider || !model?.id) return null;
  return buildModelKey(model.provider, model.id);
}

export class SupervisorModelSelectorComponent extends Container {
  // Focusable — propagate to searchInput for IME cursor positioning
  private _focused = false;
  get focused(): boolean {
    return this._focused;
  }
  set focused(value: boolean) {
    this._focused = value;
    this.searchInput.focused = value;
  }

  private readonly theme: Theme;
  private readonly tui: TUI;
  private readonly modelRegistry: ModelRegistry;
  private currentModel: Model<any> | undefined;
  private scopedModels: ScopedModel[];

  private readonly searchInput: Input;
  private readonly listContainer: Container;
  private scopeText?: Text;
  private scopeHintText?: Text;

  private allModels: ModelItem[] = [];
  private scopedModelItems: ModelItem[] = [];
  private activeModels: ModelItem[] = [];
  private filteredModels: ModelItem[] = [];
  private selectedIndex = 0;
  private scope: 'all' | 'scoped' = 'all';
  private errorMessage?: string;

  private readonly lastUsed: LastUsedMap | null;
  private readonly onSelect: (model: Model<any>) => void;
  private readonly onCancel: () => void;

  constructor(
    tui: TUI,
    theme: Theme,
    currentModel: Model<any> | undefined,
    modelRegistry: ModelRegistry,
    scopedModels: ScopedModel[],
    onSelect: (model: Model<any>) => void,
    onCancel: () => void,
    initialSearchInput?: string
  ) {
    super();
    this.tui = tui;
    this.theme = theme;
    this.currentModel = currentModel;
    this.modelRegistry = modelRegistry;
    this.scopedModels = scopedModels;
    this.scope = scopedModels.length > 0 ? 'scoped' : 'all';
    this.onSelect = onSelect;
    this.onCancel = onCancel;
    this.lastUsed = readModelSortLastUsed();

    // Top border
    this.addChild(new DynamicBorder((s) => theme.fg('border', s)));
    this.addChild(new Spacer(1));

    // Scope hint, or the "configure more providers" warning
    if (scopedModels.length > 0) {
      this.scopeText = new Text(this.getScopeText(), 0, 0);
      this.addChild(this.scopeText);
      this.scopeHintText = new Text(this.getScopeHintText(), 0, 0);
      this.addChild(this.scopeHintText);
    } else {
      const hintText =
        'Only showing models from configured providers. Use /login to add providers.';
      this.addChild(new Text(theme.fg('warning', hintText), 0, 0));
    }
    this.addChild(new Spacer(1));

    // Search input
    this.searchInput = new Input();
    if (initialSearchInput) {
      this.searchInput.setValue(initialSearchInput);
    }
    this.searchInput.onSubmit = () => {
      // Enter on the search input selects the highlighted filtered item
      if (this.filteredModels[this.selectedIndex]) {
        this.handleSelect(this.filteredModels[this.selectedIndex].model);
      }
    };
    this.addChild(this.searchInput);
    this.addChild(new Spacer(1));

    // List
    this.listContainer = new Container();
    this.addChild(this.listContainer);
    this.addChild(new Spacer(1));

    // Bottom border
    this.addChild(new DynamicBorder((s) => theme.fg('border', s)));

    // Load models and do the initial render
    this.loadModels().then(() => {
      if (initialSearchInput) {
        this.filterModels(initialSearchInput);
      } else {
        this.updateList();
      }
      this.tui.requestRender();
    });
  }

  private async loadModels(): Promise<void> {
    let models: ModelItem[];
    // Refresh to pick up any changes to models.json
    this.modelRegistry.refresh();
    const loadError = this.modelRegistry.getError();
    if (loadError) {
      this.errorMessage = loadError;
    }

    try {
      const availableModels = this.modelRegistry.getAvailable();
      models = availableModels.map((model) => ({
        provider: model.provider,
        id: model.id,
        model,
      }));
    } catch (error) {
      this.allModels = [];
      this.scopedModelItems = [];
      this.activeModels = [];
      this.filteredModels = [];
      this.errorMessage = error instanceof Error ? error.message : String(error);
      return;
    }

    this.allModels = this.sortModels(models);
    this.scopedModels = this.scopedModels.map((scoped) => {
      const refreshed = this.modelRegistry.find(scoped.model.provider, scoped.model.id);
      return refreshed ? { ...scoped, model: refreshed } : scoped;
    });
    this.scopedModelItems = this.scopedModels.map((scoped) => ({
      provider: scoped.model.provider,
      id: scoped.model.id,
      model: scoped.model,
    }));
    this.activeModels = this.scope === 'scoped' ? this.scopedModelItems : this.allModels;
    this.filteredModels = this.activeModels;

    const currentIndex = this.filteredModels.findIndex((item) =>
      modelsAreEqual(this.currentModel, item.model)
    );
    this.selectedIndex =
      currentIndex >= 0
        ? currentIndex
        : Math.min(this.selectedIndex, Math.max(0, this.filteredModels.length - 1));
  }

  /**
   * Sort the model list. When pi-model-sort is installed and has recorded
   * usage, mirror its last-used order (current model first → most recent →
   * provider/id). Otherwise fall back to pi-core's default: current model
   * first, then by provider.
   */
  private sortModels(models: ModelItem[]): ModelItem[] {
    if (hasUsageData(this.lastUsed)) {
      return sortByLastUsed(models, this.lastUsed, currentModelKey(this.currentModel));
    }

    const sorted = [...models];
    sorted.sort((a, b) => {
      const aIsCurrent = modelsAreEqual(this.currentModel, a.model);
      const bIsCurrent = modelsAreEqual(this.currentModel, b.model);
      if (aIsCurrent && !bIsCurrent) return -1;
      if (!aIsCurrent && bIsCurrent) return 1;
      return a.provider.localeCompare(b.provider);
    });
    return sorted;
  }

  private getScopeText(): string {
    const allText =
      this.scope === 'all' ? this.theme.fg('accent', 'all') : this.theme.fg('muted', 'all');
    const scopedText =
      this.scope === 'scoped'
        ? this.theme.fg('accent', 'scoped')
        : this.theme.fg('muted', 'scoped');
    return `${this.theme.fg('muted', 'Scope: ')}${allText}${this.theme.fg('muted', ' | ')}${scopedText}`;
  }

  private getScopeHintText(): string {
    return keyHint('tui.input.tab', 'scope') + this.theme.fg('muted', ' (all/scoped)');
  }

  private setScope(scope: 'all' | 'scoped'): void {
    if (this.scope === scope) return;
    this.scope = scope;
    this.activeModels = this.scope === 'scoped' ? this.scopedModelItems : this.allModels;
    const currentIndex = this.activeModels.findIndex((item) =>
      modelsAreEqual(this.currentModel, item.model)
    );
    this.selectedIndex = currentIndex >= 0 ? currentIndex : 0;
    this.filterModels(this.searchInput.getValue());
    if (this.scopeText) {
      this.scopeText.setText(this.getScopeText());
    }
  }

  /**
   * Filter the active model list by search query. After fuzzyFilter reorders
   * results by match quality, re-apply the last-used sort (mirroring
   * pi-model-sort's filterModels patch) so typing doesn't discard the
   * usage-based order. Re-syncs the cursor onto the current model.
   */
  private filterModels(query: string): void {
    this.filteredModels = query
      ? fuzzyFilter(this.activeModels, query, ({ id, provider, model }) =>
          getModelSelectorSearchText({ id, provider, name: model.name })
        )
      : this.activeModels;

    if (query && hasUsageData(this.lastUsed) && this.filteredModels.length > 1) {
      this.filteredModels = sortByLastUsed(
        this.filteredModels,
        this.lastUsed,
        currentModelKey(this.currentModel)
      );
      const ck = currentModelKey(this.currentModel);
      if (ck) {
        const newIndex = this.filteredModels.findIndex(
          (item) => buildModelKey(item.provider, item.id) === ck
        );
        if (newIndex >= 0) {
          this.selectedIndex = newIndex;
        }
      }
    }

    this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.filteredModels.length - 1));
    this.updateList();
  }

  private updateList(): void {
    this.listContainer.clear();
    const maxVisible = 10;
    const startIndex = Math.max(
      0,
      Math.min(
        this.selectedIndex - Math.floor(maxVisible / 2),
        this.filteredModels.length - maxVisible
      )
    );
    const endIndex = Math.min(startIndex + maxVisible, this.filteredModels.length);

    for (let i = startIndex; i < endIndex; i++) {
      const item = this.filteredModels[i];
      if (!item) continue;
      const isSelected = i === this.selectedIndex;
      const isCurrent = modelsAreEqual(this.currentModel, item.model);
      let line: string;
      if (isSelected) {
        const prefix = this.theme.fg('accent', '→ ');
        const modelText = `${item.id}`;
        const providerBadge = this.theme.fg('muted', `[${item.provider}]`);
        const checkmark = isCurrent ? this.theme.fg('success', ' ✓') : '';
        line = `${prefix + this.theme.fg('accent', modelText)} ${providerBadge}${checkmark}`;
      } else {
        const modelText = `  ${item.id}`;
        const providerBadge = this.theme.fg('muted', `[${item.provider}]`);
        const checkmark = isCurrent ? this.theme.fg('success', ' ✓') : '';
        line = `${modelText} ${providerBadge}${checkmark}`;
      }
      this.listContainer.addChild(new Text(line, 0, 0));
    }

    // Scroll indicator when the list is longer than the viewport
    if (startIndex > 0 || endIndex < this.filteredModels.length) {
      this.listContainer.addChild(
        new Text(
          this.theme.fg('muted', `  (${this.selectedIndex + 1}/${this.filteredModels.length})`),
          0,
          0
        )
      );
    }

    // Error / empty state, otherwise the selected model's name line
    if (this.errorMessage) {
      const errorLines = this.errorMessage.split('\n');
      for (const line of errorLines) {
        this.listContainer.addChild(new Text(this.theme.fg('error', line), 0, 0));
      }
    } else if (this.filteredModels.length === 0) {
      this.listContainer.addChild(new Text(this.theme.fg('muted', '  No matching models'), 0, 0));
    } else {
      const selected = this.filteredModels[this.selectedIndex];
      this.listContainer.addChild(new Spacer(1));
      this.listContainer.addChild(
        new Text(this.theme.fg('muted', `  Model Name: ${selected.model.name}`), 0, 0)
      );
    }
  }

  handleInput(data: string): void {
    const kb = getKeybindings();

    // Tab — toggle all/scoped scope (only when scoped models exist)
    if (kb.matches(data, 'tui.input.tab')) {
      if (this.scopedModelItems.length > 0) {
        const nextScope = this.scope === 'all' ? 'scoped' : 'all';
        this.setScope(nextScope);
        if (this.scopeHintText) {
          this.scopeHintText.setText(this.getScopeHintText());
        }
      }
      return;
    }

    // Up — wrap to bottom
    if (kb.matches(data, 'tui.select.up')) {
      if (this.filteredModels.length === 0) return;
      this.selectedIndex =
        this.selectedIndex === 0 ? this.filteredModels.length - 1 : this.selectedIndex - 1;
      this.updateList();
      return;
    }

    // Down — wrap to top
    if (kb.matches(data, 'tui.select.down')) {
      if (this.filteredModels.length === 0) return;
      this.selectedIndex =
        this.selectedIndex === this.filteredModels.length - 1 ? 0 : this.selectedIndex + 1;
      this.updateList();
      return;
    }

    // Enter — select highlighted model
    if (kb.matches(data, 'tui.select.confirm')) {
      const selectedModel = this.filteredModels[this.selectedIndex];
      if (selectedModel) {
        this.handleSelect(selectedModel.model);
      }
      return;
    }

    // Escape / Ctrl+C — cancel
    if (kb.matches(data, 'tui.select.cancel')) {
      this.onCancel();
      return;
    }

    // Everything else goes to the search input
    this.searchInput.handleInput(data);
    this.filterModels(this.searchInput.getValue());
  }

  private handleSelect(model: Model<any>): void {
    // Unlike pi-core, do NOT write the user's global default model — the
    // supervisor picks its own model. The caller persists the choice.
    this.onSelect(model);
  }

  getSearchInput(): Input {
    return this.searchInput;
  }
}
