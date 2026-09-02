import chalk from "chalk";
import { getAgent } from "../services/agent.service.js";
import {
  loadCliConfig,
  getEffectiveNetwork,
  getPlatformCreds,
} from "../services/config.service.js";
import {
  bybitGet,
  bybitPost,
  formatQty,
  getInstrument,
  mintOrderLinkId,
  resolveSymbol,
} from "../services/bybit.service.js";
import { setBusy } from "../utils/busy.js";
import { log } from "../utils/logger.js";
import { formatTradeError } from "./_trade-errors.js";
import { blockIfAvantis } from "./_venue-guard.js";

interface PositionListResult {
  list?: Array<{ symbol: string; side: string; size: string }>;
}

export async function closeCommand(args: string[]): Promise<string[]> {
  const agentName = args[0];
  const marketArg = args[1];
  const sizeArg = args[2];

  if (!agentName || !marketArg) {
    return [log.error("Usage: /close <agent> <market> [size]")];
  }

  try {
    await getAgent(agentName);
  } catch (err) {
    return [log.error((err as Error).message)];
  }

  const blocked = await blockIfAvantis(agentName, "/close");
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

  setBusy(`Reading ${instrument.symbol} position...`);
  let positions: PositionListResult;
  try {
    positions = await bybitGet<PositionListResult>(
      network,
      "/v5/position/list",
      { category: "linear", symbol: instrument.symbol },
      creds,
    );
  } catch (err) {
    setBusy(null);
    return formatTradeError("Failed to load position", err, { network });
  }

  const position = positions.list?.find(
    (p) => p.symbol === instrument.symbol && Number(p.size) > 0,
  );
  if (!position) {
    setBusy(null);
    return [log.error(`No open position on ${instrument.symbol}.`)];
  }

  const openSize = Number(position.size);
  const positionIsLong = position.side === "Buy";

  let closeSize = openSize;
  if (sizeArg) {
    const requested = Number(sizeArg);
    if (!Number.isFinite(requested) || requested <= 0) {
      setBusy(null);
      return [log.error(`Invalid size "${sizeArg}".`)];
    }
    if (requested > openSize + 1e-12) {
      setBusy(null);
      return [log.error(`Size ${requested} exceeds open position ${openSize}.`)];
    }
    closeSize = requested;
  }

  const body: Record<string, unknown> = {
    category: "linear",
    symbol: instrument.symbol,
    side: positionIsLong ? "Sell" : "Buy",
    orderType: "Market",
    qty: formatQty(closeSize, instrument),
    reduceOnly: true,
    orderLinkId: mintOrderLinkId(),
  };

  setBusy(`Closing ${instrument.symbol}...`);
  let result: { orderId?: string };
  try {
    result = await bybitPost<{ orderId?: string }>(
      network,
      "/v5/order/create",
      body,
      creds,
    );
  } catch (err) {
    setBusy(null);
    return formatTradeError("Close failed", err, { network });
  }
  setBusy(null);

  return [
    log.success(
      `closed ${chalk.cyanBright(instrument.symbol)} ${chalk.white(formatQty(closeSize, instrument))} (market)  ${chalk.dim(`(id ${result.orderId ?? "?"})`)}`,
    ),
  ];
}
