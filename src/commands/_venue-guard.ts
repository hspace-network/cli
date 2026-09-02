import { getAgent } from "../services/agent.service.js";
import { log } from "../utils/logger.js";

/* Manual trade commands still target Bybit, so block them for Avantis agents,
   which trade through discussion rooms instead. */
export async function blockIfAvantis(agentName: string, verb: string): Promise<string[] | null> {
  if (!agentName) return null;
  let cfg;
  try {
    cfg = await getAgent(agentName);
  } catch {
    return null;
  }
  if (cfg.platform === "Avantis") {
    return [
      log.error(
        `${agentName} trades on Avantis — manual ${verb} is Bybit-only for now. Avantis agents trade via discussion rooms ("run ${agentName}").`,
      ),
    ];
  }
  return null;
}
