import chalk from "chalk";
import { getAgent } from "../services/agent.service.js";
import {
  loadCliConfig,
  getEffectiveNetwork,
  getPlatformCreds,
} from "../services/config.service.js";
import {
  BybitApiError,
  bybitPost,
  getInstrument,
  resolveSymbol,
} from "../services/bybit.service.js";
import { setBusy } from "../utils/busy.js";
import { log } from "../utils/logger.js";
import { formatTradeError } from "./_trade-errors.js";

export async function levCommand(args: string[]): Promise<string[]> {
  const agentName = args[0];
  const marketArg = args[1];
  const nArg = args[2];

  if (!agentName || !marketArg || !nArg) {
    return [log.error("Usage: /lev <agent> <market> <n>")];
  }

  const leverage = Number(nArg);
  if (!Number.isInteger(leverage) || leverage <= 0) {
    return [log.error(`Leverage must be a positive integer (got "${nArg}").`)];
  }

  try {
    await getAgent(agentName);
  } catch (err) {
    return [log.error((err as Error).message)];
  }
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

  if (leverage > instrument.maxLeverage) {
    setBusy(null);
    return [log.error(`${instrument.symbol} max leverage is ${instrument.maxLeverage}x.`)];
  }

  setBusy(`Setting ${leverage}x leverage on ${instrument.symbol}...`);
  try {
    await bybitPost(
      network,
      "/v5/position/set-leverage",
      {
        category: "linear",
        symbol: instrument.symbol,
        buyLeverage: String(leverage),
        sellLeverage: String(leverage),
      },
      creds,
    );
  } catch (err) {
    setBusy(null);
    // 110043 = leverage not modified (already at this value) — treat as success.
    if (err instanceof BybitApiError && err.retCode === 110043) {
      return [
        log.success(
          `${chalk.cyanBright(instrument.symbol)} leverage already ${chalk.green(`${leverage}x`)}.`,
        ),
      ];
    }
    return formatTradeError("Update failed", err, { network });
  }
  setBusy(null);

  return [
    log.success(
      `${chalk.cyanBright(instrument.symbol)} leverage set to ${chalk.green(`${leverage}x`)}.`,
    ),
  ];
}
