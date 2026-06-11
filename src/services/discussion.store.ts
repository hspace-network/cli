import { subscribeDiscussion, type ActionKind, type DiscussionEvent } from "./discussion.bus.js";
import { formatPositionTableLines } from "../utils/position-table.js";

export type ChatRole = "system" | "vote" | "turn" | "action";

export interface ChatEntry {
  role: ChatRole;
  agentName?: string;
  round?: number;
  text: string;
  way?: "LONG" | "SHORT" | "NOTR";
  phase?: "opening" | "final";
  ok?: boolean;
  kind?: ActionKind;
  tableLines?: string[];
}

export interface SessionLog {
  sessionId: string;
  roomId: string;
  market: string;
  interval: string;
  participants: string[];
  startedAt: number;
  closed: boolean;
  tally?: { LONG: number; SHORT: number; NOTR: number };
  entries: ChatEntry[];
}

const MAX_SESSIONS = 50;

const sessions: SessionLog[] = [];
const byId = new Map<string, SessionLog>();
type Listener = () => void;
const listeners = new Set<Listener>();

function notify(): void {
  for (const fn of listeners) fn();
}

function ensureSession(
  sessionId: string,
  roomId: string,
  market?: string,
  interval?: string,
): SessionLog {
  let session = byId.get(sessionId);
  if (!session) {
    const [m = roomId, i = ""] = roomId.split(":");
    session = {
      sessionId,
      roomId,
      market: market ?? m,
      interval: interval ?? i,
      participants: [],
      startedAt: Date.now(),
      closed: false,
      entries: [],
    };
    byId.set(sessionId, session);
    sessions.push(session);
    while (sessions.length > MAX_SESSIONS) {
      const removed = sessions.shift();
      if (removed) byId.delete(removed.sessionId);
    }
  }
  return session;
}

function handle(event: DiscussionEvent): void {
  if (event.type === "open") {
    const session = ensureSession(
      event.sessionId,
      event.roomId,
      event.market,
      event.interval,
    );
    session.participants = event.participants;
    session.entries.push({
      role: "system",
      text: `Discussion started — ${event.participants.length} agents: ${event.participants.join(", ")}`,
    });
  } else if (event.type === "vote") {
    const session = ensureSession(event.sessionId, event.roomId);
    session.entries.push({
      role: "vote",
      agentName: event.agentName,
      way: event.way,
      phase: event.phase === "final" ? "final" : "opening",
      text: event.rationale ?? "",
    });
  } else if (event.type === "turn") {
    const session = ensureSession(event.sessionId, event.roomId);
    session.entries.push({
      role: "turn",
      agentName: event.agentName,
      round: event.round,
      text: event.content,
    });
  } else if (event.type === "action") {
    const session = ensureSession(event.sessionId, event.roomId);
    const tradeKinds: ActionKind[] = ["open", "flip", "add", "reduce", "close"];
    const tableLines = tradeKinds.includes(event.kind)
      ? formatPositionTableLines(event.position)
      : undefined;
    session.entries.push({
      role: "action",
      agentName: event.agentName,
      ok: event.ok,
      text: event.message,
      kind: event.kind,
      tableLines,
    });
  } else if (event.type === "close") {
    const session = ensureSession(event.sessionId, event.roomId);
    session.closed = true;
    session.tally = event.tally;
    session.entries.push({
      role: "system",
      text: `Session closed — LONG ${event.tally.LONG} / SHORT ${event.tally.SHORT} / NOTR ${event.tally.NOTR} (${event.rounds} round${event.rounds === 1 ? "" : "s"})`,
    });
  }
  notify();
}

let started = false;

export function initDiscussionStore(): void {
  if (started) return;
  started = true;
  subscribeDiscussion(handle);
}

export function getSessionLogs(): SessionLog[] {
  return sessions;
}

export function subscribeDiscussionStore(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
