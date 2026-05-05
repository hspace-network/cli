import chalk from "chalk";
import { listAgents } from "../services/agent.service.js";
import { isRunning } from "../services/runs.cache.js";
import { log } from "../utils/logger.js";

export async function listCommand(): Promise<string[]> {
  const agents = await listAgents();

  if (agents.length === 0) {
    return [
      log.blank(),
      log.dim('  No agents found. Use "create <name>" to create one.'),
      log.blank(),
    ];
  }

  const nameCol = 20;
  const statusCol = 12;
  const dateCol = 12;

  const lines: string[] = [log.blank()];

  lines.push(
    log.raw(
      "  " +
        chalk.cyan.bold("Name".padEnd(nameCol)) +
        chalk.cyan.bold("Status".padEnd(statusCol)) +
        chalk.cyan.bold("Created"),
    ),
  );
  lines.push(log.raw("  " + chalk.dim("-".repeat(nameCol + statusCol + dateCol))));

  for (const a of agents) {
    const running = isRunning(a.name);
    const statusLabel = running ? "running" : "idle";
    const statusBadge = running
      ? chalk.green(statusLabel)
      : chalk.cyan(statusLabel);
    const date = a.createdAt.split("T")[0];

    lines.push(
      log.raw(
        "  " +
          chalk.white(a.name.padEnd(nameCol)) +
          statusBadge.padEnd(statusCol + 10) +
          chalk.white(date),
      ),
    );
  }

  lines.push(log.blank());
  lines.push(
    log.dim(`  ${agents.length} agent${agents.length === 1 ? "" : "s"} total`),
  );
  lines.push(log.blank());

  return lines;
}
