import chalk from "chalk";
import { getAgent } from "../services/agent.service.js";
import { getStrategyLabel } from "../services/strategy.service.js";
import { walletExists } from "../services/wallet.service.js";
import { loadCliConfig } from "../services/config.service.js";
import { fetchRunsForAgent } from "../services/runs.service.js";
import { fetchAgentScore } from "../services/score.service.js";
import { setAgentRooms, isRunning } from "../services/runs.cache.js";
import { log } from "../utils/logger.js";

export async function infoCommand(args: string[]): Promise<string[]> {
  const name = args[0];
  if (!name) {
    return [log.error("Usage: info <name>")];
  }

  let config;
  try {
    config = await getAgent(name);
  } catch (err) {
    return [log.error((err as Error).message)];
  }

  let activeRooms: string[] | null = null;
  if (await walletExists(name)) {
    try {
      const cfg = await loadCliConfig();
      activeRooms = await fetchRunsForAgent({
        nodeUrl: cfg.nodeUrl,
        agentName: name,
      });
      setAgentRooms(name, activeRooms);
    } catch {
      activeRooms = null;
    }
  }

  const running = activeRooms !== null ? activeRooms.length > 0 : isRunning(name);
  const statusLabel = running ? "running" : "idle";
  const statusColor = running ? chalk.green : chalk.cyan;

  const lines = [
    log.blank(),
    log.raw(`  ${chalk.cyan("[o_o]")}  ${chalk.cyanBright.bold(config.name)}`),
    log.blank(),
    log.raw(`  ${chalk.dim("Status")}        ${statusColor(statusLabel)}`),
    log.raw(`  ${chalk.dim("Created")}       ${chalk.white(config.createdAt.split("T")[0])}`),
    log.raw(`  ${chalk.dim("Full TS")}       ${chalk.dim(config.createdAt)}`),
  ];

  if (config.walletAddress) {
    lines.push(log.raw(`  ${chalk.dim("Wallet")}        ${chalk.white(config.walletAddress)}`));
  } else {
    lines.push(log.raw(`  ${chalk.dim("Wallet")}        ${chalk.dim("none")}`));
  }

  const cap = config.spendingCapUsd ?? 0;
  const capLabel =
    cap > 0 ? chalk.green(`$${cap} per trade`) : chalk.dim("disabled");
  lines.push(log.raw(`  ${chalk.dim("Spending cap")}  ${capLabel}`));

  if (config.strategyId) {
    const label = await getStrategyLabel(config.strategyId);
    lines.push(
      log.raw(
        `  ${chalk.dim("Strategy")}       ${chalk.green(config.strategyId)} ${chalk.dim(`(${label})`)}`,
      ),
    );
  } else {
    lines.push(log.raw(`  ${chalk.dim("Strategy")}       ${chalk.dim("none")}`));
  }

  if (await walletExists(name)) {
    try {
      const cfg = await loadCliConfig();
      const scoreRes = await fetchAgentScore({ nodeUrl: cfg.nodeUrl, agentName: name });
      if (scoreRes) {
        const pct = (scoreRes.score * 100).toFixed(1);
        lines.push(
          log.raw(`  ${chalk.dim("Score")}          ${chalk.green(scoreRes.score.toFixed(3))} ${chalk.dim(`(${pct}%)`)}`),
        );
      } else {
        lines.push(log.raw(`  ${chalk.dim("Score")}          ${chalk.dim("not on node")}`));
      }
    } catch {
      lines.push(log.raw(`  ${chalk.dim("Score")}          ${chalk.dim("(node unreachable)")}`));
    }
  }

  if (activeRooms === null) {
    lines.push(
      log.raw(
        `  ${chalk.dim("Active rooms")}  ${chalk.dim("(node unreachable)")}`,
      ),
    );
  } else if (activeRooms.length === 0) {
    lines.push(
      log.raw(`  ${chalk.dim("Active rooms")}  ${chalk.dim("none")}`),
    );
  } else {
    lines.push(
      log.raw(
        `  ${chalk.dim("Active rooms")}  ${chalk.green(activeRooms.join(", "))}`,
      ),
    );
  }

  lines.push(log.blank());
  return lines;
}
