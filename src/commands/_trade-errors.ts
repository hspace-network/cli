import { log } from "../utils/logger.js";
import { BybitApiError } from "../services/bybit.service.js";
import type { BybitNetwork } from "../services/config.service.js";

export interface FormatTradeErrorOptions {
  /** Used to tailor hints (mainnet vs testnet). */
  network?: BybitNetwork;
}

/**
 * Translate raw Bybit V5 errors into a friendlier multi-line output.
 * Returns an array of lines ready to be appended to the CLI output.
 */
export function formatTradeError(
  prefix: string,
  err: unknown,
  opts?: FormatTradeErrorOptions,
): string[] {
  const net = opts?.network ?? "mainnet";

  if (err instanceof BybitApiError) {
    const lines = [log.error(`${prefix}: ${err.retMsg} (code ${err.retCode})`)];
    const hint = hintForCode(err.retCode, net);
    if (hint) lines.push(log.dim(`  ${hint}`));
    return lines;
  }

  const msg = err instanceof Error ? err.message : String(err);
  return [log.error(`${prefix}: ${msg}`)];
}

function hintForCode(code: number, net: BybitNetwork): string | null {
  switch (code) {
    case 10003:
      return `API key is invalid or for the wrong environment. Settings network is "${net}" — make sure this agent's key matches.`;
    case 10004:
      return `Signature error. Re-add the API key/secret for this agent with "keys <agent>".`;
    case 10005:
      return `API key lacks permission. Enable Read + Trade (Derivatives) in Bybit API management.`;
    case 10006:
    case 170005:
      return `Rate limited — slow down and try again in a moment.`;
    case 10010:
      return `Your IP is not whitelisted for this API key. Add it in Bybit API key settings or remove the IP binding.`;
    case 110004:
    case 110007:
    case 170131:
      return `Insufficient available balance. Deposit USDT or reduce the order size.`;
    case 110094:
    case 170140:
      return `Order value is below the market minimum. Increase the size.`;
    case 110040:
      return `Order would trigger liquidation. Reduce size or lower leverage.`;
    case 110043:
      return `Leverage not modified — it is already set to this value.`;
    case 10001:
      return `Invalid parameter. Check the market symbol and size.`;
    default:
      return null;
  }
}
