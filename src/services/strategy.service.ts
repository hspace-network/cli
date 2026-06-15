import { readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import {
  ensureDir,
  fileExists,
  readJson,
  writeJson,
  writeText,
  getStrategiesDir,
  getStrategyIndexPath,
  getUserStrategyPath,
  getAgentDir,
} from "../utils/fs.js";
import { getCachedNodeConfig } from "./config.service.js";
import { getAgent, listAgents, updateAgentConfig } from "./agent.service.js";

export interface UserStrategyMeta {
  id: string;
  label: string;
  forkedFrom?: string;
}

export interface StrategyEntry {
  id: string;
  label: string;
  body: string;
  source: "builtin" | "user";
}

interface StrategyIndex {
  strategies: UserStrategyMeta[];
}

async function readIndex(): Promise<StrategyIndex> {
  const path = getStrategyIndexPath();
  if (!(await fileExists(path))) return { strategies: [] };
  try {
    const data = await readJson<StrategyIndex>(path);
    return { strategies: Array.isArray(data.strategies) ? data.strategies : [] };
  } catch {
    return { strategies: [] };
  }
}

async function writeIndex(index: StrategyIndex): Promise<void> {
  await ensureDir(getStrategiesDir());
  await writeJson(getStrategyIndexPath(), index);
}

export async function listUserStrategyMeta(): Promise<UserStrategyMeta[]> {
  return (await readIndex()).strategies;
}

export function getBuiltinStrategies(): StrategyEntry[] {
  const builtins = getCachedNodeConfig()?.strategies ?? [];
  return builtins.map((s) => ({
    id: s.id,
    label: s.label ?? s.id,
    body: s.body,
    source: "builtin" as const,
  }));
}

export async function listAllStrategies(): Promise<StrategyEntry[]> {
  const builtins = getBuiltinStrategies();
  const index = await readIndex();
  const user: StrategyEntry[] = [];
  for (const meta of index.strategies) {
    const path = getUserStrategyPath(meta.id);
    if (!(await fileExists(path))) continue;
    const body = await readFile(path, "utf-8");
    user.push({
      id: meta.id,
      label: meta.label,
      body,
      source: "user",
    });
  }
  return [...builtins, ...user];
}

export async function strategyExists(id: string): Promise<boolean> {
  const builtins = getCachedNodeConfig()?.strategies ?? [];
  if (builtins.some((s) => s.id === id)) return true;
  const index = await readIndex();
  return index.strategies.some((s) => s.id === id);
}

export async function getStrategyLabel(id: string): Promise<string> {
  const builtin = getCachedNodeConfig()?.strategies?.find((s) => s.id === id);
  if (builtin) return builtin.label ?? builtin.id;
  const index = await readIndex();
  const user = index.strategies.find((s) => s.id === id);
  return user?.label ?? id;
}

export async function resolveStrategyBody(id: string): Promise<string | null> {
  const builtin = getCachedNodeConfig()?.strategies?.find((s) => s.id === id);
  if (builtin) return builtin.body;

  const path = getUserStrategyPath(id);
  if (!(await fileExists(path))) return null;
  const raw = await readFile(path, "utf-8");
  const trimmed = raw.trim();
  return trimmed.length > 0 ? raw : null;
}

async function migrateLegacyAgentStrategy(agentName: string): Promise<string | null> {
  const legacyPath = join(getAgentDir(agentName), "strategy.md");
  if (!(await fileExists(legacyPath))) return null;

  const raw = await readFile(legacyPath, "utf-8");
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;

  const id = `${agentName}-legacy`;
  const label = `${agentName} (legacy)`;
  await saveUserStrategy(id, label, raw);
  await updateAgentConfig(agentName, { strategyId: id });

  try {
    await unlink(legacyPath);
  } catch {
    // keep legacy file if delete fails
  }

  return raw;
}

export async function resolveStrategyForAgent(agentName: string): Promise<string | null> {
  const agent = await getAgent(agentName);

  if (!agent.strategyId) {
    return migrateLegacyAgentStrategy(agentName);
  }

  const body = await resolveStrategyBody(agent.strategyId);
  if (body) return body;

  return migrateLegacyAgentStrategy(agentName);
}

export async function saveUserStrategy(
  id: string,
  label: string,
  body: string,
  forkedFrom?: string,
): Promise<void> {
  await ensureDir(getStrategiesDir());
  await writeText(getUserStrategyPath(id), body.endsWith("\n") ? body : body + "\n");

  const index = await readIndex();
  const existing = index.strategies.find((s) => s.id === id);
  if (existing) {
    existing.label = label;
    if (forkedFrom) existing.forkedFrom = forkedFrom;
  } else {
    const meta: UserStrategyMeta = { id, label };
    if (forkedFrom) meta.forkedFrom = forkedFrom;
    index.strategies.push(meta);
  }
  await writeIndex(index);
}

function slugifyStrategyId(name: string): string {
  const slug = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return slug || "strategy";
}

/**
 * Rename a user strategy. Updates its display name, derives a fresh id from the
 * new name, moves the body file, and repoints any agents that used it. Builtin
 * strategies come from the node and cannot be renamed.
 */
export async function renameUserStrategy(
  oldId: string,
  newLabel: string,
): Promise<string> {
  const trimmed = newLabel.trim();
  if (!trimmed) {
    throw new Error("Strategy name cannot be empty.");
  }

  const index = await readIndex();
  const meta = index.strategies.find((s) => s.id === oldId);
  if (!meta) {
    throw new Error(
      `"${oldId}" is a builtin strategy and cannot be renamed. Edit it to save your own copy first.`,
    );
  }

  let newId = slugifyStrategyId(trimmed);
  if (newId !== oldId) {
    const base = newId;
    let n = 2;
    while (await strategyExists(newId)) {
      newId = `${base}-${n}`;
      n += 1;
    }

    const oldPath = getUserStrategyPath(oldId);
    const newPath = getUserStrategyPath(newId);
    if (await fileExists(oldPath)) {
      await rename(oldPath, newPath);
    }

    const agents = await listAgents();
    for (const agent of agents) {
      if (agent.strategyId === oldId) {
        await updateAgentConfig(agent.name, { strategyId: newId });
      }
    }
  }

  meta.id = newId;
  meta.label = trimmed;
  await writeIndex(index);
  return newId;
}

export async function setAgentStrategy(
  agentName: string,
  strategyId: string,
): Promise<void> {
  if (!(await strategyExists(strategyId))) {
    throw new Error(`Strategy "${strategyId}" not found. Run "strategy" to list available strategies.`);
  }
  await updateAgentConfig(agentName, { strategyId });
}

export async function forkBuiltinStrategy(
  builtinId: string,
  content: string,
): Promise<string> {
  const builtin = getCachedNodeConfig()?.strategies?.find((s) => s.id === builtinId);
  if (!builtin) {
    throw new Error(`Builtin strategy "${builtinId}" not found.`);
  }

  let newId = `${builtinId}-custom`;
  let n = 2;
  while (await strategyExists(newId)) {
    newId = `${builtinId}-custom-${n}`;
    n += 1;
  }

  const label = `${builtin.label ?? builtinId} (custom)`;
  await saveUserStrategy(newId, label, content, builtinId);
  return newId;
}

export async function prepareStrategyEdit(
  entry: StrategyEntry,
): Promise<{ filePath: string; fileName: string; isBuiltin: boolean; builtinId?: string }> {
  await ensureDir(getStrategiesDir());

  if (entry.source === "user") {
    return {
      filePath: getUserStrategyPath(entry.id),
      fileName: `strategies/${entry.id}.md`,
      isBuiltin: false,
    };
  }

  const draftPath = join(getStrategiesDir(), `.draft-${entry.id}.md`);
  await writeText(draftPath, entry.body.endsWith("\n") ? entry.body : entry.body + "\n");
  return {
    filePath: draftPath,
    fileName: `${entry.label} (builtin)`,
    isBuiltin: true,
    builtinId: entry.id,
  };
}

export async function cleanupStrategyDraft(builtinId: string): Promise<void> {
  const draftPath = join(getStrategiesDir(), `.draft-${builtinId}.md`);
  try {
    await unlink(draftPath);
  } catch {
    // ignore
  }
}
