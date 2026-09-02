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
      ["use <name>", "Set an active agent"],
      ["back / unuse", "Clear the active agent (Esc when input is empty)"],
      ["create <name>", "Create a new agent"],
      ["list", "List all agents"],
      ["info <name>", "Show agent details"],
      ["strategy", "Browse and edit strategies (builtin + saved)"],
      ["set strategy <name>", "Assign a strategy (or: set strategy <agent> <name>)"],
      ["cap <name> [usd]", "Show or set the agent's per-trade spending cap"],
      ["limits <name> [field] [val]", "Risk limits (leverage, NOTR, SL/TP, etc.)"],
      ["history <name>", "Show the agent's discussion decisions"],
      ["delete <name>", "Delete an agent"],
      ["score [name]", "One agent's excellence score, or all your agents if omitted"],
    ],
  },
  {
    title: "Balance",
    commands: [
      ["balance <agent>", "Wallet + Bybit USDT trading balance"],
      ["deposit <agent> <amt> [coin]", "Wallet → Bybit; auto-routes to unified USDT (MNT|USDT)"],
      ["withdraw <agent> <amt>", "Withdraw MNT from Bybit → agent wallet (confirm)"],
    ],
  },
  {
    title: "AI",
    commands: [["/ask <question>", "Ask the configured LLM (uses agent strategy if available)"]],
  },
  {
    title: "Agentic Trading",
    commands: [
      ["run <name> [market] [interval]", "Join an agent to a market room at a pace"],
      ["auto <name> <market:interval>", "Run an agent in the background (survives CLI exit)"],
      ["auto [stop <name>]", "List background agents, or stop one"],
      ["myrooms [name]", "Show the rooms an agent is currently in"],
      ["stop <name> [room]", "Leave one of the agent's active rooms"],
      ["stop all", "Leave every room for the active agent (all agents if none)"],
    ],
  },
  {
    title: "Sandbox (dev/ops)",
    commands: [
      ["code <agent> <prompt>", "Reason with the code sandbox (ccxt + TA), author/run scripts"],
      ["code <agent> scripts", "List the agent's saved sandbox scripts"],
      ["code <agent> run <name>", "Run a saved script; read/rm to inspect or delete"],
      ["code <agent> install <pkg>", "Install an allowlisted package into the sandbox"],
      ["code <agent> dry-run <mkt>:<int>", "Simulate a whole session locally (no node, no trade)"],
    ],
  },
  {
    title: "Manual Trading",
    commands: [
      ["/long <name> <market> <size>", "Open a long [@px] [sl=px] [tp=px]"],
      ["/short <name> <market> <size>", "Open a short [@px] [sl=px] [tp=px]"],
      ["/close <name> <market> [size]", "Close (reduce-only)"],
      ["pos <name>", "Live positions table (Esc to close)"],
      ["/cancel <name> <market> <id>", "Cancel by oid or cloid"],
      ["/lev <name> <market> <n>", "Set cross leverage"],
    ],
  },
  {
    title: "Node",
    commands: [
      ["node", "Show current node URL and status"],
      ["node set <url>", "Point CLI at a node and refresh config"],
      ["rooms", "List rooms delivered by the connected node"],
      ["logs", "Open the live agent discussion chat (Esc to close)"],
    ],
  },
  {
    title: "System",
    commands: [
      ["settings", "Open interactive settings (provider, model, API key, network, chain)"],
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
