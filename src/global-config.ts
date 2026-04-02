/**
 * global-config.ts — workspace-level supervisor configuration.
 *
 * Saves/loads supervisor model selection.
 * Stored at <cwd>/.pi/supervisor-config.json
 *
 * Removed: sensitivity (now automatic)
 */

import { existsSync, readFileSync } from 'node:fs';
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
