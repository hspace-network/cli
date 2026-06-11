import type { PositionSnapshot } from "../services/positions.service.js";

const COLS = {
  symbol: 10,
  side: 6,
  size: 10,
  entry: 10,
  mark: 10,
  pnl: 12,
};

function pad(s: string, w: number): string {
  return s.length >= w ? s.slice(0, w) : s.padEnd(w);
}

function formatPnl(n: number): string {
  const prefix = n > 0 ? "+" : "";
  return `${prefix}${n.toFixed(2)}`;
}

export function formatPositionTableLines(
  snapshot: PositionSnapshot | null | undefined,
  width = 80,
): string[] {
  if (!snapshot) {
    return ["    (flat)"];
  }

  const totalWidth =
    COLS.symbol + COLS.side + COLS.size + COLS.entry + COLS.mark + COLS.pnl + 5;
  if (totalWidth > width) {
    return [
      `    ${snapshot.symbol} ${snapshot.side} size=${snapshot.size} entry=${snapshot.entry} pnl=${formatPnl(snapshot.pnl)}`,
    ];
  }

  const header =
    pad("SYMBOL", COLS.symbol) +
    pad("SIDE", COLS.side) +
    pad("SIZE", COLS.size) +
    pad("ENTRY", COLS.entry) +
    pad("MARK", COLS.mark) +
    pad("PNL", COLS.pnl);

  const row =
    pad(snapshot.symbol, COLS.symbol) +
    pad(snapshot.side, COLS.side) +
    pad(snapshot.size, COLS.size) +
    pad(snapshot.entry, COLS.entry) +
    pad(snapshot.mark, COLS.mark) +
    pad(formatPnl(snapshot.pnl), COLS.pnl);

  return [`    ${header}`, `    ${row}`];
}
