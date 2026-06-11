import { readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import {
  getAgentsRoot,
  getAgentDir,
  ensureDir,
  dirExists,
  fileExists,
  readJson,
  writeJson,
  removeDir,
  listDirs,
} from "../utils/fs.js";

export interface AgentConfig {
  name: string;
  createdAt: string;
  status: "idle" | "active";
  walletAddress?: string;
  /** Max USD notional this agent may stake on a single auto-trade. 0 = disabled. */
  spendingCapUsd?: number;
  /** Id of the strategy assigned to this agent (builtin or user-saved). */
  strategyId?: string;
}

const NAME_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9-]*$/;

export function validateAgentName(name: string): string | null {
  if (!name) return "Agent name is required.";
  if (name.length > 64) return "Agent name must be 64 characters or fewer.";
  if (!NAME_REGEX.test(name))
    return 'Agent name must be alphanumeric (hyphens allowed, cannot start with hyphen).';
  return null;
}

export async function createAgent(name: string): Promise<AgentConfig> {
  const root = getAgentsRoot();
  await ensureDir(root);

  const dir = getAgentDir(name);
  if (await dirExists(dir)) {
    throw new Error(`Agent "${name}" already exists.`);
  }

  await ensureDir(dir);

  const config: AgentConfig = {
    name,
    createdAt: new Date().toISOString(),
    status: "idle",
    strategyId: "always-notr",
  };

  await writeJson(join(dir, "config.json"), config);

  return config;
}

export async function listAgents(): Promise<AgentConfig[]> {
  const root = getAgentsRoot();
  if (!(await dirExists(root))) return [];

  const dirs = await listDirs(root);
  const agents: AgentConfig[] = [];

  for (const dirName of dirs) {
    const configPath = join(getAgentDir(dirName), "config.json");
    if (await fileExists(configPath)) {
      try {
        const config = await readJson<AgentConfig>(configPath);
        agents.push(config);
      } catch {
        // skip malformed configs
      }
    }
  }

  return agents;
}

export async function getAgent(name: string): Promise<AgentConfig> {
  const configPath = join(getAgentDir(name), "config.json");
  if (!(await fileExists(configPath))) {
    throw new Error(`Agent "${name}" not found.`);
  }
  return readJson<AgentConfig>(configPath);
}

export async function deleteAgent(name: string): Promise<void> {
  const dir = getAgentDir(name);
  if (!(await dirExists(dir))) {
    throw new Error(`Agent "${name}" not found.`);
  }
  await removeDir(dir);
}

export async function updateAgentConfig(name: string, updates: Partial<AgentConfig>): Promise<AgentConfig> {
  const config = await getAgent(name);
  const updated = { ...config, ...updates };
  await writeJson(join(getAgentDir(name), "config.json"), updated);
  return updated;
}

export function getStrategyPath(name: string): string {
  return join(getAgentDir(name), "strategy.md");
}

async function migrateLegacyTradeFile(name: string): Promise<void> {
  const newPath = getStrategyPath(name);
  if (await fileExists(newPath)) return;
  const legacyPath = join(getAgentDir(name), "trade.md");
  if (await fileExists(legacyPath)) {
    await rename(legacyPath, newPath);
  }
}

export async function ensureStrategyFile(name: string): Promise<string> {
  await migrateLegacyTradeFile(name);
  return getStrategyPath(name);
}

export async function readStrategy(name: string): Promise<string | null> {
  await migrateLegacyTradeFile(name);
  const path = getStrategyPath(name);
  if (!(await fileExists(path))) return null;
  const raw = await readFile(path, "utf-8");
  const trimmed = raw.trim();
  return trimmed.length > 0 ? raw : null;
}
