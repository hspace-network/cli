import chalk from "chalk";
import { getActiveAgent } from "../services/active-agent.service.js";
import { getAgent } from "../services/agent.service.js";
import { setAgentStrategy, getStrategyLabel } from "../services/strategy.service.js";
import { log } from "../utils/logger.js";

export async function setStrategyCommand(args: string[]): Promise<string[]> {
  const active = getActiveAgent();

  let agentName: string | undefined;
  let strategyId: string | undefined;

  if (args.length === 1 && active) {
    agentName = active;
    strategyId = args[0];
  } else if (args.length === 2) {
    agentName = args[0];
    strategyId = args[1];
  } else if (!active) {
    return [
      log.error("Usage: set strategy <strategyName>   (with active agent)"),
      log.error("   or: set strategy <agent> <strategyName>"),
    ];
  } else {
    return [
      log.error("Usage: set strategy <strategyName>"),
      log.dim('  e.g. set strategy always-long'),
    ];
  }

  if (!agentName || !strategyId) {
    return [log.error("Agent name and strategy name are required.")];
  }

  try {
    await getAgent(agentName);
  } catch (err) {
    return [log.error((err as Error).message)];
  }

  try {
    await setAgentStrategy(agentName, strategyId);
  } catch (err) {
    return [log.error((err as Error).message)];
  }

  const label = await getStrategyLabel(strategyId);
  return [
    log.success(
      `${chalk.cyanBright(agentName)} now uses strategy ${chalk.green(strategyId)} (${label}).`,
    ),
  ];
}
