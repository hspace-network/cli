import chalk from "chalk";
import { getAgent } from "../services/agent.service.js";
import {
  loadCliConfig,
  getEffectiveNetwork,
  getPlatformCreds,
} from "../services/config.service.js";
import {
  bybitPost,
  getInstrument,
  resolveSymbol,
} from "../services/bybit.service.js";
import { setBusy } from "../utils/busy.js";
import { log } from "../utils/logger.js";
import { formatTradeError } from "./_trade-errors.js";
import { blockIfAvantis } from "./_venue-guard.js";

export async function cancelCommand(args: string[]): Promise<string[]> {
  const agentName = args[0];
  const marketArg = args[1];
  const idArg = args[2];

  if (!agentName || !marketArg || !idArg) {
    return [log.error("Usage: /cancel <agent> <market> <orderId|orderLinkId>")];
  }

  try {
    await getAgent(agentName);
  } catch (err) {
    return [log.error((err as Error).message)];
  }

  const blocked = await blockIfAvantis(agentName, "/cancel");
  if (blocked) return blocked;

  const cfg = await loadCliConfig();
  const creds = getPlatformCreds(cfg, "Bybit");
  if (!creds) {
    return [log.error('Set your Bybit API key in settings ("settings" → Platform).')];
  }
  const network = getEffectiveNetwork(cfg);

  setBusy("Looking up market...");
  let instrument;
  try {
    instrument = await getInstrument(resolveSymbol(marketArg), network);
  } catch (err) {
    setBusy(null);
    return formatTradeError("Failed to load market", err, { network });
  }

  const body: Record<string, unknown> = {
    category: "linear",
    symbol: instrument.symbol,
  };
  // hspace order link ids carry our prefix; everything else is treated as orderId.
  if (idArg.startsWith("hspace-")) {
    body.orderLinkId = idArg;
  } else {
    body.orderId = idArg;
  }

  setBusy(`Cancelling on ${instrument.symbol}...`);
  try {
    await bybitPost(network, "/v5/order/cancel", body, creds);
  } catch (err) {
    setBusy(null);
    return formatTradeError("Cancel failed", err, { network });
  }
  setBusy(null);

  return [
    log.success(`Cancelled ${chalk.cyanBright(instrument.symbol)} order ${chalk.dim(idArg)}.`),
  ];
}
