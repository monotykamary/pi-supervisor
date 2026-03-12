/**
 * Global supervisor config — persists settings to ~/.pi/agent/supervisor.json
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Sensitivity } from "./types.js";

const DEFAULT_AGENT_DIR = join(homedir(), ".pi", "agent");
const CONFIG_FILE = "supervisor.json";

export interface SupervisorConfig {
  provider?: string;
  modelId?: string;
  sensitivity?: Sensitivity;
}

/** Get the global agent directory (~/.pi/agent or PI_AGENT_DIR env override). */
export function getGlobalAgentDir(): string {
  return process.env.PI_AGENT_DIR ?? DEFAULT_AGENT_DIR;
}

function getConfigPath(): string {
  return join(getGlobalAgentDir(), CONFIG_FILE);
}

/** Load supervisor config from ~/.pi/agent/supervisor.json */
export function loadSupervisorConfig(): SupervisorConfig {
  const configPath = getConfigPath();
  if (!existsSync(configPath)) return {};
  try {
    const content = readFileSync(configPath, "utf-8");
    return JSON.parse(content) as SupervisorConfig;
  } catch {
    return {};
  }
}

/** Save supervisor config to ~/.pi/agent/supervisor.json */
export function saveSupervisorConfig(config: SupervisorConfig): boolean {
  const agentDir = getGlobalAgentDir();
  const configPath = getConfigPath();
  try {
    if (!existsSync(agentDir)) {
      mkdirSync(agentDir, { recursive: true });
    }
    const existing = loadSupervisorConfig();
    const merged = { ...existing, ...config };
    writeFileSync(configPath, JSON.stringify(merged, null, 2) + "\n", "utf-8");
    return true;
  } catch {
    return false;
  }
}

/** Load just the model config (provider + modelId) from global settings. */
export function loadGlobalModel(): { provider: string; modelId: string } | null {
  const config = loadSupervisorConfig();
  if (config.provider && config.modelId) {
    return { provider: config.provider, modelId: config.modelId };
  }
  return null;
}

/** Save just the model config to global settings. */
export function saveGlobalModel(provider: string, modelId: string): boolean {
  return saveSupervisorConfig({ provider, modelId });
}

/** Load sensitivity from global settings. */
export function loadGlobalSensitivity(): Sensitivity | null {
  const config = loadSupervisorConfig();
  return config.sensitivity ?? null;
}

/** Save sensitivity to global settings. */
export function saveGlobalSensitivity(sensitivity: Sensitivity): boolean {
  return saveSupervisorConfig({ sensitivity });
}
