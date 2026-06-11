import React, { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import {
  getSessionLogs,
  subscribeDiscussionStore,
  type SessionLog,
  type ChatEntry,
} from "../services/discussion.store.js";

interface LogsScreenProps {
  height: number;
  width: number;
  onClose: () => void;
}

interface Row {
  text: string;
  color?: string;
  dim?: boolean;
  bold?: boolean;
}

const AUTHOR_COLORS = [
  "cyanBright",
  "magentaBright",
  "greenBright",
  "yellowBright",
  "blueBright",
  "redBright",
];

function authorColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) {
    hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  }
  return AUTHOR_COLORS[hash % AUTHOR_COLORS.length]!;
}

function wayColor(way: string | undefined): string | undefined {
  if (way === "LONG") return "green";
  if (way === "SHORT") return "red";
  return undefined;
}

function wrap(text: string, width: number): string[] {
  const w = Math.max(8, width);
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  for (const word of words) {
    let candidate = cur ? `${cur} ${word}` : word;
    while (candidate.length > w) {
      if (cur) {
        lines.push(cur);
        cur = "";
        candidate = word;
      }
      if (candidate.length > w) {
        lines.push(candidate.slice(0, w));
        candidate = candidate.slice(w);
      }
    }
    cur = candidate;
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [""];
}

function buildRows(session: SessionLog, width: number): Row[] {
  const rows: Row[] = [];
  const bodyWidth = Math.max(8, width - 6);

  for (const entry of session.entries) {
    if (entry.role === "system") {
      rows.push({ text: "" });
      rows.push({ text: `  ── ${entry.text}`, dim: true });
    } else if (entry.role === "vote") {
      const color = wayColor(entry.way);
      rows.push({ text: "" });
      rows.push({
        text: `  ▸ ${entry.agentName} ${entry.phase} vote: ${entry.way}`,
        color,
        dim: !color,
        bold: true,
      });
      if (entry.text.trim()) {
        for (const line of wrap(entry.text.trim(), bodyWidth)) {
          rows.push({ text: `      ${line}`, dim: true });
        }
      }
    } else if (entry.role === "turn") {
      rows.push({ text: "" });
      rows.push({
        text: `  ${entry.agentName} · round ${entry.round}`,
        color: authorColor(entry.agentName ?? ""),
        bold: true,
      });
      for (const line of wrap(entry.text.trim(), bodyWidth)) {
        rows.push({ text: `    ${line}` });
      }
    } else if (entry.role === "action") {
      rows.push({
        text: `  → ${entry.agentName} ${entry.text}`,
        color: entry.ok ? "green" : "yellow",
      });
      if (entry.tableLines) {
        for (const line of entry.tableLines) {
          rows.push({ text: line, dim: true });
        }
      }
    }
  }
  return rows;
}

export function LogsScreen({ height, width, onClose }: LogsScreenProps) {
  const [, setTick] = useState(0);
  const [sessionIdx, setSessionIdx] = useState<number | null>(null);
  const [scroll, setScroll] = useState(0);

  useEffect(() => {
    return subscribeDiscussionStore(() => setTick((t) => t + 1));
  }, []);

  const sessions = getSessionLogs();
  const idx =
    sessionIdx === null
      ? sessions.length - 1
      : Math.min(sessionIdx, sessions.length - 1);

  const bodyHeight = Math.max(1, height - 6);

  useInput((_input, key) => {
    if (key.escape) {
      onClose();
      return;
    }
    if (sessions.length === 0) return;
    if (key.leftArrow) {
      setSessionIdx(Math.max(0, idx - 1));
      setScroll(0);
      return;
    }
    if (key.rightArrow) {
      setSessionIdx(Math.min(sessions.length - 1, idx + 1));
      setScroll(0);
      return;
    }
    if (key.upArrow) {
      setScroll((s) => s + 1);
      return;
    }
    if (key.downArrow) {
      setScroll((s) => Math.max(0, s - 1));
      return;
    }
    if (key.pageUp) {
      setScroll((s) => s + bodyHeight);
      return;
    }
    if (key.pageDown) {
      setScroll((s) => Math.max(0, s - bodyHeight));
      return;
    }
  });

  const session = idx >= 0 ? sessions[idx] : undefined;
  const rows = session ? buildRows(session, width) : [];

  const maxOffset = Math.max(0, rows.length - bodyHeight);
  const clamped = Math.min(scroll, maxOffset);
  const start = Math.max(0, rows.length - bodyHeight - clamped);
  const visible = rows.slice(start, start + bodyHeight);
  const linesBelow = Math.max(0, rows.length - start - bodyHeight);

  const statusLabel = session
    ? session.closed
      ? "closed"
      : "live"
    : "";

  return (
    <Box flexDirection="column" height={height} width={width}>
      <Box
        borderStyle="single"
        borderColor="cyan"
        paddingX={1}
        flexShrink={0}
        width={width}
      >
        <Text color="cyanBright" bold>
          DISCUSSIONS
        </Text>
        <Box flexGrow={1} />
        <Text dimColor>
          {sessions.length > 0 ? `session ${idx + 1}/${sessions.length}  ` : ""}
          ←/→ switch  ↑/↓ scroll  Esc close
        </Text>
      </Box>

      <Box flexDirection="column" flexGrow={1} paddingX={1}>
        {sessions.length === 0 || !session ? (
          <Text dimColor>
            No discussions yet. Join a room with 2+ agents and let a session run.
          </Text>
        ) : (
          <>
            <Box flexShrink={0}>
              <Text>
                <Text color="cyanBright" bold>
                  {session.market} {session.interval}
                </Text>
                <Text dimColor>
                  {"  "}
                  {session.participants.length} agents · {statusLabel}
                  {session.tally
                    ? `  ·  L${session.tally.LONG}/S${session.tally.SHORT}/N${session.tally.NOTR}`
                    : ""}
                </Text>
              </Text>
            </Box>
            <Box flexDirection="column" height={bodyHeight} overflow="hidden">
              {visible.map((row, i) => (
                <Text
                  key={`row-${start + i}`}
                  color={row.color}
                  dimColor={row.dim}
                  bold={row.bold}
                  wrap="truncate-end"
                >
                  {row.text || " "}
                </Text>
              ))}
            </Box>
          </>
        )}
      </Box>

      <Box
        borderStyle="single"
        borderColor="gray"
        paddingX={1}
        flexShrink={0}
        width={width}
      >
        <Text dimColor>
          {session ? session.roomId : "no active discussion"}
        </Text>
        <Box flexGrow={1} />
        <Text dimColor>
          {clamped > 0 ? `scrolled +${clamped}  ` : ""}
          {linesBelow > 0 && clamped > 0 ? `${linesBelow} below` : ""}
        </Text>
      </Box>
    </Box>
  );
}
