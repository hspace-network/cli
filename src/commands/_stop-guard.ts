import { loadCliConfig, getEffectiveNetwork, getPlatformCreds } from "../services/config.service.js";
import { getOpenPosition } from "../services/positions.service.js";
import { resolveSymbol } from "../services/bybit.service.js";

export function parseMarketFromRoom(roomId: string): string {
  const [market = roomId] = roomId.split(":");
  return market;
}

export async function checkStopWarning(
  agentName: string,
  roomId: string,
): Promise<string | null> {
  const cfg = await loadCliConfig();
  const creds = getPlatformCreds(cfg, "Bybit");
  if (!creds) return null;

  const network = getEffectiveNetwork(cfg);
  const market = parseMarketFromRoom(roomId);
  let symbol: string;
  try {
    symbol = resolveSymbol(market);
  } catch {
    return null;
  }

  try {
    const pos = await getOpenPosition(symbol, network, creds);
    if (!pos) return null;
    return `${agentName} has an open ${pos.side} on ${symbol} (size ${pos.size}). Stopping the room will not close it.`;
  } catch {
    return null;
  }
}
