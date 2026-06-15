import type { ChainId } from "./config.service.js";

export const DEPOSIT_CHAIN = "MANTLE";
export const TRADING_COIN = "USDT";

export type DepositAssetKind = "native" | "erc20";

export interface WalletDepositAsset {
  coin: string;
  kind: DepositAssetKind;
  decimals: number;
  /** ERC20 contract per chain; required when kind is erc20 */
  tokenAddress?: Partial<Record<ChainId, `0x${string}`>>;
}

/** Coins the agent wallet can send to Bybit on Mantle. */
export const WALLET_DEPOSIT_ASSETS: Record<string, WalletDepositAsset> = {
  MNT: {
    coin: "MNT",
    kind: "native",
    decimals: 18,
  },
  USDT: {
    coin: "USDT",
    kind: "erc20",
    decimals: 6,
    tokenAddress: {
      mantle: "0x201EBa5CC46D216Ce6DC03F6a759e8E766e956aE",
    },
  },
};

export function resolveWalletDepositAsset(
  coinInput: string | undefined,
  chainId: ChainId,
): WalletDepositAsset | { error: string } {
  const key = (coinInput ?? "MNT").trim().toUpperCase();
  const asset = WALLET_DEPOSIT_ASSETS[key];
  if (!asset) {
    const supported = Object.keys(WALLET_DEPOSIT_ASSETS).join(", ");
    return {
      error: `Unsupported deposit coin "${key}". Supported from wallet: ${supported}.`,
    };
  }
  if (asset.kind === "erc20" && !asset.tokenAddress?.[chainId]) {
    return {
      error: `${asset.coin} deposits are not configured for chain "${chainId}".`,
    };
  }
  return asset;
}
