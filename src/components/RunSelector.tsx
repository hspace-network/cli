import React, { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import {
  getCachedNodeConfig,
  loadCliConfig,
  type Market,
  type NodeConfig,
} from "../services/config.service.js";
import { runAgent, stopAgent } from "../services/socket.service.js";
import { fetchRunsForAgent } from "../services/runs.service.js";
import { addAgentRoom, removeAgentRoom } from "../services/runs.cache.js";

interface RunSelectorProps {
  height: number;
  width: number;
  agentName: string;
  mode: "run" | "stop";
  initialMarketId?: string;
  onClose: (result: SelectorResult) => void;
}

export interface SelectorResult {
  kind: "ok" | "error" | "cancelled";
  message: string;
}

type RunStep = "market" | "interval";
type StopStep = "loading" | "list" | "empty";

export function RunSelector({
  height,
  width,
  agentName,
  mode,
  initialMarketId,
  onClose,
}: RunSelectorProps) {
  if (mode === "run") {
    return (
      <RunFlow
        height={height}
        width={width}
        agentName={agentName}
        initialMarketId={initialMarketId}
        onClose={onClose}
      />
    );
  }
  return (
    <StopFlow
      height={height}
      width={width}
      agentName={agentName}
      onClose={onClose}
    />
  );
}

function header(width: number, title: string, hint: string) {
  return (
    <Box borderStyle="single" borderColor="cyan" paddingX={1} flexShrink={0} width={width}>
      <Text color="cyanBright" bold>{title}</Text>
      <Box flexGrow={1} />
      <Text dimColor>{hint}</Text>
    </Box>
  );
}

function footer(width: number, text: string) {
  return (
    <Box borderStyle="single" borderColor="gray" paddingX={1} flexShrink={0} width={width}>
      <Text dimColor>{text}</Text>
    </Box>
  );
}

function intervalLabel(intervals: string[], index: number): string | undefined {
  return intervals[index];
}

function RunFlow({
  height,
  width,
  agentName,
  initialMarketId,
  onClose,
}: Omit<RunSelectorProps, "mode">) {
  const cached: NodeConfig | null = getCachedNodeConfig();
  const markets = cached?.markets ?? [];
  const intervals = cached?.intervals ?? [];

  const initialMarketIdx = initialMarketId
    ? Math.max(
        0,
        markets.findIndex((m) => m.id === initialMarketId),
      )
    : 0;

  const [step, setStep] = useState<RunStep>(
    initialMarketId ? "interval" : "market",
  );
  const [marketIdx, setMarketIdx] = useState(initialMarketIdx);
  const [intervalIdx, setIntervalIdx] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useInput((_input, key) => {
    if (busy) return;
    if (key.escape) {
      if (step === "interval" && !initialMarketId) {
        setStep("market");
        setError(null);
        return;
      }
      onClose({ kind: "cancelled", message: "" });
      return;
    }
    if (key.upArrow) {
      if (step === "market") {
        setMarketIdx((i) => Math.max(0, i - 1));
      } else {
        setIntervalIdx((i) => Math.max(0, i - 1));
      }
      return;
    }
    if (key.downArrow) {
      if (step === "market") {
        setMarketIdx((i) => Math.min(markets.length - 1, i + 1));
      } else {
        setIntervalIdx((i) => Math.min(intervals.length - 1, i + 1));
      }
      return;
    }
    if (key.return) {
      if (step === "market") {
        setStep("interval");
        setIntervalIdx(0);
        return;
      }
      void doRun();
    }
  });

  async function doRun(): Promise<void> {
    const market = markets[marketIdx];
    const interval = intervalLabel(intervals, intervalIdx);
    if (!market || !interval) {
      setError("Make a selection first.");
      return;
    }
    const roomId = `${market.id}:${interval}`;
    setBusy(`Joining ${roomId}...`);
    setError(null);
    try {
      const cfg = await loadCliConfig();
      await runAgent({ nodeUrl: cfg.nodeUrl, agentName, roomId });
      addAgentRoom(agentName, roomId);
      onClose({
        kind: "ok",
        message: `${agentName} joined ${roomId}.`,
      });
    } catch (err) {
      setBusy(null);
      setError((err as Error).message);
    }
  }

  if (markets.length === 0 || intervals.length === 0) {
    return (
      <Box flexDirection="column" height={height} width={width}>
        {header(width, "RUN", "Esc close")}
        <Box flexDirection="column" flexGrow={1} paddingX={2} paddingY={1}>
          <Text color="yellow">
            Not connected to a node, or no markets/intervals available.
          </Text>
        </Box>
        {footer(width, `Agent: ${agentName}`)}
      </Box>
    );
  }

  if (step === "market") {
    return (
      <Box flexDirection="column" height={height} width={width}>
        {header(width, "RUN", "Up/Down move  Enter pick  Esc close")}
        <Box flexDirection="column" flexGrow={1} paddingX={2} paddingY={1}>
          <Text color="cyan" bold>Pick a market</Text>
          <Text dimColor>Agent: {agentName}</Text>
          <Box marginTop={1} flexDirection="column">
            {markets.map((m: Market, i: number) => {
              const selected = i === marketIdx;
              return (
                <Box key={m.id}>
                  <Box width={4}>
                    <Text color="cyan" bold>{selected ? ">" : " "}</Text>
                  </Box>
                  <Box width={12}>
                    <Text color={selected ? "cyanBright" : "white"} bold={selected}>
                      {m.id}
                    </Text>
                  </Box>
                  <Text dimColor>{m.name ?? ""}</Text>
                </Box>
              );
            })}
          </Box>
        </Box>
        {footer(width, `${markets.length} market${markets.length === 1 ? "" : "s"}`)}
      </Box>
    );
  }

  const market = markets[marketIdx]!;
  return (
    <Box flexDirection="column" height={height} width={width}>
      {header(width, "RUN", "Up/Down move  Enter join  Esc back")}
      <Box flexDirection="column" flexGrow={1} paddingX={2} paddingY={1}>
        <Text color="cyan" bold>Pick an interval</Text>
        <Text dimColor>Agent: {agentName}  Market: {market.id}</Text>
        <Box marginTop={1} flexDirection="column">
          {intervals.map((iv, i) => {
            const selected = i === intervalIdx;
            return (
              <Box key={iv}>
                <Box width={4}>
                  <Text color="cyan" bold>{selected ? ">" : " "}</Text>
                </Box>
                <Text color={selected ? "cyanBright" : "white"} bold={selected}>
                  {iv}
                </Text>
              </Box>
            );
          })}
        </Box>
        {error ? (
          <Box marginTop={1}>
            <Text color="red">{error}</Text>
          </Box>
        ) : null}
        {busy ? (
          <Box marginTop={1}>
            <Text color="yellow">{busy}</Text>
          </Box>
        ) : null}
      </Box>
      {footer(width, `${intervals.length} interval${intervals.length === 1 ? "" : "s"}`)}
    </Box>
  );
}

function StopFlow({
  height,
  width,
  agentName,
  onClose,
}: Omit<RunSelectorProps, "mode" | "initialMarketId">) {
  const [step, setStep] = useState<StopStep>("loading");
  const [rooms, setRooms] = useState<string[]>([]);
  const [idx, setIdx] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const cfg = await loadCliConfig();
        const list = await fetchRunsForAgent({
          nodeUrl: cfg.nodeUrl,
          agentName,
        });
        if (cancelled) return;
        setRooms(list);
        setStep(list.length === 0 ? "empty" : "list");
      } catch (err) {
        if (cancelled) return;
        setError((err as Error).message);
        setStep("empty");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [agentName]);

  useInput((_input, key) => {
    if (busy) return;
    if (key.escape) {
      onClose({ kind: "cancelled", message: "" });
      return;
    }
    if (step !== "list") return;
    if (key.upArrow) {
      setIdx((i) => Math.max(0, i - 1));
      return;
    }
    if (key.downArrow) {
      setIdx((i) => Math.min(rooms.length - 1, i + 1));
      return;
    }
    if (key.return) {
      void doStop();
    }
  });

  async function doStop(): Promise<void> {
    const roomId = rooms[idx];
    if (!roomId) return;
    setBusy(`Leaving ${roomId}...`);
    setError(null);
    try {
      const cfg = await loadCliConfig();
      await stopAgent({ nodeUrl: cfg.nodeUrl, agentName, roomId });
      removeAgentRoom(agentName, roomId);
      onClose({
        kind: "ok",
        message: `${agentName} left ${roomId}.`,
      });
    } catch (err) {
      setBusy(null);
      setError((err as Error).message);
    }
  }

  if (step === "loading") {
    return (
      <Box flexDirection="column" height={height} width={width}>
        {header(width, "STOP", "Esc close")}
        <Box flexDirection="column" flexGrow={1} paddingX={2} paddingY={1}>
          <Text dimColor>Loading active runs...</Text>
        </Box>
        {footer(width, `Agent: ${agentName}`)}
      </Box>
    );
  }

  if (step === "empty") {
    return (
      <Box flexDirection="column" height={height} width={width}>
        {header(width, "STOP", "Esc close")}
        <Box flexDirection="column" flexGrow={1} paddingX={2} paddingY={1}>
          {error ? (
            <Text color="red">{error}</Text>
          ) : (
            <Text color="yellow">{agentName} is not in any rooms.</Text>
          )}
        </Box>
        {footer(width, `Agent: ${agentName}`)}
      </Box>
    );
  }

  return (
    <Box flexDirection="column" height={height} width={width}>
      {header(width, "STOP", "Up/Down move  Enter leave  Esc close")}
      <Box flexDirection="column" flexGrow={1} paddingX={2} paddingY={1}>
        <Text color="cyan" bold>Pick a room to leave</Text>
        <Text dimColor>Agent: {agentName}</Text>
        <Box marginTop={1} flexDirection="column">
          {rooms.map((r, i) => {
            const selected = i === idx;
            return (
              <Box key={r}>
                <Box width={4}>
                  <Text color="cyan" bold>{selected ? ">" : " "}</Text>
                </Box>
                <Text color={selected ? "cyanBright" : "white"} bold={selected}>
                  {r}
                </Text>
              </Box>
            );
          })}
        </Box>
        {error ? (
          <Box marginTop={1}>
            <Text color="red">{error}</Text>
          </Box>
        ) : null}
        {busy ? (
          <Box marginTop={1}>
            <Text color="yellow">{busy}</Text>
          </Box>
        ) : null}
      </Box>
      {footer(width, `${rooms.length} active room${rooms.length === 1 ? "" : "s"}`)}
    </Box>
  );
}
