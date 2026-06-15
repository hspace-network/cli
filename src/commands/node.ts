import chalk from "chalk";
import { log } from "../utils/logger.js";
import {
  loadCliConfig,
  setNodeUrl,
  fetchNodeConfig,
  getCachedNodeConfig,
  setCachedNodeConfig,
} from "../services/config.service.js";

export async function nodeCommand(args: string[]): Promise<string[]> {
  const sub = (args[0] ?? "").toLowerCase();

  if (!sub) {
    return showStatus();
  }

  if (sub === "set") {
    const url = args[1];
    if (!url) {
      return [
        log.blank(),
        log.error("Usage: node set <url>"),
        log.dim("  Example: node set http://localhost:6161"),
        log.blank(),
      ];
    }
    return setAndConnect(url);
  }

  return [
    log.blank(),
    log.error(`Unknown subcommand: "${sub}"`),
    log.dim("  Try: node | node set <url>"),
    log.blank(),
  ];
}

async function showStatus(): Promise<string[]> {
  const cfg = await loadCliConfig();
  const cached = getCachedNodeConfig();

  const lines: string[] = [log.blank(), log.heading("  Node")];
  lines.push(log.blank());
  lines.push(log.raw(`  ${chalk.cyan("URL:".padEnd(10))}${cfg.nodeUrl}`));

  if (cached) {
    lines.push(
      log.raw(`  ${chalk.cyan("Status:".padEnd(10))}${chalk.green("connected")}`)
    );
    lines.push(log.raw(`  ${chalk.cyan("Version:".padEnd(10))}${cached.version}`));
    lines.push(log.raw(`  ${chalk.cyan("Rooms:".padEnd(10))}${cached.rooms.length}`));
  } else {
    lines.push(
      log.raw(`  ${chalk.cyan("Status:".padEnd(10))}${chalk.yellow("offline")}`)
    );
    lines.push(log.dim('  Run "node set <url>" to connect to a node.'));
  }

  lines.push(log.blank());
  return lines;
}

async function setAndConnect(url: string): Promise<string[]> {
  const lines: string[] = [log.blank()];

  let savedUrl: string;
  try {
    const next = await setNodeUrl(url);
    savedUrl = next.nodeUrl;
    lines.push(log.success(`Node URL set to ${savedUrl}`));
  } catch (err) {
    lines.push(log.error((err as Error).message));
    lines.push(log.blank());
    return lines;
  }

  try {
    const fetched = await fetchNodeConfig(savedUrl);
    setCachedNodeConfig(fetched);
    lines.push(
      log.success(
        `Connected. Loaded ${fetched.rooms.length} room${fetched.rooms.length === 1 ? "" : "s"} (node v${fetched.version}).`
      )
    );
  } catch (err) {
    setCachedNodeConfig(null);
    lines.push(log.warn((err as Error).message));
  }

  lines.push(log.blank());
  return lines;
}

