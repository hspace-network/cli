import chalk from "chalk";
import { getAgent } from "../services/agent.service.js";
import {
  getActiveAgent,
  setActiveAgent,
  clearActiveAgent,
} from "../services/active-agent.service.js";
import { log } from "../utils/logger.js";

export async function useCommand(args: string[]): Promise<string[]> {
  const name = args[0];

  if (!name) {
    const current = getActiveAgent();
    if (!current) {
      return [
        log.dim("  No active agent."),
        log.dim('  Run "use <agent>" to set one.'),
      ];
    }
    return [log.info(`Active agent: ${chalk.cyanBright.bold(current)}`)];
  }

  try {
    await getAgent(name);
  } catch (err) {
    return [log.error((err as Error).message)];
  }

  setActiveAgent(name);
  return [
    log.success(`Now using agent ${chalk.cyanBright.bold(name)}.`),
    log.dim('"unuse" to clear.'),
  ];
}

export async function unuseCommand(): Promise<string[]> {
  const current = getActiveAgent();
  if (!current) {
    return [log.dim("  No active agent to clear.")];
  }
  clearActiveAgent();
  return [log.success(`Cleared active agent (was ${chalk.cyanBright(current)}).`)];
}
