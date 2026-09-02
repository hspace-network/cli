import { getAddress, type Hex } from "viem";
import {
  getOpenPosition,
  closePosition,
  openMarketNotional,
  reducePosition,
  setPositionStops,
  getSymbolLeverage,
  fetchPositionSnapshot,
  type OpenPosition,
  type OpenResult,
  type CloseResult,
  type PositionSnapshot,
  type PositionSide,
} from "./positions.service.js";
import { getInstrument, fetchLastPrice, type BybitInstrument, type BybitCreds } from "./bybit.service.js";
import type { BybitNetwork } from "./config.service.js";
import type { AgentConfig } from "./agent.service.js";
import { loadWallet } from "./wallet.service.js";
import {
  resolvePair,
  approveUsdcIfNeeded,
  buildOpen,
  buildClose,
  sendBuilt,
  waitForFill,
  readTrades,
  getPrice,
  type AvantisNetwork,
} from "./avantis.service.js";

export interface StopResult {
  requested: boolean;
  set: boolean;
  error?: string;
}

export interface StopArgs {
  symbol: string;
  side: PositionSide;
  entryPrice: number;
  slPct?: number;
  tpPct?: number;
}

/* One execution venue for an agent. reconcile and the manual trade commands call
   these methods; the target-notional netting logic stays venue-agnostic. */
export interface TradingVenue {
  id: "Bybit" | "Avantis";
  getOpenPosition(symbol: string): Promise<OpenPosition | null>;
  openMarketNotional(symbol: string, side: PositionSide, usd: number): Promise<OpenResult>;
  closePosition(symbol: string): Promise<CloseResult | null>;
  reducePosition(symbol: string, qty: number): Promise<CloseResult | null>;
  setPositionStops(args: StopArgs): Promise<StopResult>;
  getSymbolLeverage(symbol: string): Promise<number | null>;
  fetchPositionSnapshot(symbol: string): Promise<PositionSnapshot | null>;
  getInstrument(symbol: string): Promise<BybitInstrument>;
  fetchLastPrice(symbol: string): Promise<number | null>;
}

export function clampLeverage(desired: number, min: number, max: number): number {
  if (!Number.isFinite(desired) || desired <= 0) return min;
  return Math.max(min, Math.min(desired, max));
}

export function collateralForNotional(usd: number, leverage: number): number {
  return Math.round((usd / leverage) * 100) / 100;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function bybitVenue(network: BybitNetwork, creds: BybitCreds): TradingVenue {
  async function waitForFill(symbol: string, side: PositionSide): Promise<OpenPosition | null> {
    for (let i = 0; i < 5; i += 1) {
      const pos = await getOpenPosition(symbol, network, creds);
      if (pos && pos.side === side && pos.size > 0 && pos.avgPrice > 0) return pos;
      if (i < 4) await sleep(400);
    }
    return null;
  }

  return {
    id: "Bybit",
    getOpenPosition: (symbol) => getOpenPosition(symbol, network, creds),
    openMarketNotional: (symbol, side, usd) => openMarketNotional(symbol, side, usd, network, creds),
    closePosition: (symbol) => closePosition(symbol, network, creds),
    reducePosition: (symbol, qty) => reducePosition(symbol, qty, network, creds),
    getSymbolLeverage: (symbol) => getSymbolLeverage(symbol, network, creds),
    fetchPositionSnapshot: (symbol) => fetchPositionSnapshot(symbol, network, creds),
    getInstrument: (symbol) => getInstrument(symbol, network),
    fetchLastPrice: (symbol) => fetchLastPrice(symbol, network),
    async setPositionStops(args) {
      const requested = args.slPct !== undefined || args.tpPct !== undefined;
      if (!requested) return { requested: false, set: false };
      const filled = await waitForFill(args.symbol, args.side);
      const entryPrice = filled?.avgPrice ?? args.entryPrice;
      let lastErr = "";
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          await setPositionStops({ symbol: args.symbol, side: args.side, entryPrice, slPct: args.slPct, tpPct: args.tpPct, network, creds });
          return { requested: true, set: true };
        } catch (err) {
          lastErr = err instanceof Error ? err.message : String(err);
          if (attempt < 2) await sleep(400);
        }
      }
      return { requested: true, set: false, error: lastErr || "unknown error" };
    },
  };
}

const DEFAULT_AVANTIS_LEVERAGE = 2;

export function avantisVenue(network: AvantisNetwork, privateKey: Hex, trader: Hex, agentCfg: AgentConfig): TradingVenue {
  async function tradeFor(symbol: string) {
    const pair = await resolvePair(network, symbol);
    const trades = await readTrades(network, trader);
    return { pair, trade: trades.find((t) => t.pairIndex === pair.index) ?? null };
  }

  return {
    id: "Avantis",

    async getOpenPosition(symbol) {
      const { trade } = await tradeFor(symbol);
      if (!trade || trade.openPrice <= 0) return null;
      return {
        symbol,
        side: trade.side,
        size: (trade.collateralUsdc * trade.leverage) / trade.openPrice,
        avgPrice: trade.openPrice,
      };
    },

    async fetchPositionSnapshot(symbol) {
      const { trade } = await tradeFor(symbol);
      if (!trade) return null;
      const size = trade.openPrice > 0 ? (trade.collateralUsdc * trade.leverage) / trade.openPrice : 0;
      return {
        symbol,
        side: trade.side === "long" ? "LONG" : "SHORT",
        size: String(size),
        entry: String(trade.openPrice),
        mark: String(trade.openPrice),
        pnl: trade.pnlUsd,
      };
    },

    async getSymbolLeverage(symbol) {
      const { trade } = await tradeFor(symbol);
      return trade?.leverage ?? agentCfg.avantisLeverage ?? null;
    },

    fetchLastPrice: async (symbol) => {
      const pair = await resolvePair(network, symbol);
      return getPrice(network, pair.index, trader);
    },

    async getInstrument(symbol) {
      const pair = await resolvePair(network, symbol);
      return { symbol, tickSize: 0.01, qtyStep: 0, minOrderQty: 0, minNotional: pair.minPositionUsdc, maxLeverage: pair.maxLeverage };
    },

    async openMarketNotional(symbol, side, usd) {
      const pair = await resolvePair(network, symbol);
      const leverage = clampLeverage(
        agentCfg.avantisLeverage ?? DEFAULT_AVANTIS_LEVERAGE,
        pair.minLeverage,
        Math.min(pair.maxLeverage, agentCfg.maxLeverage ?? pair.maxLeverage),
      );
      if (usd < pair.minPositionUsdc) {
        throw new Error(`stake $${usd.toFixed(2)} is below the $${pair.minPositionUsdc} minimum position for ${pair.symbol} on Avantis.`);
      }
      const collateralUsdc = collateralForNotional(usd, leverage);
      await approveUsdcIfNeeded(network, privateKey, collateralUsdc);
      const built = await buildOpen(network, { trader, pairIndex: pair.index, side, collateralUsdc, leverage, slippagePercent: 1 });
      const hash = await sendBuilt(network, privateKey, built);
      const fill = await waitForFill(network, trader, pair.index);
      if (fill !== "filled") throw new Error(`Avantis open ${fill} (keeper did not fill the market order).`);
      const price = built.openPrice > 0 ? built.openPrice : 1;
      return { symbol, side, qty: String(usd / price), notionalUsd: usd, price: built.openPrice, orderId: hash };
    },

    async closePosition(symbol) {
      const { pair, trade } = await tradeFor(symbol);
      if (!trade) return null;
      const built = await buildClose(network, { trader, pairIndex: pair.index, tradeIndex: trade.tradeIndex });
      const hash = await sendBuilt(network, privateKey, built);
      const size = trade.openPrice > 0 ? (trade.collateralUsdc * trade.leverage) / trade.openPrice : 0;
      return { symbol, size, orderId: hash };
    },

    async reducePosition(symbol, qty) {
      const { pair, trade } = await tradeFor(symbol);
      if (!trade) return null;
      const collateralToCloseUsdc = collateralForNotional(qty * trade.openPrice, trade.leverage);
      const built = await buildClose(network, { trader, pairIndex: pair.index, tradeIndex: trade.tradeIndex, collateralToCloseUsdc });
      const hash = await sendBuilt(network, privateKey, built);
      return { symbol, size: qty, orderId: hash };
    },

    async setPositionStops(args) {
      const requested = args.slPct !== undefined || args.tpPct !== undefined;
      return { requested, set: false, error: requested ? "stop-loss/take-profit not yet supported on Avantis" : undefined };
    },
  };
}

/* Build the venue an agent trades through, loading the right credential -
   Bybit API keys for the CEX, the agent's own wallet key for Avantis. */
export async function getVenue(
  agentName: string,
  agentCfg: AgentConfig,
  bybit: { network: BybitNetwork; creds: BybitCreds | null },
): Promise<TradingVenue | null> {
  if (agentCfg.platform === "Avantis") {
    const wallet = await loadWallet(agentName);
    const network: AvantisNetwork = bybit.network === "testnet" ? "testnet" : "mainnet";
    return avantisVenue(network, wallet.privateKey as Hex, getAddress(wallet.address), agentCfg);
  }
  if (!bybit.creds) return null;
  return bybitVenue(bybit.network, bybit.creds);
}
