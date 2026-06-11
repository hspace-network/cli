import { getAgent } from "../services/agent.service.js";
import { loadCliConfig, getPlatformCreds } from "../services/config.service.js";
import { log } from "../utils/logger.js";
import type { InteractiveResult } from "./index.js";

export async function posCommand(args: string[]): Promise<InteractiveResult> {
  const agentName = args[0];
  if (!agentName) {
    return { lines: [log.error("Usage: pos <agent>")] };
  }

  try {
    await getAgent(agentName);
  } catch (err) {
    return { lines: [log.error((err as Error).message)] };
  }

  const cfg = await loadCliConfig();
  if (!getPlatformCreds(cfg, "Bybit")) {
    return {
      lines: [
        log.error('Set your Bybit API key in settings ("settings" → Platform).'),
      ],
    };
  }

  return {
    lines: [],
    openPosScreen: { agentName },
  };
}
