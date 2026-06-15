import { createCommand } from "./create.js";
import { listCommand } from "./list.js";
import { infoCommand } from "./info.js";
import { strategyCommand } from "./strategy.js";
import { setStrategyCommand } from "./set-strategy.js";
import { deleteCommand } from "./delete.js";
import { helpCommand } from "./help.js";
import { nodeCommand } from "./node.js";
import { roomsCommand } from "./rooms.js";
import { settingsCommand } from "./settings.js";
import { askCommand } from "./ask.js";
import { runCommand } from "./run.js";
import { stopCommand } from "./stop.js";
import { stopallCommand } from "./stopall.js";
import { myroomsCommand } from "./myrooms.js";
import { useCommand, unuseCommand } from "./use.js";
import { longCommand } from "./long.js";
import { shortCommand } from "./short.js";
import { closeCommand } from "./close.js";
import { posCommand } from "./pos.js";
import { cancelCommand } from "./cancel.js";
import { levCommand } from "./lev.js";
import { capCommand } from "./cap.js";
import { historyCommand } from "./history.js";
import { logsCommand } from "./logs.js";
import { scoreCommand } from "./score.js";
import { balanceCommand } from "./balance.js";
import { depositCommand } from "./deposit.js";
import { withdrawCommand } from "./withdraw.js";
import { limitsCommand } from "./limits.js";
import { codeCommand } from "./code.js";

export interface PendingPrompt {
  prompt: string;
  onResponse: (input: string) => Promise<{ lines: string[]; nextPrompt?: PendingPrompt }>;
}

export interface StreamHandle {
  appendToken: (chunk: string) => void;
  /** Show an animated spinner with a label in the busy row (null clears it). */
  setStatus: (label: string | null) => void;
  finalize: (extraLines?: string[]) => void;
  fail: (errorLine: string) => void;
}

export interface StreamSession {
  prefixLine: string;
  start: (handle: StreamHandle) => Promise<void>;
}

export interface RunSelectorOpen {
  mode: "run" | "stop";
  agentName: string;
  initialMarketId?: string;
}

export interface PosScreenOpen {
  agentName: string;
}

export interface ScriptsScreenOpen {
  agentName: string;
}

export interface InteractiveResult {
  lines: string[];
  prompt?: PendingPrompt;
  openEditor?: { filePath: string; fileName: string };
  openSettings?: true;
  openRunSelector?: RunSelectorOpen;
  openPosScreen?: PosScreenOpen;
  openLogs?: true;
  openStrategyScreen?: true;
  openScriptsScreen?: ScriptsScreenOpen;
  stream?: StreamSession;
}

export type SimpleResult = string[];
export type CommandResult = SimpleResult | InteractiveResult;

export type CommandHandler = (args: string[]) => Promise<CommandResult>;

const commands: Record<string, CommandHandler> = {
  create: createCommand,
  list: () => listCommand(),
  info: infoCommand,
  strategy: () => strategyCommand(),
  "set strategy": setStrategyCommand,
  delete: deleteCommand,
  node: nodeCommand,
  rooms: () => roomsCommand(),
  logs: () => logsCommand(),
  settings: () => settingsCommand(),
  help: () => helpCommand(),
  run: runCommand,
  stop: stopCommand,
  stopall: () => stopallCommand(),
  myrooms: myroomsCommand,
  use: useCommand,
  unuse: () => unuseCommand(),
  back: () => unuseCommand(),
  cap: capCommand,
  history: historyCommand,
  "/ask": askCommand,
  "/long": longCommand,
  "/short": shortCommand,
  "/close": closeCommand,
  pos: posCommand,
  "/pos": posCommand,
  "/cancel": cancelCommand,
  "/lev": levCommand,
  score: scoreCommand,
  balance: balanceCommand,
  deposit: depositCommand,
  withdraw: withdrawCommand,
  limits: limitsCommand,
  code: codeCommand,
};

export function getCommand(name: string): CommandHandler | undefined {
  return commands[name];
}

export function getCommandNames(): string[] {
  return Object.keys(commands);
}

export function isInteractiveResult(result: CommandResult): result is InteractiveResult {
  return typeof result === "object" && !Array.isArray(result);
}
