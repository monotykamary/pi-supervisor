/**
 * global-config.ts — workspace-level supervisor configuration.
 *
 * Saves/loads supervisor model selection.
 * Stored at <cwd>/.pi/supervisor-config.json
 *
 * Removed: sensitivity (now automatic)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const CONFIG_DIR = '.pi';
const CONFIG_FILE = 'supervisor-config.json';

interface SupervisorConfig {
  model?: {
    provider: string;
    modelId: string;
  };
}

/** Load the supervisor model config from cwd/.pi/supervisor-config.json if it exists. */
export function loadGlobalModel(): { provider: string; modelId: string } | null {
  const configPath = join(process.cwd(), CONFIG_DIR, CONFIG_FILE);
  if (!existsSync(configPath)) return null;

  try {
    const content = readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(content) as SupervisorConfig;
    if (parsed.model?.provider && parsed.model?.modelId) {
      return { provider: parsed.model.provider, modelId: parsed.model.modelId };
    }
  } catch {
    // ignore parse errors
  }
  return null;
}

/**
 * Save the supervisor model config to <cwd>/.pi/supervisor-config.json,
 * preserving any other keys already present. Creates the .pi directory if
 * missing. Returns the written config path.
 */
export function saveGlobalModel(cwd: string, model: { provider: string; modelId: string }): string {
  const dir = join(cwd, CONFIG_DIR);
  const configPath = join(dir, CONFIG_FILE);

  let existing: SupervisorConfig = {};
  if (existsSync(configPath)) {
    try {
      existing = JSON.parse(readFileSync(configPath, 'utf-8')) as SupervisorConfig;
    } catch {
      // ignore parse errors — start fresh
    }
  }

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const merged: SupervisorConfig = { ...existing, model };
  writeFileSync(configPath, JSON.stringify(merged, null, 2) + '\n', 'utf-8');
  return configPath;
}
