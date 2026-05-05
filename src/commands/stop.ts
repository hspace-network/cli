import chalk from "chalk";
import { getAgent } from "../services/agent.service.js";
import { walletExists } from "../services/wallet.service.js";
import { loadCliConfig } from "../services/config.service.js";
import { stopAgent } from "../services/socket.service.js";
import { removeAgentRoom } from "../services/runs.cache.js";
import { setBusy } from "../utils/busy.js";
import { log } from "../utils/logger.js";
import type { InteractiveResult } from "./index.js";

export async function stopCommand(args: string[]): Promise<InteractiveResult> {
  const name = args[0];
  if (!name) {
    return {
      lines: [log.error("Usage: stop <agent> [room]")],
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
          `Cannot stop "${name}" — no wallet on disk. Re-create or import the agent first.`,
        ),
      ],
    };
  }

  const second = args[1];
  if (!second) {
    return {
      lines: [],
      openRunSelector: { mode: "stop", agentName: name },
    };
  }

  return await execStop(name, second);
}

async function execStop(name: string, roomId: string): Promise<InteractiveResult> {
  const cfg = await loadCliConfig();
  setBusy(`Leaving ${roomId}...`);
  try {
    await stopAgent({ nodeUrl: cfg.nodeUrl, agentName: name, roomId });
  } catch (err) {
    setBusy(null);
    return {
      lines: [
        log.error(`Failed to leave ${roomId}: ${(err as Error).message}`),
      ],
    };
  }
  setBusy(null);
  removeAgentRoom(name, roomId);
  return {
    lines: [
      log.success(`${chalk.cyanBright(name)} left ${chalk.green(roomId)}.`),
      log.dim(
        `  Stop does not close any open positions. (Use "pos ${name}" once positions land.)`,
      ),
    ],
  };
}
