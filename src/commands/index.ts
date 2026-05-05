import { createCommand } from "./create.js";
import { listCommand } from "./list.js";
import { infoCommand } from "./info.js";
import { editCommand } from "./edit.js";
import { deleteCommand } from "./delete.js";
import { helpCommand } from "./help.js";
import { nodeCommand } from "./node.js";
import { roomsCommand } from "./rooms.js";
import { settingsCommand } from "./settings.js";
import { askCommand } from "./ask.js";
import { runCommand } from "./run.js";
import { stopCommand } from "./stop.js";

export interface PendingPrompt {
  prompt: string;
  onResponse: (input: string) => Promise<{ lines: string[]; nextPrompt?: PendingPrompt }>;
}

export interface StreamHandle {
  appendToken: (chunk: string) => void;
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

export interface InteractiveResult {
  lines: string[];
  prompt?: PendingPrompt;
  openEditor?: { filePath: string; fileName: string };
  openSettings?: true;
  openRunSelector?: RunSelectorOpen;
  stream?: StreamSession;
}

export type SimpleResult = string[];
export type CommandResult = SimpleResult | InteractiveResult;

export type CommandHandler = (args: string[]) => Promise<CommandResult>;

const commands: Record<string, CommandHandler> = {
  create: createCommand,
  list: () => listCommand(),
  info: infoCommand,
  edit: editCommand,
  delete: deleteCommand,
  node: nodeCommand,
  rooms: () => roomsCommand(),
  settings: () => settingsCommand(),
  help: () => helpCommand(),
  run: runCommand,
  stop: stopCommand,
  "/ask": askCommand,
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
