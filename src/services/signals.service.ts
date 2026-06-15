/**
 * Per-(agent, room) research signal store.
 *
 * The background research loop writes a structured signal here; the discussion
 * vote/turn path reads it and injects a compact summary into the prompt. Writes
 * are atomic (temp + rename) because a vote may read while a refresh is mid-flight,
 * and reads are freshness-checked so a stale signal never skews a new decision.
 */
import { writeFile, rename, readFile } from "node:fs/promises";
import { join } from "node:path";
import { ensureDir, fileExists } from "../utils/fs.js";
import { getSignalsDir } from "./sandbox.service.js";
import type { SandboxSignal } from "./tools.service.js";

export interface StoredSignal {
  roomId: string;
  signal: SandboxSignal;
  updatedAt: number;
}

function safeRoom(roomId: string): string {
  return roomId.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function signalPath(agent: string, roomId: string): string {
  return join(getSignalsDir(agent), `${safeRoom(roomId)}.json`);
}

/** Parse a room interval suffix (e.g. "BTCUSDT:1h") into milliseconds. */
export function intervalToMs(roomIdOrInterval: string): number {
  const interval = roomIdOrInterval.includes(":")
    ? roomIdOrInterval.split(":")[1] ?? ""
    : roomIdOrInterval;
  const match = /^(\d+)\s*([mhdw])$/i.exec(interval.trim());
  if (!match) return 60 * 60_000; // default 1h
  const n = Number(match[1]);
  const unit = match[2]!.toLowerCase();
  const unitMs =
    unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : unit === "d" ? 86_400_000 : 604_800_000;
  return n * unitMs;
}

export async function writeSignals(
  agent: string,
  roomId: string,
  signal: SandboxSignal,
): Promise<void> {
  const dir = getSignalsDir(agent);
  await ensureDir(dir);
  const payload: StoredSignal = { roomId, signal, updatedAt: Date.now() };
  const finalPath = signalPath(agent, roomId);
  const tmpPath = `${finalPath}.${Date.now()}.tmp`;
  await writeFile(tmpPath, JSON.stringify(payload), "utf-8");
  await rename(tmpPath, finalPath); // atomic on same filesystem
}

/**
 * Read the latest signal for a room. Returns null if missing or older than the
 * staleness window (1.5x the room interval, floored at 5 minutes).
 */
export async function readSignals(
  agent: string,
  roomId: string,
): Promise<StoredSignal | null> {
  const path = signalPath(agent, roomId);
  if (!(await fileExists(path))) return null;
  let parsed: StoredSignal;
  try {
    parsed = JSON.parse(await readFile(path, "utf-8")) as StoredSignal;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed.updatedAt !== "number") return null;
  const maxAge = Math.max(intervalToMs(roomId) * 1.5, 5 * 60_000);
  if (Date.now() - parsed.updatedAt > maxAge) return null;
  return parsed;
}

export function formatSignalsBlock(signal: SandboxSignal): string {
  const pct = Math.round((signal.confidence ?? 0) * 100);
  const lines = [`bias=${signal.bias} confidence=${pct}%`];
  if (signal.notes) lines.push(signal.notes.trim());
  if (signal.data !== undefined) {
    let dataStr: string;
    try {
      dataStr = JSON.stringify(signal.data);
    } catch {
      dataStr = String(signal.data);
    }
    if (dataStr && dataStr !== "{}") lines.push(`data=${dataStr.slice(0, 400)}`);
  }
  return lines.join("\n");
}

/** Convenience: read a room's signal already formatted for prompt injection. */
export async function readSignalsBlock(
  agent: string,
  roomId: string,
): Promise<string | undefined> {
  const stored = await readSignals(agent, roomId);
  return stored ? formatSignalsBlock(stored.signal) : undefined;
}

/**
 * Whether a signal is strong enough to inject into a vote/turn prompt. Weak or
 * NOTR research is treated as "no strong data view" so it never overrides the
 * agent's own strategy.
 */
export function isActionableSignal(
  signal: SandboxSignal,
  minConfidence = 0.5,
): boolean {
  return signal.bias !== "NOTR" && signal.confidence >= minConfidence;
}

/**
 * Read a signal block ONLY when it is actionable: a confident, directional
 * view. Weak or NOTR research is treated as "no strong data view" and is not
 * injected, so it can never override an agent's own strategy.
 */
export async function readActionableSignalsBlock(
  agent: string,
  roomId: string,
  minConfidence = 0.5,
): Promise<string | undefined> {
  const stored = await readSignals(agent, roomId);
  if (!stored) return undefined;
  if (!isActionableSignal(stored.signal, minConfidence)) return undefined;
  return formatSignalsBlock(stored.signal);
}
