/**
 * global-config.ts — workspace-level supervisor configuration.
 *
 * Saves/loads supervisor model selection.
 * Stored at <cwd>/.pi/supervisor-config.json
 *
 * Removed: sensitivity (now automatic)
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
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

/** Save the supervisor model config to cwd/.pi/supervisor-config.json. */
export function saveGlobalModel(provider: string, modelId: string): void {
  const configDir = join(process.cwd(), CONFIG_DIR);
  const configPath = join(configDir, CONFIG_FILE);

  let existing: SupervisorConfig = {};
  if (existsSync(configPath)) {
    try {
      existing = JSON.parse(readFileSync(configPath, 'utf-8')) as SupervisorConfig;
    } catch {
      // ignore parse errors
    }
  }

  existing.model = { provider, modelId };

  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true });
  }
  writeFileSync(configPath, JSON.stringify(existing, null, 2), 'utf-8');
}

/** Clear the supervisor config file. */
export function clearGlobalConfig(): void {
  const configPath = join(process.cwd(), CONFIG_DIR, CONFIG_FILE);
  if (existsSync(configPath)) {
    try {
      const content = readFileSync(configPath, 'utf-8');
      const parsed = JSON.parse(content) as SupervisorConfig;
      delete parsed.model;
      writeFileSync(configPath, JSON.stringify(parsed, null, 2), 'utf-8');
    } catch {
      // ignore errors
    }
  }
}
