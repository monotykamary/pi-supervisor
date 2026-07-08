/**
 * model-sort.ts — integration with the pi-model-sort extension.
 *
 * The supervisor's model picker copies pi-core's /model selector. To "work
 * together with" pi-model-sort (which monkey-patches pi-core's selector to
 * sort by last usage), we read pi-model-sort's persisted timestamps and
 * re-apply the identical sort order here, so the supervisor picker lists
 * models in the user's actual usage order — matching what they see in pi's
 * own /model selector.
 *
 * Mirrors pi-model-sort's sortByLastUsed algorithm exactly:
 *   1. Current model first (if currentModelKey is provided)
 *   2. Most recently used (highest timestamp) first
 *   3. Provider name alphabetically
 *   4. Model id alphabetically
 *
 * When pi-model-sort isn't installed or has no recorded usage, callers
 * should fall back to pi-core's default provider sort.
 *
 * Config path: ~/.pi/agent/extensions/pi-model-sort.json (same file
 * pi-model-sort reads/writes — sharing it keeps both pickers in sync).
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getAgentDir } from '@earendil-works/pi-coding-agent';

const MODEL_SORT_CONFIG_PATH = join(getAgentDir(), 'extensions', 'pi-model-sort.json');

export interface LastUsedMap {
  /** Map of "provider/modelId" → last-used Unix timestamp (ms). */
  [providerModelKey: string]: number;
}

/** Build a stable model key from provider and model id (matches pi-model-sort). */
export function buildModelKey(provider: string, id: string): string {
  return `${provider}/${id}`;
}

/**
 * Read pi-model-sort's last-used timestamps from disk.
 * Returns null when pi-model-sort isn't installed, has no config, or the
 * config is unreadable — callers then fall back to the default sort.
 */
export function readModelSortLastUsed(): LastUsedMap | null {
  if (!existsSync(MODEL_SORT_CONFIG_PATH)) return null;
  try {
    const raw = readFileSync(MODEL_SORT_CONFIG_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as { lastUsed?: LastUsedMap };
    if (!parsed.lastUsed || typeof parsed.lastUsed !== 'object') return null;
    return parsed.lastUsed;
  } catch {
    return null;
  }
}

/**
 * Whether enough usage data exists to sort by last-used (vs. falling back to
 * the default provider sort). Exposed for tests and the selector.
 */
export function hasUsageData(lastUsed: LastUsedMap | null): lastUsed is LastUsedMap {
  return !!lastUsed && Object.keys(lastUsed).length > 0;
}

/**
 * Sort models by last-used recency — a faithful copy of pi-model-sort's
 * sortByLastUsed. Non-mutating.
 *
 * Sort order:
 *   1. Current model first (if currentModelKey is provided)
 *   2. Most recently used (highest timestamp) first
 *   3. Provider name alphabetically
 *   4. Model id alphabetically
 *
 * Models with no recorded usage get timestamp 0 (sorted last).
 */
export function sortByLastUsed<T extends { provider: string; id: string }>(
  items: T[],
  lastUsed: LastUsedMap,
  currentModelKey: string | null
): T[] {
  const sorted = [...items];
  sorted.sort((a, b) => {
    const aKey = buildModelKey(a.provider, a.id);
    const bKey = buildModelKey(b.provider, b.id);

    if (currentModelKey !== null) {
      const aIsCurrent = aKey === currentModelKey;
      const bIsCurrent = bKey === currentModelKey;
      if (aIsCurrent && !bIsCurrent) return -1;
      if (!aIsCurrent && bIsCurrent) return 1;
    }

    const aLast = lastUsed[aKey] ?? 0;
    const bLast = lastUsed[bKey] ?? 0;
    if (aLast !== bLast) return bLast - aLast;

    return a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id);
  });
  return sorted;
}
