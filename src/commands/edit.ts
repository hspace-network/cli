import { ensureStrategyFile, getAgent } from "../services/agent.service.js";
import { fileExists } from "../utils/fs.js";
import { log } from "../utils/logger.js";
import type { InteractiveResult } from "./index.js";

export async function editCommand(args: string[]): Promise<InteractiveResult> {
  const name = args[0];
  if (!name) {
    return { lines: [log.error("Usage: edit <name>")] };
  }

  try {
    await getAgent(name);
  } catch (err) {
    return { lines: [log.error((err as Error).message)] };
  }

  const strategyPath = await ensureStrategyFile(name);
  if (!(await fileExists(strategyPath))) {
    return { lines: [log.error(`strategy.md not found for agent "${name}".`)] };
  }

  return {
    lines: [log.dim(`\nOpening strategy.md for "${name}"...`)],
    openEditor: { filePath: strategyPath, fileName: `${name}/strategy.md` },
  };
}
