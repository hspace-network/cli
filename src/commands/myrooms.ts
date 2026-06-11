import chalk from "chalk";
import { getAgent } from "../services/agent.service.js";
import { walletExists } from "../services/wallet.service.js";
import { loadCliConfig } from "../services/config.service.js";
import { fetchRunsForAgent } from "../services/runs.service.js";
import { getAgentRooms, setAgentRooms } from "../services/runs.cache.js";
import { setBusy } from "../utils/busy.js";
import { log } from "../utils/logger.js";

export async function myroomsCommand(args: string[]): Promise<string[]> {
  const name = args[0];
  if (!name) {
    return [
      log.error('Usage: myrooms <agent>   (or set an active agent with "use <name>")'),
    ];
  }

  try {
    await getAgent(name);
  } catch (err) {
    return [log.error((err as Error).message)];
  }

  let rooms: string[];
  if (await walletExists(name)) {
    const cfg = await loadCliConfig();
    setBusy(`Reading ${name}'s rooms...`);
    try {
      rooms = await fetchRunsForAgent({ nodeUrl: cfg.nodeUrl, agentName: name });
      setAgentRooms(name, rooms);
    } catch (err) {
      setBusy(null);
      const cached = getAgentRooms(name);
      const out = [log.error(`Could not reach node: ${(err as Error).message}`)];
      if (cached.length > 0) {
        out.push(log.dim(`  Last known rooms: ${cached.join(", ")}`));
      }
      return out;
    }
    setBusy(null);
  } else {
    rooms = getAgentRooms(name);
  }

  if (rooms.length === 0) {
    return [
      log.blank(),
      log.raw(`  ${chalk.cyanBright(name)} is not in any room.`),
      log.blank(),
    ];
  }

  const lines = [
    log.blank(),
    log.raw(`  ${chalk.cyanBright.bold(name)} — active rooms (${rooms.length})`),
    log.blank(),
  ];
  for (const roomId of [...rooms].sort()) {
    lines.push(log.raw(`    ${chalk.green("•")} ${chalk.green(roomId)}`));
  }
  lines.push(log.blank());
  return lines;
}
