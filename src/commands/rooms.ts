import chalk from "chalk";
import { log } from "../utils/logger.js";
import { getCachedNodeConfig } from "../services/config.service.js";

export async function roomsCommand(): Promise<string[]> {
  const cached = getCachedNodeConfig();

  if (!cached) {
    return [
      log.blank(),
      log.warn("Not connected to a node."),
      log.dim('  Run "node set <url>" first.'),
      log.blank(),
    ];
  }

  if (cached.rooms.length === 0) {
    return [log.blank(), log.dim("  Node has no rooms configured."), log.blank()];
  }

  const lines: string[] = [log.blank(), log.heading("  Rooms")];
  lines.push(log.blank());

  const grouped = new Map<string, { name?: string; intervals: string[] }>();
  for (const room of cached.rooms) {
    const entry = grouped.get(room.market) ?? {
      name: undefined as string | undefined,
      intervals: [],
    };
    entry.intervals.push(room.interval);
    if (!entry.name && room.name) {
      const stripped = room.name.replace(/\s*\(.*\)$/, "").trim();
      entry.name = stripped.length > 0 ? stripped : undefined;
    }
    grouped.set(room.market, entry);
  }

  const marketCol = 12;
  for (const [marketId, entry] of grouped) {
    const intervals = entry.intervals.join(" ");
    const header =
      "  " +
      chalk.green(marketId.padEnd(marketCol)) +
      chalk.white(entry.name ?? "");
    lines.push(log.raw(header));
    lines.push(log.raw("    " + chalk.dim(intervals)));
  }

  lines.push(log.blank());
  lines.push(
    log.dim(
      `  ${cached.rooms.length} room${cached.rooms.length === 1 ? "" : "s"} (${grouped.size} market${grouped.size === 1 ? "" : "s"})`,
    ),
  );
  lines.push(log.blank());

  return lines;
}
