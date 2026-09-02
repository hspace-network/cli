import {
  createPublicClient,
  createWalletClient,
  http,
  getAddress,
  erc20Abi,
  type Hex,
  type Chain,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";

/*
 * Avantis perps client for Base. hSpace signs trades from each agent's own EOA
 * (agents are already wallets), so positions are isolated per agent. Writes are
 * built by Avantis's tx-builder REST (which returns calldata to the Trading
 * contract) and signed+sent with viem; the tx-builder only ever targets mainnet,
 * so on testnet the returned `to` is re-pointed at the testnet Trading contract.
 * Market orders are async: the open tx escrows collateral into a pending order
 * that a keeper later fills, so callers poll openTradesCount for the fill.
 */

export type AvantisNetwork = "mainnet" | "testnet";

interface AvantisNetworkConfig {
  txBuilder: string;
  trading: Hex;
  storage: Hex;
  usdc: Hex;
  chain: Chain;
}

const NETWORKS: Record<AvantisNetwork, AvantisNetworkConfig> = {
  mainnet: {
    txBuilder: "https://tx-builder.avantisfi.com",
    trading: getAddress("0x44914408af82bC9983bbb330e3578E1105e11d4e"),
    storage: getAddress("0x8a311D7048c35985aa31C131B9A13e03a5f7422d"),
    usdc: getAddress("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"),
    chain: base,
  },
  testnet: {
    txBuilder: "https://tx-builder-testnet.avantisfi.com",
    trading: getAddress("0xB3052Be2eB17035568A8B52d60362E89baCE1CcD"),
    storage: getAddress("0xC42bA6D0c7CC3Fa8Dbd88D96F4BE6B58d5f8d8eB"),
    usdc: getAddress("0xeA62DF0296f5063A27fBBBe5B4A3673881d2f9Fd"),
    chain: baseSepolia,
  },
};

export function avantisConfig(network: AvantisNetwork): AvantisNetworkConfig {
  return NETWORKS[network];
}

export interface AvantisPair {
  index: number;
  symbol: string;
  minLeverage: number;
  maxLeverage: number;
  minPositionUsdc: number;
}

interface BuiltTx {
  to: Hex;
  data: Hex;
  value: bigint;
  openPrice: number;
}

const STORAGE_ABI = [
  { type: "function", name: "openTradesCount", stateMutability: "view", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "pendingMarketOpenCount", stateMutability: "view", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "uint256" }] },
] as const;

const pairsCache = new Map<AvantisNetwork, { at: number; pairs: AvantisPair[] }>();
const PAIRS_TTL_MS = 10 * 60_000;

async function txbGet(network: AvantisNetwork, path: string): Promise<unknown> {
  const res = await fetch(`${NETWORKS[network].txBuilder}${path}`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  const body = (await res.json()) as { ok?: boolean; data?: unknown; error?: unknown };
  if (!res.ok || body.ok === false) throw new Error(`Avantis ${path}: ${JSON.stringify(body.error ?? res.status)}`);
  return body.data;
}

async function txbPost(network: AvantisNetwork, path: string, payload: unknown): Promise<any> {
  const res = await fetch(`${NETWORKS[network].txBuilder}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000),
  });
  const body = (await res.json()) as { ok?: boolean; data?: any; error?: unknown };
  if (!res.ok || body.ok === false) throw new Error(`Avantis ${path}: ${JSON.stringify(body.error ?? res.status)}`);
  return body.data;
}

export async function getPairs(network: AvantisNetwork): Promise<AvantisPair[]> {
  const hit = pairsCache.get(network);
  if (hit && Date.now() - hit.at < PAIRS_TTL_MS) return hit.pairs;
  const data = (await txbGet(network, "/v2/pairs")) as any;
  const raw: any[] = Array.isArray(data) ? data : data?.pairs ?? [];
  const pairs: AvantisPair[] = raw
    .filter((p) => p.isPairListed !== false)
    .map((p) => ({
      index: Number(p.index ?? p.pairIndex),
      symbol: String(p.symbol ?? `${p.from}/${p.to}`),
      minLeverage: Number(p.leverages?.minLeverage ?? 1),
      maxLeverage: Number(p.leverages?.maxLeverage ?? 50),
      minPositionUsdc: Number(p.pairMinLevPosUSDC ?? 100),
    }));
  pairsCache.set(network, { at: Date.now(), pairs });
  return pairs;
}

/* Map an hSpace market (BTCUSDT) to an Avantis pair (BTC/USD, index 2 vs README) */
export async function resolvePair(network: AvantisNetwork, market: string): Promise<AvantisPair> {
  const base = market.replace(/USDT$|USDC$|USD$/i, "").toUpperCase();
  const pairs = await getPairs(network);
  const pair = pairs.find((p) => p.symbol.toUpperCase() === `${base}/USD`);
  if (!pair) throw new Error(`Avantis has no ${base}/USD pair on ${network}.`);
  return pair;
}

export function clientsFor(network: AvantisNetwork, privateKey: Hex): { pub: PublicClient; wallet: WalletClient; account: Hex } {
  const chain = NETWORKS[network].chain;
  const account = privateKeyToAccount(privateKey);
  const pub = createPublicClient({ chain, transport: http() });
  const wallet = createWalletClient({ account, chain, transport: http() });
  return { pub, wallet, account: account.address };
}

export async function usdcAllowance(network: AvantisNetwork, owner: Hex): Promise<bigint> {
  const cfg = NETWORKS[network];
  const pub = createPublicClient({ chain: cfg.chain, transport: http() });
  return pub.readContract({ address: cfg.usdc, abi: erc20Abi, functionName: "allowance", args: [owner, cfg.storage] });
}

/* Approve USDC to the Storage contract (the actual spender) if the allowance is short */
export async function approveUsdcIfNeeded(network: AvantisNetwork, privateKey: Hex, neededUsdc: number): Promise<Hex | null> {
  const cfg = NETWORKS[network];
  const { pub, wallet, account } = clientsFor(network, privateKey);
  const needed = BigInt(Math.ceil(neededUsdc * 1e6));
  const current = await pub.readContract({ address: cfg.usdc, abi: erc20Abi, functionName: "allowance", args: [account, cfg.storage] });
  if (current >= needed) return null;
  const hash = await wallet.writeContract({
    account: wallet.account!,
    chain: cfg.chain,
    address: cfg.usdc,
    abi: erc20Abi,
    functionName: "approve",
    args: [cfg.storage, 2n ** 256n - 1n],
  });
  await pub.waitForTransactionReceipt({ hash });
  return hash;
}

/* Avantis has no price endpoint, so read the live oracle price off a throwaway
   open build (the build call executes nothing) */
export async function getPrice(network: AvantisNetwork, pairIndex: number, trader: Hex): Promise<number> {
  const d = await txbPost(network, "/v2/trade/open", {
    trader,
    pairIndex,
    side: "long",
    orderType: "market",
    collateralUsdc: 100,
    leverage: 2,
    slippagePercent: 1,
  });
  return Number(d.meta?.openPrice ?? 0);
}

export interface OpenParams {
  trader: Hex;
  pairIndex: number;
  side: "long" | "short";
  collateralUsdc: number;
  leverage: number;
  slippagePercent: number;
}

export async function buildOpen(network: AvantisNetwork, p: OpenParams): Promise<BuiltTx> {
  const d = await txbPost(network, "/v2/trade/open", {
    trader: p.trader,
    pairIndex: p.pairIndex,
    side: p.side,
    orderType: "market",
    collateralUsdc: p.collateralUsdc,
    leverage: p.leverage,
    slippagePercent: p.slippagePercent,
  });
  return { to: NETWORKS[network].trading, data: d.data as Hex, value: BigInt(d.value ?? "0x0"), openPrice: Number(d.meta?.openPrice ?? 0) };
}

export async function buildClose(network: AvantisNetwork, p: { trader: Hex; pairIndex: number; tradeIndex: number; collateralToCloseUsdc?: number }): Promise<BuiltTx> {
  const d = await txbPost(network, "/v2/trade/close", {
    trader: p.trader,
    pairIndex: p.pairIndex,
    tradeIndex: p.tradeIndex,
    ...(p.collateralToCloseUsdc !== undefined ? { collateralToCloseUsdc: p.collateralToCloseUsdc } : {}),
  });
  return { to: NETWORKS[network].trading, data: d.data as Hex, value: BigInt(d.value ?? "0x0"), openPrice: Number(d.meta?.openPrice ?? 0) };
}

export async function sendBuilt(network: AvantisNetwork, privateKey: Hex, tx: BuiltTx): Promise<Hex> {
  const cfg = NETWORKS[network];
  const { pub, wallet } = clientsFor(network, privateKey);
  const hash = await wallet.sendTransaction({ account: wallet.account!, chain: cfg.chain, to: tx.to, data: tx.data, value: tx.value });
  const rc = await pub.waitForTransactionReceipt({ hash });
  if (rc.status !== "success") throw new Error(`Avantis tx reverted (${hash}).`);
  return hash;
}

export interface TraderCounts {
  open: number;
  pending: number;
}

export async function readCounts(network: AvantisNetwork, trader: Hex, pairIndex: number): Promise<TraderCounts> {
  const cfg = NETWORKS[network];
  const pub = createPublicClient({ chain: cfg.chain, transport: http() });
  const [open, pending] = await Promise.all([
    pub.readContract({ address: cfg.storage, abi: STORAGE_ABI, functionName: "openTradesCount", args: [trader, BigInt(pairIndex)] }),
    pub.readContract({ address: cfg.storage, abi: STORAGE_ABI, functionName: "pendingMarketOpenCount", args: [trader, BigInt(pairIndex)] }),
  ]);
  return { open: Number(open), pending: Number(pending) };
}

export type FillResult = "filled" | "cancelled" | "timeout";

/* Poll on-chain counts until the keeper fills the pending market order */
export async function waitForFill(network: AvantisNetwork, trader: Hex, pairIndex: number, timeoutMs = 60_000): Promise<FillResult> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { open, pending } = await readCounts(network, trader, pairIndex);
    if (open >= 1) return "filled";
    if (pending === 0) return "cancelled";
    if (Date.now() > deadline) return "timeout";
    await new Promise((r) => setTimeout(r, 3000));
  }
}

export interface AvantisTrade {
  pairIndex: number;
  tradeIndex: number;
  side: "long" | "short";
  collateralUsdc: number;
  leverage: number;
  openPrice: number;
  pnlUsd: number;
}

/* Read a trader's open trades. REST reflects mainnet only; testnet fills never
   land, so an empty result there is accurate. */
export async function readTrades(network: AvantisNetwork, trader: Hex): Promise<AvantisTrade[]> {
  const data = (await txbPost(network, "/v2/positions", { trader })) as any;
  const trades: any[] = data?.trades ?? [];
  return trades.map((t) => {
    const isLong = t.buy ?? t.isLong ?? (typeof t.side === "string" ? t.side.toLowerCase() === "long" : true);
    return {
      pairIndex: Number(t.pairIndex ?? t.index ?? 0),
      tradeIndex: Number(t.tradeIndex ?? t.index ?? 0),
      side: isLong ? "long" : "short",
      collateralUsdc: Number(t.collateralUsdc ?? t.positionSizeUsdc ?? t.collateral ?? 0),
      leverage: Number(t.leverage ?? 0),
      openPrice: Number(t.openPrice ?? t.price ?? 0),
      pnlUsd: Number(t.pnl ?? t.unrealizedPnl ?? t.uPnl ?? 0),
    };
  });
}
