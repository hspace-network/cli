/**
 * Agent decision memory.
 *
 * Each agent appends a record per discussion session to history.jsonl (see
 * writeHistory in discussion.client). The vote path never read it back, so an
 * agent had no recollection of what it decided last time or how that trade
 * turned out. `readAgentMemory` returns a compact, same-market recap of the
 * agent's own recent decisions + outcomes for injection into its next prompt.
 */
import { readFile } from "node:fs/promises";
import { getAgentHistoryPath, fileExists } from "../utils/fs.js";

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
  final?: VotePart;
  action?: { type: string; ok: boolean; message: string };
}

function roomOf(rec: HistoryRecord): string {
  return rec.roomId ?? `${rec.market ?? "?"}:${rec.interval ?? "?"}`;
}

function formatWhen(iso: string | undefined): string {
  if (!iso) return "?";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().slice(0, 16).replace("T", " ");
}

function truncate(s: string, max: number): string {
  const t = s.trim();
  return t.length > max ? t.slice(0, max) + "…" : t;
}

/**
 * Compact recap of this agent's own recent decisions in the SAME room/market,
 * newest last, with the trade outcome when known. Returns undefined when there
 * is nothing relevant to recall.
 */
export async function readAgentMemory(
  agentName: string,
  roomId: string,
  opts: { limit?: number } = {},
): Promise<string | undefined> {
  const limit = Math.max(1, opts.limit ?? 5);
  const path = getAgentHistoryPath(agentName);
  if (!(await fileExists(path))) return undefined;

  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch {
    return undefined;
  }

  // Each session is written more than once (pending action, then final). Keep
  // the last write per sessionId while preserving first-seen (chronological)
  // order, then keep only records for this room.
  const bySession = new Map<string, HistoryRecord>();
  const order: string[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let rec: HistoryRecord;
    try {
      rec = JSON.parse(trimmed) as HistoryRecord;
    } catch {
      continue;
    }
    if (roomOf(rec) !== roomId) continue;
    const key = rec.sessionId ?? rec.startedAt ?? trimmed;
    if (!bySession.has(key)) order.push(key);
    bySession.set(key, rec);
  }

  if (order.length === 0) return undefined;

  const recent = order
    .slice(-limit)
    .map((k) => bySession.get(k))
    .filter((r): r is HistoryRecord => Boolean(r));

  const lines: string[] = [];
  for (const rec of recent) {
    const decision = rec.final ?? rec.initial;
    const way = (decision?.way ?? "NOTR").toUpperCase();
    const size =
      decision?.sizeUsd && way !== "NOTR" ? ` ~$${decision.sizeUsd}` : "";
    const rationale = decision?.rationale ? ` — ${truncate(decision.rationale, 160)}` : "";
    const outcome = rec.action?.message ? ` → ${truncate(rec.action.message, 120)}` : "";
    lines.push(`- ${formatWhen(rec.startedAt)}: ${way}${size}${rationale}${outcome}`);
  }

  return lines.length > 0 ? lines.join("\n") : undefined;
}
