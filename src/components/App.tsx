import React, { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { Box, Text, useApp, useInput, useWindowSize } from "ink";
import { Spinner } from "@inkjs/ui";
import chalk from "chalk";

import { StatusBar, type AgentStats, type NodeStatus } from "./StatusBar.js";
import { OutputPane } from "./OutputPane.js";
import { InputPrompt } from "./InputPrompt.js";
import { Editor } from "./Editor.js";
import { SettingsScreen } from "./SettingsScreen.js";
import { RunSelector, type SelectorResult } from "./RunSelector.js";
import { parseInput } from "../cli/parser.js";
import {
  getCommand,
  getCommandNames,
  isInteractiveResult,
  type PendingPrompt,
  type RunSelectorOpen,
} from "../commands/index.js";
import { listAgents } from "../services/agent.service.js";
import {
  loadCliConfig,
  fetchNodeConfig,
  setCachedNodeConfig,
  getCachedNodeConfig,
  type NodeConfig,
} from "../services/config.service.js";
import { walletExists } from "../services/wallet.service.js";
import { fetchAllRuns } from "../services/runs.service.js";
import {
  setAgentRooms,
  isRunning,
  subscribeRunsCache,
} from "../services/runs.cache.js";
import { log } from "../utils/logger.js";
import { getAgentsRoot } from "../utils/fs.js";
import { CommandHistory } from "../utils/history.js";
import { getRandomTip } from "../utils/tips.js";
import { setBusyListener, setBusy } from "../utils/busy.js";

interface EditorFile {
  path: string;
  name: string;
}

export function App() {
  const { exit } = useApp();
  const { rows, columns } = useWindowSize();

  const welcomeLines = useMemo(
    () => [
      "",
      chalk.dim('  Type "help" to get started.'),
      "  " + chalk.yellow.bold("Tip:") + " " + chalk.cyan(getRandomTip()),
      "",
    ],
    [],
  );

  const [lines, setLines] = useState<string[]>(welcomeLines);
  const [stats, setStats] = useState<AgentStats>({ total: 0, active: 0, idle: 0 });
  const [pendingPrompt, setPendingPrompt] = useState<PendingPrompt | null>(null);
  const [editorFile, setEditorFile] = useState<EditorFile | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [runSelector, setRunSelector] = useState<RunSelectorOpen | null>(null);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [nodeUrl, setNodeUrl] = useState<string>("");
  const [nodeStatus, setNodeStatus] = useState<NodeStatus>("loading");
  const [nodeRoomCount, setNodeRoomCount] = useState<number>(0);
  const [busyMessage, setBusyMessage] = useState<string | null>(null);
  const [streamingText, setStreamingText] = useState<string>("");
  const streamingRef = useRef<string>("");

  const historyRef = useRef(new CommandHistory());

  useEffect(() => {
    setBusyListener(setBusyMessage);
    return () => setBusyListener(null);
  }, []);

  const refreshStats = useCallback(async () => {
    try {
      const agents = await listAgents();
      const active = agents.filter((a) => isRunning(a.name)).length;
      setStats({
        total: agents.length,
        active,
        idle: agents.length - active,
      });

      const commandNames = getCommandNames();
      const agentNames = agents.map((a) => a.name);
      const cached = getCachedNodeConfig();
      const marketIds = cached?.markets?.map((m) => m.id) ?? [];
      const completions = [
        ...commandNames,
        ...agentNames.flatMap((name) =>
          ["info", "edit", "delete", "run", "stop"].map((cmd) => `${cmd} ${name}`),
        ),
        ...agentNames.flatMap((name) =>
          marketIds.map((m) => `run ${name} ${m}`),
        ),
      ];
      setSuggestions(completions);
    } catch {
      // ignore errors reading stats
    }
  }, []);

  useEffect(() => {
    refreshStats();
    const unsubscribe = subscribeRunsCache(() => {
      void refreshStats();
    });
    return unsubscribe;
  }, [refreshStats]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const cfg = await loadCliConfig();
      if (cancelled) return;
      setNodeUrl(cfg.nodeUrl);

      let nodeOk = false;
      let nodeDetail = "";

      try {
        const fetched: NodeConfig = await fetchNodeConfig(cfg.nodeUrl);
        if (cancelled) return;
        setCachedNodeConfig(fetched);
        setNodeRoomCount(fetched.rooms.length);
        setNodeStatus("online");
        nodeOk = true;
        nodeDetail = `${cfg.nodeUrl} | ${fetched.rooms.length} room${fetched.rooms.length === 1 ? "" : "s"}`;
      } catch {
        if (cancelled) return;
        setCachedNodeConfig(null);
        setNodeRoomCount(0);
        setNodeStatus("offline");
        nodeDetail = `Run "node set <url>" to connect (was ${cfg.nodeUrl}).`;
      }

      if (cancelled) return;

      const labelCol = (s: string) => chalk.cyan.bold(s.padEnd(10));
      const statusCol = (s: string, color: "green" | "yellow" | "red") =>
        chalk[color](s.padEnd(10));

      const apiOk = !!cfg.apiKey;
      const apiRow =
        "    " +
        labelCol("API Key") +
        (apiOk
          ? statusCol("set", "green")
          : statusCol("not set", "yellow") + chalk.dim('Run "settings" to add one.'));

      const nodeRow =
        "    " +
        labelCol("Node") +
        (nodeOk
          ? statusCol("online", "green") + chalk.dim(nodeDetail)
          : statusCol("offline", "red") + chalk.dim(nodeDetail));

      setLines((prev) => [
        ...prev,
        chalk.cyanBright.bold("  Status"),
        apiRow,
        nodeRow,
        "",
      ]);

      if (nodeOk) {
        const agents = await listAgents();
        if (cancelled) return;
        const eligible = [] as { name: string }[];
        for (const a of agents) {
          if (await walletExists(a.name)) eligible.push({ name: a.name });
        }
        if (eligible.length === 0) return;

        const runsByAgent = new Map<string, string[]>();
        let anyOk = false;
        for (const a of eligible) {
          try {
            const runs = await fetchAllRuns({
              nodeUrl: cfg.nodeUrl,
              agentName: a.name,
            });
            anyOk = true;
            for (const entry of runs) {
              runsByAgent.set(entry.name, entry.rooms);
            }
            if (!runsByAgent.has(a.name)) {
              runsByAgent.set(a.name, []);
            }
          } catch {
            // skip this agent silently; missing Redis or auth shouldn't break startup
          }
        }

        if (cancelled || !anyOk) return;

        for (const a of eligible) {
          setAgentRooms(a.name, runsByAgent.get(a.name) ?? []);
        }

        const rows: string[] = [];
        for (const a of eligible) {
          const rooms = runsByAgent.get(a.name) ?? [];
          const nameCol = chalk.white.bold(a.name.padEnd(14));
          if (rooms.length === 0) {
            rows.push(`    ${nameCol}${chalk.cyan("idle")}`);
          } else {
            rows.push(
              `    ${nameCol}${chalk.green("running")}  ${chalk.white(rooms.join(", "))}`,
            );
          }
        }
        setLines((prev) => [
          ...prev,
          chalk.cyanBright.bold("  Active runs"),
          ...rows,
          "",
        ]);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const appendLines = useCallback((...newLines: string[]) => {
    setLines((prev) => [...prev, ...newLines]);
    setScrollOffset(0);
  }, []);

  const clearScreen = useCallback(() => {
    setLines([]);
    setScrollOffset(0);
  }, []);

  useInput(
    (input, key) => {
      if (key.ctrl && input === "l") {
        clearScreen();
        return;
      }
      if (key.ctrl && input === "c") {
        exit();
        return;
      }
      if (key.pageUp) {
        setScrollOffset((p) => p + 5);
        return;
      }
      if (key.pageDown) {
        setScrollOffset((p) => Math.max(0, p - 5));
        return;
      }
      if (key.shift && key.upArrow) {
        setScrollOffset((p) => p + 1);
        return;
      }
      if (key.shift && key.downArrow) {
        setScrollOffset((p) => Math.max(0, p - 1));
        return;
      }
      if (key.ctrl && input === "u") {
        setScrollOffset((p) => p + 10);
        return;
      }
      if (key.ctrl && input === "d") {
        setScrollOffset((p) => Math.max(0, p - 10));
        return;
      }
      if (key.ctrl && input === "g") {
        setScrollOffset(0);
        return;
      }
    },
    { isActive: !editorFile && !settingsOpen && !runSelector }
  );

  const handleSubmit = useCallback(
    async (input: string) => {
      if (pendingPrompt) {
        const { lines: resultLines, nextPrompt } = await pendingPrompt.onResponse(input);
        if (resultLines.length > 0) appendLines(...resultLines);
        setPendingPrompt(nextPrompt ?? null);
        if (!nextPrompt) await refreshStats();
        return;
      }

      const trimmed = input.trim();
      if (!trimmed) return;

      const isAskCmd =
        trimmed.toLowerCase().startsWith("/ask") &&
        (trimmed.length === 4 || trimmed[4] === " ");
      const echoBody = isAskCmd
        ? chalk.cyan("/ask") + trimmed.slice(4)
        : trimmed;
      appendLines("", chalk.cyan("agent") + chalk.bold(" > ") + echoBody);

      const lower = trimmed.toLowerCase();

      if (lower === "exit" || lower === "quit") {
        appendLines("", chalk.dim("  Goodbye! [o_o]/"), "");
        setTimeout(() => exit(), 100);
        return;
      }

      if (lower === "clear") {
        clearScreen();
        return;
      }

      if (lower === "dir") {
        appendLines(log.info(`Directory: ${getAgentsRoot()}`), "");
        return;
      }

      const parsed = parseInput(trimmed);
      if (!parsed) return;

      const handler = getCommand(parsed.command);
      if (!handler) {
        appendLines(
          log.error(`Unknown command: "${parsed.command}"`),
          log.dim('  Type "help" to see available commands.'),
          ""
        );
        return;
      }

      try {
        const result = await handler(parsed.args);

        if (isInteractiveResult(result)) {
          appendLines(...result.lines);
          if (result.prompt) {
            setPendingPrompt(result.prompt);
          }
          if (result.openEditor) {
            setEditorFile({ path: result.openEditor.filePath, name: result.openEditor.fileName });
          }
          if (result.openSettings) {
            setSettingsOpen(true);
          }
          if (result.openRunSelector) {
            setRunSelector(result.openRunSelector);
          }
          if (result.stream) {
            const session = result.stream;
            if (session.prefixLine) {
              appendLines(session.prefixLine);
            }
            streamingRef.current = "";
            setStreamingText("");
            setBusy("Thinking...");

            const flush = () => {
              const buf = streamingRef.current;
              streamingRef.current = "";
              setStreamingText("");
              if (buf.length > 0) {
                const lines = buf.split("\n");
                appendLines(...lines);
              }
            };

            const handle = {
              appendToken: (chunk: string) => {
                setBusy(null);
                streamingRef.current += chunk;
                setStreamingText(streamingRef.current);
              },
              finalize: (extra?: string[]) => {
                setBusy(null);
                flush();
                if (extra && extra.length > 0) appendLines(...extra);
              },
              fail: (errorLine: string) => {
                setBusy(null);
                flush();
                appendLines(errorLine);
              },
            };

            session.start(handle).catch((err: Error) => {
              handle.fail(log.error(err.message));
            });
          }
          return;
        }

        appendLines(...result);
      } catch (err) {
        appendLines(log.error((err as Error).message));
      }

      await refreshStats();
    },
    [pendingPrompt, appendLines, refreshStats, exit, clearScreen]
  );

  const termHeight = rows || process.stdout.rows || 24;
  const termWidth = columns || process.stdout.columns || 80;
  const statusBarHeight = 4;
  const inputHeight = 1;
  const scrollHintHeight = scrollOffset > 0 ? 1 : 0;
  const busyRowHeight = busyMessage ? 1 : 0;
  const outputHeight = Math.max(
    1,
    termHeight - statusBarHeight - inputHeight - busyRowHeight - scrollHintHeight,
  );

  if (editorFile) {
    return (
      <Box flexDirection="column" height={termHeight} width={termWidth}>
        <Editor
          filePath={editorFile.path}
          fileName={editorFile.name}
          height={termHeight}
          onSave={() => {
            setEditorFile(null);
            appendLines(log.success("File saved.\n"));
          }}
          onCancel={() => {
            setEditorFile(null);
            appendLines(log.dim("  Edit cancelled.\n"));
          }}
        />
      </Box>
    );
  }

  if (settingsOpen) {
    return (
      <Box flexDirection="column" height={termHeight} width={termWidth}>
        <SettingsScreen
          height={termHeight}
          width={termWidth}
          onClose={() => {
            setSettingsOpen(false);
            appendLines(log.dim("  Settings closed."));
          }}
        />
      </Box>
    );
  }

  if (runSelector) {
    return (
      <Box flexDirection="column" height={termHeight} width={termWidth}>
        <RunSelector
          height={termHeight}
          width={termWidth}
          agentName={runSelector.agentName}
          mode={runSelector.mode}
          initialMarketId={runSelector.initialMarketId}
          onClose={(result: SelectorResult) => {
            setRunSelector(null);
            if (result.kind === "ok") {
              appendLines(log.success(result.message));
              if (runSelector.mode === "stop") {
                appendLines(
                  log.dim(
                    `  Stop does not close any open positions. (Use "pos ${runSelector.agentName}" once positions land.)`,
                  ),
                );
              }
            } else if (result.kind === "error") {
              appendLines(log.error(result.message));
            } else {
              appendLines(log.dim("  Cancelled."));
            }
          }}
        />
      </Box>
    );
  }

  return (
    <Box flexDirection="column" height={termHeight} width={termWidth}>
      <StatusBar
        stats={stats}
        nodeStatus={nodeStatus}
        nodeUrl={nodeUrl}
        nodeRoomCount={nodeRoomCount}
      />
      <OutputPane
        lines={streamingText ? [...lines, ...streamingText.split("\n")] : lines}
        height={outputHeight}
        scrollOffset={scrollOffset}
      />
      {scrollOffset > 0 && (
        <Box paddingX={1}>
          <Text color="yellow">{`-- scrolled up ${scrollOffset} line${scrollOffset === 1 ? "" : "s"} -- `}</Text>
          <Text dimColor>(PageDown / Ctrl+G to return)</Text>
        </Box>
      )}
      {busyMessage && (
        <Box paddingX={1}>
          <Spinner type="dots" />
          <Text dimColor>{` ${busyMessage}`}</Text>
        </Box>
      )}
      <InputPrompt
        onSubmit={handleSubmit}
        confirmPrompt={pendingPrompt?.prompt ?? null}
        history={historyRef.current}
        suggestions={suggestions}
      />
    </Box>
  );
}
