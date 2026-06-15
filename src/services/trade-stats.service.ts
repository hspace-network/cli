import { join } from "node:path";
import { getAgentDir, ensureDir, readJson, writeJson, fileExists } from "../utils/fs.js";

interface TradeStats {
  date: string;
  count: number;
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function statsPath(agentName: string): string {
  return join(getAgentDir(agentName), "trade-stats.json");
}

export async function getTradeCountToday(agentName: string): Promise<number> {
  const path = statsPath(agentName);
  if (!(await fileExists(path))) return 0;
  try {
    const stats = await readJson<TradeStats>(path);
    return stats.date === todayUtc() ? stats.count : 0;
  } catch {
    return 0;
  }
}

export async function incrementTradeCount(agentName: string): Promise<number> {
  const path = statsPath(agentName);
  await ensureDir(getAgentDir(agentName));
  const day = todayUtc();
  let count = 1;
  if (await fileExists(path)) {
    try {
      const stats = await readJson<TradeStats>(path);
      count = stats.date === day ? stats.count + 1 : 1;
    } catch {
      count = 1;
    }
  }
  await writeJson(path, { date: day, count });
  return count;
}
