import chalk from "chalk";
import { getAgent, updateAgentConfig } from "../services/agent.service.js";
import { loadCliConfig } from "../services/config.service.js";
import { syncAgentLimits } from "../services/nodeAgent.service.js";
import { log } from "../utils/logger.js";

export async function capCommand(args: string[]): Promise<string[]> {
  const name = args[0];
  const valueArg = args[1];

  if (!name) {
    return [log.error("Usage: cap <agent> [usd]")];
  }

  let config;
  try {
    config = await getAgent(name);
  } catch (err) {
    return [log.error((err as Error).message)];
  }

  if (valueArg === undefined) {
    const cap = config.spendingCapUsd ?? 0;
    const label =
      cap > 0
        ? `${chalk.green(`$${cap}`)} per trade`
        : chalk.dim("disabled (auto-trade off)");
    return [log.raw(`  ${chalk.dim("Spending cap")}  ${label}`)];
  }

  const n = Number(valueArg);
  if (!Number.isFinite(n) || n < 0) {
    return [log.error(`Invalid amount "${valueArg}". Enter a non-negative number.`)];
  }

  try {
    await updateAgentConfig(name, { spendingCapUsd: n });
  } catch (err) {
    return [log.error((err as Error).message)];
  }

  try {
    const cfg = await loadCliConfig();
    await syncAgentLimits({ nodeUrl: cfg.nodeUrl, name, spendingCapUsd: n });
  } catch (err) {
    return [
      log.warn(`Local cap saved but node sync failed: ${(err as Error).message}`),
    ];
  }

  if (n === 0) {
    return [
      log.success(
        `Spending cap for ${chalk.cyanBright(name)} cleared — auto-trade disabled.`,
      ),
    ];
  }
  return [
    log.success(
      `Spending cap for ${chalk.cyanBright(name)} set to ${chalk.green(`$${n}`)} per trade.`,
    ),
  ];
}
