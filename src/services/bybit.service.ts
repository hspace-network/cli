import { createHmac, randomBytes } from "node:crypto";
import type { BybitNetwork } from "./config.service.js";

export interface BybitCreds {
  apiKey: string;
  apiSecret: string;
}

const RECV_WINDOW = "5000";
const USER_AGENT = "hspace-cli";
const REFERER = "hspace";
const FETCH_TIMEOUT_MS = 10_000;

export interface BybitInstrument {
  symbol: string;
  tickSize: number;
  qtyStep: number;
  minOrderQty: number;
  minNotional: number;
  maxLeverage: number;
}

export interface BybitResponse<T = unknown> {
  retCode: number;
  retMsg: string;
  result: T;
}

export class BybitApiError extends Error {
  constructor(
    public retCode: number,
    public retMsg: string,
  ) {
    super(`Bybit error ${retCode}: ${retMsg}`);
    this.name = "BybitApiError";
  }
}

function baseUrl(network: BybitNetwork): string {
  return network === "testnet"
    ? "https://api-testnet.bybit.com"
    : "https://api.bybit.com";
}

function sign(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

function buildQuery(params: Record<string, string | number | undefined>): string {
  const entries = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${k}=${v}`);
  return entries.join("&");
}

async function request<T>(
  network: BybitNetwork,
  method: "GET" | "POST",
  path: string,
  options: {
    creds?: BybitCreds;
    query?: Record<string, string | number | undefined>;
    body?: Record<string, unknown>;
  } = {},
): Promise<T> {
  const url = new URL(path, baseUrl(network));
  const headers: Record<string, string> = {
    "User-Agent": USER_AGENT,
    "X-Referer": REFERER,
  };

  let fetchBody: string | undefined;
  const queryStr = options.query ? buildQuery(options.query) : "";
  if (queryStr) url.search = queryStr;

  if (method === "POST") {
    fetchBody = JSON.stringify(options.body ?? {});
    headers["Content-Type"] = "application/json";
  }

  if (options.creds) {
    const timestamp = Date.now().toString();
    const payloadPart = method === "GET" ? queryStr : (fetchBody ?? "");
    const paramStr = `${timestamp}${options.creds.apiKey}${RECV_WINDOW}${payloadPart}`;
    headers["X-BAPI-API-KEY"] = options.creds.apiKey;
    headers["X-BAPI-TIMESTAMP"] = timestamp;
    headers["X-BAPI-RECV-WINDOW"] = RECV_WINDOW;
    headers["X-BAPI-SIGN"] = sign(options.creds.apiSecret, paramStr);
  }

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: fetchBody,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    if ((err as Error).name === "TimeoutError") {
      throw new Error("Bybit request timed out. Check your connection and try again.");
    }
    throw new Error(`Bybit request failed: ${(err as Error).message}`);
  }

  let json: BybitResponse<T>;
  try {
    json = (await res.json()) as BybitResponse<T>;
  } catch {
    throw new Error(`Bybit returned a non-JSON response (HTTP ${res.status}).`);
  }

  if (json.retCode !== 0) {
    throw new BybitApiError(json.retCode, json.retMsg || "Unknown error");
  }
  return json.result;
}

export function bybitGet<T>(
  network: BybitNetwork,
  path: string,
  query: Record<string, string | number | undefined>,
  creds?: BybitCreds,
): Promise<T> {
  return request<T>(network, "GET", path, { query, creds });
}

export function bybitPost<T>(
  network: BybitNetwork,
  path: string,
  body: Record<string, unknown>,
  creds: BybitCreds,
): Promise<T> {
  return request<T>(network, "POST", path, { body, creds });
}

export function mintOrderLinkId(): string {
  return `hspace-${randomBytes(8).toString("hex")}`;
}

// --- Public market data -----------------------------------------------------

interface TickerResult {
  list?: Array<{ symbol: string; lastPrice: string; markPrice?: string }>;
}

export async function fetchLastPrice(
  symbol: string,
  network: BybitNetwork,
): Promise<number | null> {
  const result = await bybitGet<TickerResult>(network, "/v5/market/tickers", {
    category: "linear",
    symbol,
  });
  const entry = result.list?.[0];
  if (!entry) return null;
  const px = Number(entry.markPrice ?? entry.lastPrice);
  return Number.isFinite(px) ? px : null;
}

interface InstrumentsResult {
  list?: Array<{
    symbol: string;
    priceFilter?: { tickSize?: string };
    lotSizeFilter?: {
      qtyStep?: string;
      minOrderQty?: string;
      minNotionalValue?: string;
    };
    leverageFilter?: { maxLeverage?: string };
  }>;
}

const instrumentCache = new Map<string, { value: BybitInstrument; expiresAt: number }>();
const INSTRUMENT_TTL_MS = 2 * 60 * 60_000;

function instrumentKey(symbol: string, network: BybitNetwork): string {
  return `${network}::${symbol}`;
}

export async function getInstrument(
  symbol: string,
  network: BybitNetwork,
): Promise<BybitInstrument> {
  const key = instrumentKey(symbol, network);
  const cached = instrumentCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const result = await bybitGet<InstrumentsResult>(
    network,
    "/v5/market/instruments-info",
    { category: "linear", symbol },
  );
  const entry = result.list?.find((i) => i.symbol === symbol);
  if (!entry) {
    throw new Error(`Unknown market "${symbol}" on Bybit ${network} (linear perps).`);
  }

  const instrument: BybitInstrument = {
    symbol: entry.symbol,
    tickSize: Number(entry.priceFilter?.tickSize ?? "0.01"),
    qtyStep: Number(entry.lotSizeFilter?.qtyStep ?? "0.001"),
    minOrderQty: Number(entry.lotSizeFilter?.minOrderQty ?? "0"),
    minNotional: Number(entry.lotSizeFilter?.minNotionalValue ?? "5"),
    maxLeverage: Number(entry.leverageFilter?.maxLeverage ?? "100"),
  };
  instrumentCache.set(key, {
    value: instrument,
    expiresAt: Date.now() + INSTRUMENT_TTL_MS,
  });
  return instrument;
}

// --- Symbol + number formatting --------------------------------------------

export function resolveSymbol(input: string): string {
  let s = input.trim().toUpperCase();
  if (!s) throw new Error("Empty market.");
  const colonIdx = s.indexOf(":");
  if (colonIdx !== -1) s = s.slice(0, colonIdx);
  s = s.replace(/[\/\-_]/g, "");
  if (!s.endsWith("USDT") && !s.endsWith("USDC")) {
    s = `${s}USDT`;
  }
  return s;
}

function decimalsFromStep(step: number): number {
  if (!Number.isFinite(step) || step <= 0) return 0;
  const s = step.toString();
  if (s.includes("e") || s.includes("E")) {
    const exp = Number(s.split(/[eE]/)[1]);
    return exp < 0 ? Math.abs(exp) : 0;
  }
  const dotIdx = s.indexOf(".");
  return dotIdx === -1 ? 0 : s.length - dotIdx - 1;
}

function roundToStep(value: number, step: number, mode: "round" | "floor"): number {
  if (!Number.isFinite(step) || step <= 0) return value;
  const n = value / step;
  const stepped = mode === "floor" ? Math.floor(n + 1e-9) : Math.round(n);
  return stepped * step;
}

export function formatPrice(price: number, instrument: BybitInstrument): string {
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error(`Invalid price: ${price}`);
  }
  const decimals = decimalsFromStep(instrument.tickSize);
  return roundToStep(price, instrument.tickSize, "round").toFixed(decimals);
}

export function formatQty(qty: number, instrument: BybitInstrument): string {
  if (!Number.isFinite(qty) || qty <= 0) {
    throw new Error(`Invalid size: ${qty}`);
  }
  const decimals = decimalsFromStep(instrument.qtyStep);
  return roundToStep(qty, instrument.qtyStep, "floor").toFixed(decimals);
}
