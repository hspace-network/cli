import React, { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import {
  loadCliConfig,
  getEffectiveNetwork,
  getPlatformCreds,
  type BybitNetwork,
} from "../services/config.service.js";
import { bybitGet, type BybitCreds } from "../services/bybit.service.js";

interface PosScreenProps {
  height: number;
  width: number;
  agentName: string;
  onClose: () => void;
}

interface Row {
  symbol: string;
  side: "LONG" | "SHORT";
  size: string;
  entry: string;
  mark: string;
  pnl: number;
  pnlPct: number;
  leverage: string;
  liq: string;
  margin: string;
}

interface PositionListResult {
  list?: Array<{
    symbol: string;
    side: string;
    size: string;
    avgPrice: string;
    markPrice: string;
    unrealisedPnl: string;
    leverage: string;
    liqPrice: string;
    positionIM: string;
  }>;
}

interface WalletBalanceResult {
  list?: Array<{ totalEquity?: string; totalAvailableBalance?: string }>;
}

const POLL_INTERVAL_MS = 3000;

function formatNum(n: number, decimals: number): string {
  if (!Number.isFinite(n)) return "?";
  return n.toFixed(decimals);
}

function pickPxDecimals(value: string): number {
  const dotIdx = value.indexOf(".");
  if (dotIdx === -1) return 0;
  return Math.min(6, value.length - dotIdx - 1);
}

function trimZeros(value: string): string {
  if (!value.includes(".")) return value;
  return value.replace(/0+$/, "").replace(/\.$/, "");
}

export function PosScreen({ height, width, agentName, onClose }: PosScreenProps) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [equity, setEquity] = useState<string | null>(null);
  const [available, setAvailable] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [network, setNetwork] = useState<BybitNetwork>("mainnet");
  const [tickHint, setTickHint] = useState<number>(0);

  useInput((_input, key) => {
    if (key.escape) onClose();
  });

  useEffect(() => {
    let cancelled = false;
    let pollTimer: ReturnType<typeof setInterval> | null = null;

    async function pollOnce(net: BybitNetwork, creds: BybitCreds) {
      try {
        const positions = await bybitGet<PositionListResult>(
          net,
          "/v5/position/list",
          { category: "linear", settleCoin: "USDT" },
          creds,
        );
        if (cancelled) return;

        const next: Row[] = [];
        for (const p of positions.list ?? []) {
          const size = Number(p.size);
          if (!Number.isFinite(size) || size === 0) continue;
          const entry = Number(p.avgPrice);
          const mark = Number(p.markPrice);
          const pnl = Number(p.unrealisedPnl);
          const margin = Number(p.positionIM);
          const pnlPct =
            Number.isFinite(margin) && margin > 0 ? (pnl / margin) * 100 : 0;
          const decimals = Math.max(
            pickPxDecimals(p.avgPrice),
            pickPxDecimals(p.markPrice),
          );
          next.push({
            symbol: p.symbol,
            side: p.side === "Buy" ? "LONG" : "SHORT",
            size: trimZeros(size.toString()),
            entry: formatNum(entry, decimals),
            mark: formatNum(mark, decimals),
            pnl,
            pnlPct,
            leverage: `${p.leverage}x`,
            liq: p.liqPrice ? formatNum(Number(p.liqPrice), decimals) : "-",
            margin: formatNum(margin, 2),
          });
        }
        setRows(next);
        setError(null);
        setTickHint((t) => t + 1);

        // Balance is best-effort; ignore failures so positions still render.
        try {
          const balance = await bybitGet<WalletBalanceResult>(
            net,
            "/v5/account/wallet-balance",
            { accountType: "UNIFIED" },
            creds,
          );
          if (cancelled) return;
          const acc = balance.list?.[0];
          setEquity(acc?.totalEquity ?? null);
          setAvailable(acc?.totalAvailableBalance ?? null);
        } catch {
          /* ignore balance errors */
        }
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      }
    }

    (async () => {
      try {
        const cfg = await loadCliConfig();
        if (cancelled) return;
        const net = getEffectiveNetwork(cfg);
        setNetwork(net);

        const creds = getPlatformCreds(cfg, "Bybit");
        if (!creds) {
          setError('Set your Bybit API key in settings ("settings" → Platform).');
          return;
        }
        if (cancelled) return;

        await pollOnce(net, creds);
        pollTimer = setInterval(() => {
          void pollOnce(net, creds);
        }, POLL_INTERVAL_MS);
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      }
    })();

    return () => {
      cancelled = true;
      if (pollTimer) clearInterval(pollTimer);
    };
  }, [agentName]);

  const COLS = {
    symbol: 12,
    side: 6,
    size: 12,
    entry: 12,
    mark: 12,
    pnl: 14,
    pnlPct: 10,
    lev: 8,
    liq: 12,
    margin: 12,
  };

  const headerRow = (
    <Box>
      <Box width={COLS.symbol}><Text dimColor>SYMBOL</Text></Box>
      <Box width={COLS.side}><Text dimColor>SIDE</Text></Box>
      <Box width={COLS.size}><Text dimColor>SIZE</Text></Box>
      <Box width={COLS.entry}><Text dimColor>ENTRY</Text></Box>
      <Box width={COLS.mark}><Text dimColor>MARK</Text></Box>
      <Box width={COLS.pnl}><Text dimColor>PNL ($)</Text></Box>
      <Box width={COLS.pnlPct}><Text dimColor>PNL (%)</Text></Box>
      <Box width={COLS.lev}><Text dimColor>LEV</Text></Box>
      <Box width={COLS.liq}><Text dimColor>LIQ</Text></Box>
      <Box width={COLS.margin}><Text dimColor>MARGIN</Text></Box>
    </Box>
  );

  return (
    <Box flexDirection="column" height={height} width={width}>
      <Box borderStyle="single" borderColor="cyan" paddingX={1} flexShrink={0} width={width}>
        <Text color="cyanBright" bold>POSITIONS</Text>
        <Box flexGrow={1} />
        <Text dimColor>
          {agentName} on Bybit {network}  Esc close
        </Text>
      </Box>

      <Box flexDirection="column" flexGrow={1} paddingX={2} paddingY={1}>
        {error ? (
          <Text color="red">{error}</Text>
        ) : rows === null ? (
          <Text dimColor>Connecting to Bybit...</Text>
        ) : rows.length === 0 ? (
          <Text dimColor>No open positions.</Text>
        ) : (
          <Box flexDirection="column">
            {headerRow}
            {rows.map((r) => {
              const pnlColor = r.pnl > 0 ? "green" : r.pnl < 0 ? "red" : "white";
              const pnlPrefix = r.pnl > 0 ? "+" : "";
              return (
                <Box key={r.symbol}>
                  <Box width={COLS.symbol}>
                    <Text color="cyanBright" bold>{r.symbol}</Text>
                  </Box>
                  <Box width={COLS.side}>
                    <Text color={r.side === "LONG" ? "green" : "red"}>{r.side}</Text>
                  </Box>
                  <Box width={COLS.size}><Text>{r.size}</Text></Box>
                  <Box width={COLS.entry}><Text>{r.entry}</Text></Box>
                  <Box width={COLS.mark}><Text>{r.mark}</Text></Box>
                  <Box width={COLS.pnl}>
                    <Text color={pnlColor}>{pnlPrefix}{formatNum(r.pnl, 2)}</Text>
                  </Box>
                  <Box width={COLS.pnlPct}>
                    <Text color={pnlColor}>{pnlPrefix}{formatNum(r.pnlPct, 2)}%</Text>
                  </Box>
                  <Box width={COLS.lev}><Text>{r.leverage}</Text></Box>
                  <Box width={COLS.liq}><Text>{r.liq}</Text></Box>
                  <Box width={COLS.margin}><Text>{r.margin}</Text></Box>
                </Box>
              );
            })}
          </Box>
        )}
      </Box>

      <Box borderStyle="single" borderColor="gray" paddingX={1} flexShrink={0} width={width}>
        <Text dimColor>
          {equity !== null ? `Equity $${equity}  ` : ""}
          {available !== null ? `Available $${available}  ` : ""}
          {rows !== null ? `tick ${tickHint}  ` : ""}
        </Text>
        <Box flexGrow={1} />
        <Text dimColor>{rows?.length ?? 0} position{rows?.length === 1 ? "" : "s"}</Text>
      </Box>
    </Box>
  );
}
