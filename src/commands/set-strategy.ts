import chalk from "chalk";
import { getActiveAgent } from "../services/active-agent.service.js";
import { getAgent, listAgents } from "../services/agent.service.js";
import {
  setAgentStrategy,
  getStrategyLabel,
  strategyExists,
  listAllStrategies,
} from "../services/strategy.service.js";
import { log } from "../utils/logger.js";

async function availableStrategiesHint(): Promise<string[]> {
  try {
    const all = await listAllStrategies();
    if (all.length === 0) {
      return [log.dim("  No strategies found — connect to a node to load builtins.")];
    }
    return [log.dim(`  Available strategies: ${all.map((s) => s.id).join(", ")}`)];
  } catch {
    return [];
  }
}

async function assign(agentName: string, strategyId: string): Promise<string[]> {
  try {
    await getAgent(agentName);
  } catch (err) {
    return [log.error((err as Error).message)];
  }

  try {
    await setAgentStrategy(agentName, strategyId);
  } catch (err) {
    return [log.error((err as Error).message), ...(await availableStrategiesHint())];
  }

  const label = await getStrategyLabel(strategyId);
  return [
    log.success(
      `${chalk.cyanBright(agentName)} now uses strategy ${chalk.green(strategyId)} (${label}).`,
    ),
  ];
}

export async function setStrategyCommand(args: string[]): Promise<string[]> {
  const active = getActiveAgent();

  // Explicit two-arg form: set strategy <agent> <strategyName>
  if (args.length === 2) {
    return assign(args[0]!, args[1]!);
  }

  if (args.length > 2) {
    return [
      log.error("Too many arguments."),
      log.dim("  Usage: set strategy <agent> <strategyName>"),
      log.dim("     or: set strategy <strategyName>   (with an active agent)"),
    ];
  }

  if (args.length === 0) {
    return [
      log.error("Usage: set strategy <strategyName>   (with an active agent)"),
      log.dim("     or: set strategy <agent> <strategyName>"),
    ];
  }

  // Exactly one arg — disambiguate strategy name vs (mistakenly) an agent name.
  const arg = args[0]!;
  let isStrategy = false;
  let isAgent = false;
  try {
    isStrategy = await strategyExists(arg);
  } catch {
    isStrategy = false;
  }
  try {
    const agents = await listAgents();
    isAgent = agents.some((a) => a.name === arg);
  } catch {
    isAgent = false;
  }

  if (active) {
    if (isStrategy) {
      return assign(active, arg);
    }
    if (isAgent) {
      return [
        log.error(`"${arg}" is an agent, not a strategy.`),
        log.dim(`  To set its strategy:        set strategy ${arg} <strategyName>`),
        log.dim(`  To set ${active}'s strategy:  set strategy <strategyName>`),
        ...(await availableStrategiesHint()),
      ];
    }
    return [
      log.error(`Strategy "${arg}" not found.`),
      ...(await availableStrategiesHint()),
    ];
  }

  // No active agent.
  if (isAgent) {
    return [
      log.error(`"${arg}" is an agent — a strategy name is also required.`),
      log.dim(`  Usage: set strategy ${arg} <strategyName>`),
      ...(await availableStrategiesHint()),
    ];
  }
  if (isStrategy) {
    return [
      log.error("No active agent."),
      log.dim(`  To assign "${arg}":  set strategy <agent> ${arg}`),
      log.dim(`  Or run   use <agent>   first, then   set strategy ${arg}`),
    ];
  }
  return [
    log.error("No active agent, and no matching strategy."),
    log.dim("  Usage: set strategy <agent> <strategyName>"),
    ...(await availableStrategiesHint()),
  ];
}
