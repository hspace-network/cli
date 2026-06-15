import chalk from "chalk";
import { getAgent, listAgents } from "../services/agent.service.js";
import { walletExists } from "../services/wallet.service.js";
import { loadCliConfig } from "../services/config.service.js";
import { stopAgent } from "../services/socket.service.js";
import { fetchRunsForAgent } from "../services/runs.service.js";
import { removeAgentRoom, setAgentRooms } from "../services/runs.cache.js";
import { setBusy } from "../utils/busy.js";
import { log } from "../utils/logger.js";
import type { InteractiveResult } from "./index.js";
import { checkStopWarning } from "./_stop-guard.js";

export async function stopCommand(args: string[]): Promise<InteractiveResult> {
  const name = args[0];
  if (!name) {
    return {
      lines: [log.error("Usage: stop <agent> [room]   (or: stop all)")],
    };
  }

  // "stop all" with no active agent resolves to args === ["all"]. Treat it as
  // "stop every agent" unless an agent is literally named "all".
  if (name === "all" && !args[1]) {
    const agents = await listAgents();
    if (!agents.some((a) => a.name === "all")) {
      return await stopAllAgents();
    }
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

  // "stop <agent> all" (or "stop all" with an active agent) → leave every room.
  if (second === "all") {
    return await stopAllRoomsForAgent(name);
  }

  if (!second) {
    return {
      lines: [],
      openRunSelector: { mode: "stop", agentName: name },
    };
  }

  return await execStop(name, second);
}

async function execStop(name: string, roomId: string): Promise<InteractiveResult> {
  return await finishStop(name, roomId);
}

async function finishStop(name: string, roomId: string): Promise<InteractiveResult> {
  const cfg = await loadCliConfig();
  // Capture the open-position warning up front; leaving the room never closes
  // a position, so we surface it after stopping instead of blocking on a prompt.
  const warning = await checkStopWarning(name, roomId).catch(() => null);
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
  const lines = [
    log.success(`${chalk.cyanBright(name)} left ${chalk.green(roomId)}.`),
  ];
  if (warning) {
    lines.push(log.raw(chalk.yellow(`  [!] ${warning}`)));
  }
  lines.push(
    log.dim(
      `  Stop does not close any open positions. (Use "pos ${name}" to review.)`,
    ),
  );
  return { lines };
}

/**
 * Leave every room a single agent is currently running in. Validates the agent
 * and its wallet first, then pulls the live room list from the node.
 */
export async function stopAllRoomsForAgent(name: string): Promise<InteractiveResult> {
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

  const cfg = await loadCliConfig();
  setBusy(`Stopping ${name}...`);

  let rooms: string[];
  try {
    rooms = await fetchRunsForAgent({ nodeUrl: cfg.nodeUrl, agentName: name });
    setAgentRooms(name, rooms);
  } catch (err) {
    setBusy(null);
    return {
      lines: [log.error(`Could not read rooms for ${name}: ${(err as Error).message}`)],
    };
  }

  if (rooms.length === 0) {
    setBusy(null);
    return { lines: [log.dim(`${name} is not in any room.`)] };
  }

  const stopped: string[] = [];
  const failed: string[] = [];
  for (const roomId of rooms) {
    try {
      await stopAgent({ nodeUrl: cfg.nodeUrl, agentName: name, roomId });
      removeAgentRoom(name, roomId);
      stopped.push(roomId);
    } catch (err) {
      failed.push(`${roomId} (${(err as Error).message})`);
    }
  }
  setBusy(null);

  const lines: string[] = [];
  if (stopped.length > 0) {
    lines.push(
      log.success(
        `${chalk.cyanBright(name)} left ${stopped.length} room(s): ${chalk.green(stopped.join(", "))}.`,
      ),
    );
  }
  for (const f of failed) {
    lines.push(log.error(`  Failed to leave ${f}`));
  }
  lines.push(
    log.dim(`  Stop does not close any open positions. (Use "pos ${name}" to review.)`),
  );
  return { lines };
}

/**
 * Leave every room for every local agent. Used by "stop all" / "stopall" when
 * no agent is active.
 */
export async function stopAllAgents(): Promise<InteractiveResult> {
  const cfg = await loadCliConfig();
  const agents = await listAgents();
  setBusy("Stopping all agents...");

  const lines: string[] = [];
  let totalStopped = 0;

  for (const agent of agents) {
    if (!(await walletExists(agent.name))) continue;

    let rooms: string[];
    try {
      rooms = await fetchRunsForAgent({ nodeUrl: cfg.nodeUrl, agentName: agent.name });
      setAgentRooms(agent.name, rooms);
    } catch {
      continue;
    }
    if (rooms.length === 0) continue;

    for (const roomId of rooms) {
      try {
        await stopAgent({ nodeUrl: cfg.nodeUrl, agentName: agent.name, roomId });
        removeAgentRoom(agent.name, roomId);
        totalStopped++;
        lines.push(log.dim(`  ${chalk.cyanBright(agent.name)} left ${chalk.green(roomId)}`));
      } catch (err) {
        lines.push(log.error(`  ${agent.name}: failed to leave ${roomId} (${(err as Error).message})`));
      }
    }
  }
  setBusy(null);

  if (totalStopped === 0 && lines.length === 0) {
    return { lines: [log.dim("No agents are in any room.")] };
  }

  return {
    lines: [
      log.success(`Stopped trading on ${totalStopped} room(s) across all agents.`),
      ...lines,
      log.dim("  Stop does not close any open positions."),
    ],
  };
}
