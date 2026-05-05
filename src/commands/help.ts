import chalk from "chalk";
import { log } from "../utils/logger.js";

interface CommandGroup {
  title: string;
  commands: [string, string][];
}

const GROUPS: CommandGroup[] = [
  {
    title: "Agents",
    commands: [
      ["create <name>", "Create a new agent"],
      ["list", "List all agents"],
      ["info <name>", "Show agent details"],
      ["edit <name>", "Open the agent strategy in the built-in editor"],
      ["delete <name>", "Delete an agent"],
    ],
  },
  {
    title: "AI",
    commands: [["/ask <question>", "Ask the configured LLM (uses agent strategy if available)"]],
  },
  {
    title: "Trading",
    commands: [
      ["run <name> [market] [interval]", "Join an agent to a market room at a pace"],
      ["stop <name> [room]", "Leave one of the agent's active rooms"],
    ],
  },
  {
    title: "Node",
    commands: [
      ["node", "Show current node URL and status"],
      ["node set <url>", "Point CLI at a node and refresh config"],
      ["rooms", "List rooms delivered by the connected node"],
    ],
  },
  {
    title: "System",
    commands: [
      ["settings", "Open interactive settings (provider, model, API key, platform)"],
      ["dir", "Show agents directory path"],
      ["clear", "Clear the output pane"],
      ["help", "Show this help message"],
      ["exit", "Exit the CLI"],
    ],
  },
];

const CMD_COL = 32;

const SHORTCUTS: [string, string][] = [
  ["PageUp / PageDown", "Scroll output by 5 lines"],
  ["Shift+Up / Shift+Down", "Scroll output by 1 line"],
  ["Ctrl+U / Ctrl+D", "Scroll output by 10 lines"],
  ["Ctrl+G", "Jump back to live output"],
  ["Ctrl+L", "Clear the output pane"],
  ["Ctrl+C", "Exit the CLI"],
  ["Tab", "Autocomplete command"],
  ["Up / Down", "Browse command history"],
];

const SHORTCUT_COL = 24;

export async function helpCommand(): Promise<string[]> {
  const lines: string[] = [
    log.blank(),
    log.heading("  Available Commands"),
  ];

  for (const group of GROUPS) {
    lines.push(log.blank());
    lines.push("  " + chalk.dim(group.title));
    for (const [cmd, desc] of group.commands) {
      lines.push("    " + chalk.cyan.bold(cmd.padEnd(CMD_COL)) + " " + desc);
    }
  }

  lines.push(log.blank());
  lines.push(log.heading("  Shortcuts"));
  lines.push(log.blank());
  for (const [keys, desc] of SHORTCUTS) {
    lines.push("    " + chalk.magenta.bold(keys.padEnd(SHORTCUT_COL)) + " " + desc);
  }

  lines.push(log.blank());
  return lines;
}
