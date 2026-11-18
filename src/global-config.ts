/**
 * global-config.ts — workspace-level supervisor configuration.
 *
 * Saves/loads supervisor model selection.
 * Stored at <cwd>/.pi/supervisor-config.json
 *
 * Removed: sensitivity (now automatic)
 */

import { join } from 'node:path';
import { readJsonConfig, updateJsonConfig } from './config-file.js';

const CONFIG_DIR = '.pi';
const CONFIG_FILE = 'supervisor-config.json';

interface SupervisorModel {
  provider: string;
  modelId: string;
}

function parseModel(model: unknown): SupervisorModel | undefined {
  if (
    model &&
    typeof model === 'object' &&
    'provider' in model &&
    typeof model.provider === 'string' &&
    model.provider &&
    'modelId' in model &&
    typeof model.modelId === 'string' &&
    model.modelId
  ) {
    return { provider: model.provider, modelId: model.modelId };
  }
}

/** Load the supervisor model config from cwd/.pi/supervisor-config.json if it exists. */
export function loadGlobalModel(): SupervisorModel | null {
  const configPath = join(process.cwd(), CONFIG_DIR, CONFIG_FILE);
  try {
    return parseModel(readJsonConfig(configPath)?.model) ?? null;
  } catch {
    return null;
  }
}

/**
 * Save the supervisor model config to <cwd>/.pi/supervisor-config.json,
 * preserving any other keys already present. Creates the .pi directory if
 * missing. Throws instead of overwriting invalid config. Returns the config path.
 */
export function saveGlobalModel(cwd: string, model: SupervisorModel): string {
  const configPath = join(cwd, CONFIG_DIR, CONFIG_FILE);
  updateJsonConfig(configPath, (existing) => {
    if (existing && 'model' in existing && !parseModel(existing.model)) {
      throw new Error(`Invalid model in ${configPath}`);
    }
    return { ...existing, model };
  });
  return configPath;
}
