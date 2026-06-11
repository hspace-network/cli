import chalk from "chalk";
import { readFile } from "node:fs/promises";
import { getAgent } from "../services/agent.service.js";
import { getAgentHistoryPath } from "../utils/fs.js";
import { fileExists } from "../utils/fs.js";
import { log } from "../utils/logger.js";

interface VotePart {
  way?: string;
  rationale?: string;
  sizeUsd?: number;
}

interface HistoryRecord {
  sessionId?: string;
  roomId?: string;
  market?: string;
  interval?: string;
  startedAt?: string;
  initial?: VotePart;
  turns?: { round: number; content: string }[];
  final?: VotePart;
  action?: { type: string; ok: boolean; message: string };
}

const MAX_ENTRIES = 10;

function wayColor(way: string | undefined): string {
  if (way === "LONG") return chalk.green.bold("LONG");
  if (way === "SHORT") return chalk.red.bold("SHORT");
  return chalk.dim("NOTR");
}

function formatTimestamp(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

export async function historyCommand(args: string[]): Promise<string[]> {
  const name = args[0];
  if (!name) {
    return [log.error("Usage: history <agent>")];
  }

  try {
    await getAgent(name);
  } catch (err) {
    return [log.error((err as Error).message)];
  }

  const path = getAgentHistoryPath(name);
  if (!(await fileExists(path))) {
    return [
      log.blank(),
      log.dim(`  No discussion history yet for ${chalk.cyanBright(name)}.`),
      log.dim("  Join a room with 2+ agents and let a session run."),
      log.blank(),
    ];
  }

  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch (err) {
    return [log.error(`Could not read history: ${(err as Error).message}`)];
  }

  const records: HistoryRecord[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed) as HistoryRecord);
    } catch {
      // skip malformed lines
    }
  }

  if (records.length === 0) {
    return [
      log.blank(),
      log.dim(`  No discussion history yet for ${chalk.cyanBright(name)}.`),
      log.blank(),
    ];
  }

  const recent = records.slice(-MAX_ENTRIES).reverse();

  const lines: string[] = [
    log.blank(),
    log.heading(`  Discussion history — ${name}`),
    log.dim(
      `  Showing ${recent.length} of ${records.length} session(s), newest first.`,
    ),
  ];

  for (const rec of recent) {
    const room = rec.roomId ?? `${rec.market ?? "?"}:${rec.interval ?? "?"}`;
    lines.push(log.blank());
    lines.push(
      `  ${chalk.cyanBright(room)}  ${chalk.dim(formatTimestamp(rec.startedAt))}`,
    );

    const final = rec.final;
    if (final) {
      const size =
        final.way !== "NOTR" && final.sizeUsd
          ? chalk.dim(` (~$${final.sizeUsd})`)
          : "";
      lines.push(`    ${chalk.dim("decision")}  ${wayColor(final.way)}${size}`);
      if (final.rationale && final.rationale.trim()) {
        lines.push(`    ${chalk.dim("reason")}    ${final.rationale.trim()}`);
      }
    }

    if (rec.action) {
      const marker = rec.action.ok ? chalk.green("✓") : chalk.yellow("!");
      lines.push(`    ${chalk.dim("action")}    ${marker} ${rec.action.message}`);
    }
  }

  lines.push(log.blank());
  return lines;
}
