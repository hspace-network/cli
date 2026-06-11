import {
  bybitGet,
  bybitPost,
  fetchLastPrice,
  formatQty,
  getInstrument,
  mintOrderLinkId,
  type BybitCreds,
} from "./bybit.service.js";
import type { BybitNetwork } from "./config.service.js";

export type PositionSide = "long" | "short";

export interface OpenPosition {
  symbol: string;
  side: PositionSide;
  size: number;
  avgPrice: number;
}

export interface PositionSnapshot {
  symbol: string;
  side: "LONG" | "SHORT";
  size: string;
  entry: string;
  mark: string;
  pnl: number;
}

interface PositionListResult {
  list?: Array<{
    symbol: string;
    side: string;
    size: string;
    avgPrice?: string;
    markPrice?: string;
    unrealisedPnl?: string;
  }>;
}

export async function getOpenPosition(
  symbol: string,
  network: BybitNetwork,
  creds: BybitCreds,
): Promise<OpenPosition | null> {
  const positions = await bybitGet<PositionListResult>(
    network,
    "/v5/position/list",
    { category: "linear", symbol },
    creds,
  );
  const entry = positions.list?.find(
    (p) => p.symbol === symbol && Number(p.size) > 0,
  );
  if (!entry) return null;
  return {
    symbol,
    side: entry.side === "Buy" ? "long" : "short",
    size: Number(entry.size),
    avgPrice: Number(entry.avgPrice ?? "0"),
  };
}

export function positionNotionalUsd(position: OpenPosition, price: number): number {
  return position.size * price;
}

export async function fetchPositionSnapshot(
  symbol: string,
  network: BybitNetwork,
  creds: BybitCreds,
): Promise<PositionSnapshot | null> {
  const positions = await bybitGet<PositionListResult>(
    network,
    "/v5/position/list",
    { category: "linear", symbol },
    creds,
  );
  const entry = positions.list?.find(
    (p) => p.symbol === symbol && Number(p.size) > 0,
  );
  if (!entry) return null;

  const pnl = Number(entry.unrealisedPnl ?? "0");
  return {
    symbol: entry.symbol,
    side: entry.side === "Buy" ? "LONG" : "SHORT",
    size: entry.size,
    entry: entry.avgPrice ?? "?",
    mark: entry.markPrice ?? "?",
    pnl: Number.isFinite(pnl) ? pnl : 0,
  };
}

export interface CloseResult {
  symbol: string;
  size: number;
  orderId?: string;
}

export async function reducePosition(
  symbol: string,
  qty: number,
  network: BybitNetwork,
  creds: BybitCreds,
): Promise<CloseResult | null> {
  const instrument = await getInstrument(symbol, network);
  const position = await getOpenPosition(symbol, network, creds);
  if (!position) return null;

  const closeQty = Math.min(qty, position.size);
  if (closeQty <= 0) return null;

  const body: Record<string, unknown> = {
    category: "linear",
    symbol: instrument.symbol,
    side: position.side === "long" ? "Sell" : "Buy",
    orderType: "Market",
    qty: formatQty(closeQty, instrument),
    reduceOnly: true,
    orderLinkId: mintOrderLinkId(),
  };

  const result = await bybitPost<{ orderId?: string }>(
    network,
    "/v5/order/create",
    body,
    creds,
  );
  return { symbol: instrument.symbol, size: closeQty, orderId: result.orderId };
}

export async function closePosition(
  symbol: string,
  network: BybitNetwork,
  creds: BybitCreds,
): Promise<CloseResult | null> {
  const position = await getOpenPosition(symbol, network, creds);
  if (!position) return null;
  return reducePosition(symbol, position.size, network, creds);
}

export interface OpenResult {
  symbol: string;
  side: PositionSide;
  qty: string;
  notionalUsd: number;
  price: number;
  orderId?: string;
}

function baseCoin(symbol: string): string {
  return symbol.replace(/USDT$|USDC$/, "");
}

export class StakeTooSmallError extends Error {
  constructor(
    public readonly notionalUsd: number,
    public readonly minUsd: number,
    public readonly symbol: string,
    public readonly minQty: number,
  ) {
    super(
      `stake ~$${notionalUsd.toFixed(2)} is below the ~$${minUsd.toFixed(2)} needed to open ${symbol} ` +
        `(min size ${minQty} ${baseCoin(symbol)}). Raise the spending cap with "cap <agent> <usd>".`,
    );
    this.name = "StakeTooSmallError";
  }
}

export async function openMarketNotional(
  symbol: string,
  side: PositionSide,
  notionalUsd: number,
  network: BybitNetwork,
  creds: BybitCreds,
): Promise<OpenResult> {
  const instrument = await getInstrument(symbol, network);

  const price = await fetchLastPrice(instrument.symbol, network);
  if (price === null || !Number.isFinite(price) || price <= 0) {
    throw new Error(`Could not fetch a price for ${instrument.symbol}.`);
  }

  const minLotCost = instrument.minOrderQty * price;
  const minUsd = Math.max(instrument.minNotional, minLotCost);
  if (notionalUsd < minUsd) {
    throw new StakeTooSmallError(
      notionalUsd,
      minUsd,
      instrument.symbol,
      instrument.minOrderQty,
    );
  }

  const size = notionalUsd / price;
  const qty = formatQty(size, instrument);
  if (Number(qty) < instrument.minOrderQty) {
    throw new StakeTooSmallError(
      notionalUsd,
      minUsd,
      instrument.symbol,
      instrument.minOrderQty,
    );
  }

  const body: Record<string, unknown> = {
    category: "linear",
    symbol: instrument.symbol,
    side: side === "long" ? "Buy" : "Sell",
    orderType: "Market",
    qty,
    reduceOnly: false,
    orderLinkId: mintOrderLinkId(),
  };

  const result = await bybitPost<{ orderId?: string }>(
    network,
    "/v5/order/create",
    body,
    creds,
  );

  return {
    symbol: instrument.symbol,
    side,
    qty,
    notionalUsd,
    price,
    orderId: result.orderId,
  };
}
