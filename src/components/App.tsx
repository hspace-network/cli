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
import { PosScreen } from "./PosScreen.js";
import { LogsScreen } from "./LogsScreen.js";
import { StrategyScreen } from "./StrategyScreen.js";
import { ScriptsScreen } from "./ScriptsScreen.js";
import { parseInput } from "../cli/parser.js";
import {
  getCommand,
  getCommandNames,
  isInteractiveResult,
  type PendingPrompt,
  type PosScreenOpen,
  type RunSelectorOpen,
  type ScriptsScreenOpen,
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
import {
  getActiveAgent,
  clearActiveAgent,
  subscribeActiveAgent,
} from "../services/active-agent.service.js";
import { subscribeDiscussion, type ActionKind } from "../services/discussion.bus.js";
import { formatPositionTableLines } from "../utils/position-table.js";
import { initDiscussionStore } from "../services/discussion.store.js";
import { log } from "../utils/logger.js";
import { getAgentsRoot } from "../utils/fs.js";
import { CommandHistory } from "../utils/history.js";
import { getRandomTip } from "../utils/tips.js";
import { setBusyListener, setBusy } from "../utils/busy.js";

interface EditorFile {
  path: string;
  name: string;
}

const AGENT_FIRST_COMMANDS = new Set<string>([
  "info",
  "delete",
  "cap",
  "history",
  "run",
  "stop",
  "myrooms",
  "pos",
  "/ask",
  "/long",
  "/short",
  "/close",
  "/cancel",
  "/lev",
  "balance",
  "deposit",
  "withdraw",
  "limits",
  "code",
]);

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
  const [posScreen, setPosScreen] = useState<PosScreenOpen | null>(null);
  const [logsOpen, setLogsOpen] = useState(false);
  const [strategyOpen, setStrategyOpen] = useState(false);
  const [scriptsScreen, setScriptsScreen] = useState<ScriptsScreenOpen | null>(null);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [nodeUrl, setNodeUrl] = useState<string>("");
  const [nodeStatus, setNodeStatus] = useState<NodeStatus>("loading");
  const [nodeRoomCount, setNodeRoomCount] = useState<number>(0);
  const [busyMessage, setBusyMessage] = useState<string | null>(null);
  const [streamingText, setStreamingText] = useState<string>("");
  const [activeAgent, setActiveAgentState] = useState<string | null>(getActiveAgent());
  const streamingRef = useRef<string>("");

  useEffect(() => {
    return subscribeActiveAgent(() => {
      setActiveAgentState(getActiveAgent());
    });
  }, []);

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

      const AGENT_CMDS_BARE = [
        "info",
        "delete",
        "cap",
        "history",
        "run",
        "stop",
        "myrooms",
        "pos",
        "use",
        "code",
        "score",
        "balance",
        "deposit",
        "withdraw",
        "limits",
      ];
      const AGENT_CMDS_SLASH = [
        "/long",
        "/short",
        "/close",
        "/cancel",
        "/lev",
      ];

      const strategyIds = cached?.strategies?.map((s) => s.id) ?? [];

      const completions: string[] = [
        ...commandNames,
        "strategy",
        "set strategy",
        ...strategyIds.map((id) => `set strategy ${id}`),
        ...agentNames.flatMap((name) =>
          [...AGENT_CMDS_BARE, ...AGENT_CMDS_SLASH].map((cmd) => `${cmd} ${name}`),
        ),
        ...agentNames.flatMap((name) => [
          `code ${name} scripts`,
          `code ${name} dry-run`,
        ]),
        ...agentNames.flatMap((name) =>
          marketIds.flatMap((m) => [
            `run ${name} ${m}`,
            `/long ${name} ${m}`,
            `/short ${name} ${m}`,
            `/close ${name} ${m}`,
            `/cancel ${name} ${m}`,
            `/lev ${name} ${m}`,
          ]),
        ),
      ];

      if (activeAgent) {
        completions.push("code scripts");
        completions.push("code dry-run");
        for (const m of marketIds) {
          completions.push(`/long ${m}`);
          completions.push(`/short ${m}`);
          completions.push(`/close ${m}`);
          completions.push(`/cancel ${m}`);
          completions.push(`/lev ${m}`);
          completions.push(`run ${m}`);
        }
      }

      setSuggestions(completions);
    } catch {
      // ignore errors reading stats
    }
  }, [activeAgent]);

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

      const nodeRow =
        "    " +
        labelCol("Node") +
        (nodeOk
          ? statusCol("online", "green") + chalk.dim(nodeDetail)
          : statusCol("offline", "red") + chalk.dim(nodeDetail));

      setLines((prev) => [
        ...prev,
        chalk.cyanBright.bold("  Status"),
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
          const running = rooms.length > 0;
          // Running agents get the accent color; idle agents stay muted.
          const nameCol = running
            ? chalk.cyanBright.bold(a.name.padEnd(14))
            : chalk.white(a.name.padEnd(14));
          if (!running) {
            rows.push(`    ${nameCol}${chalk.gray("idle")}`);
          } else {
            rows.push(
              `    ${nameCol}${chalk.cyanBright("running")}  ${chalk.white(rooms.join(", "))}`,
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

  useEffect(() => {
    initDiscussionStore();
    const tradeKinds = new Set<ActionKind>(["open", "flip", "add", "reduce", "close"]);
    return subscribeDiscussion((event) => {
      if (event.type !== "action") return;
      if (!tradeKinds.has(event.kind)) return;
      const out: string[] = [
        "",
        chalk.green("  ▸ ") +
          chalk.cyanBright(event.agentName) +
          " " +
          chalk.white(event.message),
      ];
      for (const line of formatPositionTableLines(event.position)) {
        out.push(chalk.dim(line));
      }
      appendLines(...out);
    });
  }, [appendLines]);

  useInput(
    (input, key) => {
      if (pendingPrompt && key.escape) {
        setPendingPrompt(null);
        appendLines(chalk.dim("  Cancelled."));
        return;
      }
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
      if (key.ctrl && input === "g") {
        setScrollOffset(0);
        return;
      }
    },
    { isActive: !editorFile && !settingsOpen && !runSelector && !posScreen && !logsOpen && !strategyOpen && !scriptsScreen }
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
      const promptPrefix =
        chalk.cyan("agent") +
        chalk.bold(" > ") +
        (activeAgent ? chalk.cyanBright.bold(activeAgent) + chalk.bold(" > ") : "");
      appendLines("", promptPrefix + echoBody);

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

      let effectiveArgs = parsed.args;
      if (activeAgent && AGENT_FIRST_COMMANDS.has(parsed.command)) {
        try {
          const agents = await listAgents();
          const names = new Set(agents.map((a) => a.name));
          const first = parsed.args[0];
          if (!first || !names.has(first)) {
            effectiveArgs = [activeAgent, ...parsed.args];
          }
        } catch {
          // If listing fails, fall back to user-typed args.
        }
      }

      const prependBlank = (lines: string[]): string[] => {
        if (lines.length === 0) return lines;
        if (lines[0] === "") return lines;
        return ["", ...lines];
      };

      try {
        const result = await handler(effectiveArgs);

        if (isInteractiveResult(result)) {
          if (result.lines.length > 0) appendLines(...prependBlank(result.lines));
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
          if (result.openPosScreen) {
            setPosScreen(result.openPosScreen);
          }
          if (result.openLogs) {
            setLogsOpen(true);
          }
          if (result.openStrategyScreen) {
            setStrategyOpen(true);
          }
          if (result.openScriptsScreen) {
            setScriptsScreen(result.openScriptsScreen);
          }
          if (result.stream) {
            const session = result.stream;
            appendLines("");
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
              setStatus: (label: string | null) => {
                setBusy(label);
              },
              finalize: (extra?: string[]) => {
                setBusy(null);
                flush();
                if (extra && extra.length > 0) appendLines(...extra);
              },
              fail: (errorLine: string) => {
                setBusy(null);
                flush();
                appendLines("", errorLine);
              },
            };

            session.start(handle).catch((err: Error) => {
              handle.fail(log.error(err.message));
            });
          }
          return;
        }

        if (result.length > 0) appendLines(...prependBlank(result));
      } catch (err) {
        appendLines("", log.error((err as Error).message));
      }

      await refreshStats();
    },
    [pendingPrompt, appendLines, refreshStats, exit, clearScreen, activeAgent]
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
                if (result.warning) {
                  appendLines(log.raw(chalk.yellow(`  [!] ${result.warning}`)));
                }
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

  if (posScreen) {
    return (
      <Box flexDirection="column" height={termHeight} width={termWidth}>
        <PosScreen
          height={termHeight}
          width={termWidth}
          agentName={posScreen.agentName}
          onClose={() => {
            setPosScreen(null);
            appendLines(log.dim("  Positions closed."));
          }}
        />
      </Box>
    );
  }

  if (logsOpen) {
    return (
      <Box flexDirection="column" height={termHeight} width={termWidth}>
        <LogsScreen
          height={termHeight}
          width={termWidth}
          onClose={() => {
            setLogsOpen(false);
            appendLines(log.dim("  Logs closed."));
          }}
        />
      </Box>
    );
  }

  if (strategyOpen) {
    return (
      <Box flexDirection="column" height={termHeight} width={termWidth}>
        <StrategyScreen
          height={termHeight}
          width={termWidth}
          activeAgent={activeAgent}
          onClose={() => {
            setStrategyOpen(false);
            appendLines(log.dim("  Strategies closed."));
          }}
          onSaved={(msg) => appendLines(log.success(msg))}
        />
      </Box>
    );
  }

  if (scriptsScreen) {
    return (
      <Box flexDirection="column" height={termHeight} width={termWidth}>
        <ScriptsScreen
          height={termHeight}
          width={termWidth}
          agentName={scriptsScreen.agentName}
          onClose={() => {
            setScriptsScreen(null);
            appendLines(log.dim("  Scripts closed."));
          }}
          onSaved={(msg) => appendLines(log.success(msg))}
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
        onClearActiveAgent={() => {
          const was = getActiveAgent();
          if (!was) return;
          clearActiveAgent();
          appendLines(chalk.dim(`  Cleared active agent (was ${was}).`));
        }}
        confirmPrompt={pendingPrompt?.prompt ?? null}
        history={historyRef.current}
        suggestions={suggestions}
        activeAgent={activeAgent}
      />
    </Box>
  );
}
