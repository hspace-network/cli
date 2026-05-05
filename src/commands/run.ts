import chalk from "chalk";
import { getAgent } from "../services/agent.service.js";
import { walletExists } from "../services/wallet.service.js";
import {
  loadCliConfig,
  getCachedNodeConfig,
} from "../services/config.service.js";
import { runAgent } from "../services/socket.service.js";
import { addAgentRoom } from "../services/runs.cache.js";
import { setBusy } from "../utils/busy.js";
import { log } from "../utils/logger.js";
import type { InteractiveResult } from "./index.js";

function buildRoomId(market: string, interval: string): string {
  return `${market}:${interval}`;
}

export async function runCommand(args: string[]): Promise<InteractiveResult> {
  const name = args[0];
  if (!name) {
    return {
      lines: [log.error("Usage: run <agent> [market] [interval]")],
    };
  }

  try {
    await getAgent(name);
  } catch (err) {
    return { lines: [log.error((err as Error).message)] };
  }

  if (!(await walletExists(name))) {
    return {
      lines: [
        log.error(
          `Cannot run "${name}" — no wallet on disk. Re-create or import the agent first.`,
        ),
      ],
    };
  }

  const cached = getCachedNodeConfig();
  if (!cached) {
    return {
      lines: [
        log.error("Not connected to a node."),
        log.dim('  Run "node set <url>" first.'),
      ],
    };
  }

  const second = args[1];
  const third = args[2];

  if (!second) {
    return {
      lines: [],
      openRunSelector: { mode: "run", agentName: name },
    };
  }

  const directRoom = cached.rooms.find((r) => r.id === second);
  if (directRoom) {
    return await execRun(name, directRoom.id);
  }

  const market = cached.markets.find((m) => m.id === second);
  if (!market) {
    return {
      lines: [
        log.error(`Unknown market or room "${second}".`),
        log.dim('  Run "rooms" to list available markets.'),
      ],
    };
  }

  if (!third) {
    return {
      lines: [],
      openRunSelector: {
        mode: "run",
        agentName: name,
        initialMarketId: market.id,
      },
    };
  }

  if (!cached.intervals.includes(third)) {
    return {
      lines: [
        log.error(`Unknown interval "${third}".`),
        log.dim(`  Allowed: ${cached.intervals.join(", ")}`),
      ],
    };
  }

  const roomId = buildRoomId(market.id, third);
  const knownRoom = cached.rooms.find((r) => r.id === roomId);
  if (!knownRoom) {
    return {
      lines: [log.error(`Room "${roomId}" is not configured on the node.`)],
    };
  }
  return await execRun(name, knownRoom.id);
}

async function execRun(name: string, roomId: string): Promise<InteractiveResult> {
  const cfg = await loadCliConfig();
  setBusy(`Joining ${roomId}...`);
  try {
    await runAgent({ nodeUrl: cfg.nodeUrl, agentName: name, roomId });
  } catch (err) {
    setBusy(null);
    return {
      lines: [
        log.error(`Failed to join ${roomId}: ${(err as Error).message}`),
      ],
    };
  }
  setBusy(null);
  addAgentRoom(name, roomId);
  return {
    lines: [
      log.success(
        `${chalk.cyanBright(name)} joined ${chalk.green(roomId)}.`,
      ),
    ],
  };
}
