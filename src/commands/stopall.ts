import { getActiveAgent } from "../services/active-agent.service.js";
import { stopAllRoomsForAgent, stopAllAgents } from "./stop.js";
import type { InteractiveResult } from "./index.js";

export async function stopallCommand(): Promise<InteractiveResult> {
  const active = getActiveAgent();
  if (active) {
    return await stopAllRoomsForAgent(active);
  }
  return await stopAllAgents();
}
