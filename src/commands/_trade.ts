import chalk from "chalk";
import { getAgent } from "../services/agent.service.js";
import {
  loadCliConfig,
  getEffectiveNetwork,
  getEffectiveChain,
  validateChainNetworkPair,
  getPlatformCreds,
} from "../services/config.service.js";
import {
  bybitPost,
  fetchLastPrice,
  formatPrice,
  formatQty,
  getInstrument,
  mintOrderLinkId,
  resolveSymbol,
  type BybitInstrument,
} from "../services/bybit.service.js";
import { parseOrderArgs } from "../cli/order-args.js";
import { setBusy } from "../utils/busy.js";
import { log } from "../utils/logger.js";
import { formatTradeError } from "./_trade-errors.js";
import { blockIfAvantis } from "./_venue-guard.js";

interface CreateOrderResult {
  orderId?: string;
  orderLinkId?: string;
}

export async function executeOpen(
  side: "long" | "short",
  args: string[],
): Promise<string[]> {
  const agentName = args[0];
  const marketArg = args[1];
  const tail = args.slice(2);

  if (!agentName || !marketArg || tail.length === 0) {
    return [
      log.error(
        `Usage: /${side} <agent> <market> <size> [@price] [sl=price] [tp=price]`,
      ),
    ];
  }

  try {
    await getAgent(agentName);
  } catch (err) {
    return [log.error((err as Error).message)];
  }

  const blocked = await blockIfAvantis(agentName, `/${side}`);
  if (blocked) return blocked;

  const cfg = await loadCliConfig();
  const creds = getPlatformCreds(cfg, "Bybit");
  if (!creds) {
    return [log.error('Set your Bybit API key in settings ("settings" → Platform).')];
  }
  const network = getEffectiveNetwork(cfg);
  const chainErr = validateChainNetworkPair(getEffectiveChain(cfg), network);
  if (chainErr) {
    return [log.error(chainErr)];
  }

  let parsed;
  try {
    parsed = parseOrderArgs(tail);
  } catch (err) {
    return [log.error((err as Error).message)];
  }

  setBusy(`Preparing ${side} order...`);

  let instrument: BybitInstrument;
  try {
    const symbol = resolveSymbol(marketArg);
    instrument = await getInstrument(symbol, network);
  } catch (err) {
    setBusy(null);
    return formatTradeError("Order failed", err, { network });
  }

  const isBuy = side === "long";

  let referencePx: number;
  let isMarket: boolean;
  if (parsed.limitPx !== undefined) {
    referencePx = parsed.limitPx;
    isMarket = false;
  } else {
    setBusy(`Fetching ${instrument.symbol} price...`);
    const last = await fetchLastPrice(instrument.symbol, network).catch(() => null);
    if (last === null) {
      setBusy(null);
      return [
        log.error(
          `Could not fetch a price for ${instrument.symbol}. Try again or pass @price.`,
        ),
      ];
    }
    referencePx = last;
    isMarket = true;
  }

  const notional = referencePx * parsed.size;
  if (notional < instrument.minNotional) {
    setBusy(null);
    return [
      log.error(
        `Order value ~$${notional.toFixed(2)} is below the $${instrument.minNotional} minimum for ${instrument.symbol}.`,
      ),
    ];
  }

  const qtyStr = formatQty(parsed.size, instrument);

  const body: Record<string, unknown> = {
    category: "linear",
    symbol: instrument.symbol,
    side: isBuy ? "Buy" : "Sell",
    orderType: isMarket ? "Market" : "Limit",
    qty: qtyStr,
    reduceOnly: false,
    orderLinkId: mintOrderLinkId(),
  };
  if (!isMarket) {
    body.price = formatPrice(referencePx, instrument);
    body.timeInForce = "GTC";
  }
  if (parsed.sl !== undefined || parsed.tp !== undefined) {
    body.tpslMode = "Full";
    if (parsed.tp !== undefined) {
      body.takeProfit = formatPrice(parsed.tp, instrument);
      body.tpTriggerBy = "MarkPrice";
    }
    if (parsed.sl !== undefined) {
      body.stopLoss = formatPrice(parsed.sl, instrument);
      body.slTriggerBy = "MarkPrice";
    }
  }

  setBusy(`Submitting ${side} on ${instrument.symbol}...`);
  let result: CreateOrderResult;
  try {
    result = await bybitPost<CreateOrderResult>(
      network,
      "/v5/order/create",
      body,
      creds,
    );
  } catch (err) {
    setBusy(null);
    return formatTradeError("Order failed", err, { network });
  }
  setBusy(null);

  const lines: string[] = [];
  const priceLabel = isMarket
    ? "market"
    : chalk.green(formatPrice(referencePx, instrument));
  lines.push(
    log.success(
      `${side} ${chalk.cyanBright(instrument.symbol)} ${chalk.white(qtyStr)} @ ${priceLabel}  ${chalk.dim(`(id ${result.orderId ?? "?"})`)}`,
    ),
  );
  if (parsed.tp !== undefined) {
    lines.push(log.dim(`  tp @ ${formatPrice(parsed.tp, instrument)}`));
  }
  if (parsed.sl !== undefined) {
    lines.push(log.dim(`  sl @ ${formatPrice(parsed.sl, instrument)}`));
  }
  return lines;
}
