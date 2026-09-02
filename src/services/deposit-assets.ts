import type { ChainId } from "./config.service.js";

/**
 * Per-chain settlement profile. Everything chain-specific about funding lives
 * here so the deposit / withdraw / balance flows are chain-agnostic:
 *  - nativeCoin: the gas token (MNT on Mantle, ETH on Base).
 *  - stableCoin / stableToken: the stablecoin the agent wallet holds (USDT on
 *    Mantle, USDC on Base) — this is Avantis collateral on Base.
 *  - bybitChain / railCoin: how the Bybit CEX deposit/withdraw rail addresses
 *    this chain and which coin it moves back to the wallet.
 *  - bybitRail: whether the Bybit CEX funding rail is enabled for this chain.
 *    Only Mantle is enabled — it is the live-verified CEX rail. Base is a
 *    wallet/Avantis settlement chain (agents hold USDC and trade Avantis
 *    directly, no CEX step); a Bybit-over-Base rail would need a live
 *    Base-USDC test plus a USDT->USDC cash-out path, so it is left off.
 *    Testnets have no Bybit rail.
 */
export interface ChainProfile {
  id: ChainId;
  label: string;
  nativeCoin: string;
  stableCoin: string;
  stableToken?: `0x${string}`;
  stableDecimals: number;
  /** Coin the Bybit withdraw rail sends back to the wallet on this chain. */
  railCoin: string;
  bybitChain: string;
  bybitRail: boolean;
  explorer: string;
}

export const CHAIN_PROFILES: Record<ChainId, ChainProfile> = {
  mantle: {
    id: "mantle",
    label: "Mantle",
    nativeCoin: "MNT",
    stableCoin: "USDT",
    stableToken: "0x201EBa5CC46D216Ce6DC03F6a759e8E766e956aE",
    stableDecimals: 6,
    railCoin: "MNT",
    bybitChain: "MANTLE",
    bybitRail: true,
    explorer: "https://explorer.mantle.xyz",
  },
  "mantle-sepolia": {
    id: "mantle-sepolia",
    label: "Mantle Sepolia",
    nativeCoin: "MNT",
    stableCoin: "USDT",
    stableDecimals: 6,
    railCoin: "MNT",
    bybitChain: "MANTLE",
    bybitRail: false,
    explorer: "https://explorer.sepolia.mantle.xyz",
  },
  base: {
    id: "base",
    label: "Base",
    nativeCoin: "ETH",
    stableCoin: "USDC",
    stableToken: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    stableDecimals: 6,
    railCoin: "USDC",
    bybitChain: "BASE",
    bybitRail: false,
    explorer: "https://basescan.org",
  },
  "base-sepolia": {
    id: "base-sepolia",
    label: "Base Sepolia",
    nativeCoin: "ETH",
    stableCoin: "USDC",
    stableToken: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    stableDecimals: 6,
    railCoin: "USDC",
    bybitChain: "BASE",
    bybitRail: false,
    explorer: "https://sepolia.basescan.org",
  },
};

export function chainProfile(id: ChainId): ChainProfile {
  return CHAIN_PROFILES[id];
}

export type DepositAssetKind = "native" | "erc20";

export interface WalletDepositAsset {
  coin: string;
  kind: DepositAssetKind;
  decimals: number;
  tokenAddress?: `0x${string}`;
}

/** The gas token and the stablecoin an agent can send to Bybit on a chain. */
export function walletDepositAssets(chainId: ChainId): WalletDepositAsset[] {
  const p = chainProfile(chainId);
  const assets: WalletDepositAsset[] = [
    { coin: p.nativeCoin, kind: "native", decimals: 18 },
  ];
  if (p.stableToken) {
    assets.push({
      coin: p.stableCoin,
      kind: "erc20",
      decimals: p.stableDecimals,
      tokenAddress: p.stableToken,
    });
  }
  return assets;
}

/**
 * Resolve a deposit coin (defaulting to the chain's native gas coin) against the
 * selected chain. Returns an error string for coins not fundable on that chain.
 */
export function resolveWalletDepositAsset(
  coinInput: string | undefined,
  chainId: ChainId,
): WalletDepositAsset | { error: string } {
  const p = chainProfile(chainId);
  const assets = walletDepositAssets(chainId);
  const key = (coinInput ?? p.nativeCoin).trim().toUpperCase();
  const asset = assets.find((a) => a.coin.toUpperCase() === key);
  if (!asset) {
    const supported = assets.map((a) => a.coin).join(", ");
    return {
      error: `Unsupported deposit coin "${key}" on ${p.label}. Supported: ${supported}.`,
    };
  }
  if (asset.kind === "erc20" && !asset.tokenAddress) {
    return {
      error: `${asset.coin} deposits are not configured for chain "${chainId}".`,
    };
  }
  return asset;
}
