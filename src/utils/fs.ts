import { mkdir, readFile, writeFile, appendFile, rm, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const AGENTS_DIR = ".agents-cli";
const WALLETS_DIR = "wallets";

export function getAgentsRoot(): string {
  return join(homedir(), AGENTS_DIR);
}

export function getAgentDir(name: string): string {
  return join(getAgentsRoot(), name);
}

export function getAgentHistoryPath(name: string): string {
  return join(getAgentDir(name), "history.jsonl");
}

export function getWalletsDir(): string {
  return join(getAgentsRoot(), WALLETS_DIR);
}

export function getCliConfigPath(): string {
  return join(getAgentsRoot(), "config.json");
}

export function getStrategiesDir(): string {
  return join(getAgentsRoot(), "strategies");
}

export function getStrategyIndexPath(): string {
  return join(getStrategiesDir(), "index.json");
}

export function getUserStrategyPath(id: string): string {
  return join(getStrategiesDir(), `${id}.md`);
}

export function getWalletPath(name: string): string {
  return join(getWalletsDir(), `${name}.json`);
}

export function getAgentTokenPath(name: string): string {
  return join(getWalletsDir(), `${name}.token.json`);
}

export async function ensureDir(dirPath: string): Promise<void> {
  await mkdir(dirPath, { recursive: true });
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function dirExists(dirPath: string): Promise<boolean> {
  try {
    const s = await stat(dirPath);
    return s.isDirectory();
  } catch {
    return false;
  }
}

export async function readJson<T = unknown>(filePath: string): Promise<T> {
  const raw = await readFile(filePath, "utf-8");
  return JSON.parse(raw) as T;
}

export async function writeJson(filePath: string, data: unknown): Promise<void> {
  await writeFile(filePath, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

export async function writeText(filePath: string, content: string): Promise<void> {
  await writeFile(filePath, content, "utf-8");
}

export async function appendText(filePath: string, content: string): Promise<void> {
  await appendFile(filePath, content, "utf-8");
}

export async function removeDir(dirPath: string): Promise<void> {
  await rm(dirPath, { recursive: true, force: true });
}

export async function removeFile(filePath: string): Promise<void> {
  await rm(filePath, { force: true });
}

export async function listDirs(parentPath: string): Promise<string[]> {
  try {
    const entries = await readdir(parentPath, { withFileTypes: true });
    return entries.filter((e: { isDirectory(): boolean }) => e.isDirectory()).map((e: { name: string }) => e.name);
  } catch {
    return [];
  }
}
