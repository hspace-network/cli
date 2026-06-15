import { randomUUID } from "node:crypto";
import { bybitGet, bybitPost, type BybitCreds } from "./bybit.service.js";
import type { BybitNetwork } from "./config.service.js";
import { DEPOSIT_CHAIN, TRADING_COIN } from "./deposit-assets.js";

export { DEPOSIT_CHAIN, TRADING_COIN };
/** Native gas / withdraw coin on Mantle */
export const DEPOSIT_COIN = "MNT";
const CONVERT_ACCOUNT_FUND = "eb_convert_funding";

interface DepositAddressResult {
  chains?: Array<{
    chainType?: string;
    addressDeposit?: string;
  }>;
}

interface WalletBalanceResult {
  list?: Array<{
    totalAvailableBalance?: string;
    coin?: Array<{
      coin?: string;
      walletBalance?: string;
      equity?: string;
      availableToWithdraw?: string;
    }>;
  }>;
}

interface AccountCoinsBalanceResult {
  balance?: Array<{
    coin?: string;
    walletBalance?: string;
    transferBalance?: string;
  }>;
}

interface WithdrawableResult {
  withdrawableAmount?: string;
  availableBalance?: string;
}

interface CoinInfoResult {
  rows?: Array<{
    coin?: string;
    chains?: Array<{
      chain?: string;
      chainType?: string;
      depositMin?: string;
      withdrawMin?: string;
      withdrawFee?: string;
    }>;
  }>;
}

interface WithdrawCreateResult {
  id?: string;
}

export async function getDepositAddress(
  network: BybitNetwork,
  creds: BybitCreds,
  coin: string,
): Promise<string> {
  const result = await bybitGet<DepositAddressResult>(
    network,
    "/v5/asset/deposit/query-address",
    { coin, chainType: DEPOSIT_CHAIN },
    creds,
  );
  const chain = result.chains?.find(
    (c) =>
      c.chainType?.toUpperCase() === DEPOSIT_CHAIN ||
      c.chainType?.toLowerCase().includes("mantle"),
  );
  const addr = chain?.addressDeposit ?? result.chains?.[0]?.addressDeposit;
  if (!addr) {
    throw new Error(`No ${coin} deposit address on ${DEPOSIT_CHAIN} from Bybit.`);
  }
  return addr;
}

function findCoinBalance(
  result: WalletBalanceResult,
  coin: string,
): { wallet: number; equity: number; available: number } {
  for (const account of result.list ?? []) {
    for (const entry of account.coin ?? []) {
      if (entry.coin?.toUpperCase() === coin.toUpperCase()) {
        const wallet = Number(entry.walletBalance ?? "0");
        return {
          wallet,
          equity: Number(entry.equity ?? entry.walletBalance ?? "0"),
          available: Number(entry.availableToWithdraw ?? entry.walletBalance ?? "0"),
        };
      }
    }
  }
  return { wallet: 0, equity: 0, available: 0 };
}

async function getUnifiedCoinBalance(
  network: BybitNetwork,
  creds: BybitCreds,
  coin: string,
): Promise<{ wallet: number; equity: number; available: number }> {
  const result = await bybitGet<WalletBalanceResult>(
    network,
    "/v5/account/wallet-balance",
    { accountType: "UNIFIED", coin },
    creds,
  );
  return findCoinBalance(result, coin);
}

async function getFundCoinBalance(
  network: BybitNetwork,
  creds: BybitCreds,
  coin: string,
): Promise<{ wallet: number; transfer: number }> {
  const result = await bybitGet<AccountCoinsBalanceResult>(
    network,
    "/v5/asset/transfer/query-account-coins-balance",
    { accountType: "FUND", coin },
    creds,
  );
  const entry = result.balance?.find(
    (b) => b.coin?.toUpperCase() === coin.toUpperCase(),
  );
  return {
    wallet: Number(entry?.walletBalance ?? "0"),
    transfer: Number(entry?.transferBalance ?? entry?.walletBalance ?? "0"),
  };
}

export interface BybitTradingBalances {
  usdtWallet: number;
  usdtEquity: number;
  totalAvailableUsd: number;
  mntFund: number;
  mntUnified: number;
}

export async function getBybitTradingBalances(
  network: BybitNetwork,
  creds: BybitCreds,
): Promise<BybitTradingBalances> {
  const [unifiedUsdt, unifiedMnt, fundMnt, unifiedAccount] = await Promise.all([
    getUnifiedCoinBalance(network, creds, TRADING_COIN),
    getUnifiedCoinBalance(network, creds, DEPOSIT_COIN),
    getFundCoinBalance(network, creds, DEPOSIT_COIN),
    bybitGet<WalletBalanceResult>(
      network,
      "/v5/account/wallet-balance",
      { accountType: "UNIFIED", coin: TRADING_COIN },
      creds,
    ),
  ]);
  const account = unifiedAccount.list?.[0];
  return {
    usdtWallet: unifiedUsdt.wallet,
    usdtEquity: unifiedUsdt.equity,
    totalAvailableUsd: Number(account?.totalAvailableBalance ?? "0"),
    mntFund: fundMnt.wallet,
    mntUnified: unifiedMnt.wallet,
  };
}

export async function getBybitMntBalances(
  network: BybitNetwork,
  creds: BybitCreds,
): Promise<{ unified: number; fund: number }> {
  const [unified, fund] = await Promise.all([
    getUnifiedCoinBalance(network, creds, DEPOSIT_COIN),
    getFundCoinBalance(network, creds, DEPOSIT_COIN),
  ]);
  return {
    unified: unified.wallet,
    fund: fund.wallet,
  };
}

export async function getWithdrawableMnt(
  network: BybitNetwork,
  creds: BybitCreds,
): Promise<number> {
  const result = await bybitGet<WithdrawableResult>(
    network,
    "/v5/asset/withdraw/withdrawable-amount",
    { coin: DEPOSIT_COIN },
    creds,
  );
  const amt = result.withdrawableAmount ?? result.availableBalance ?? "0";
  return Number(amt);
}

export async function getCoinChainInfo(
  network: BybitNetwork,
  creds: BybitCreds,
  coin: string,
): Promise<{
  depositMin: number;
  withdrawMin: number;
  withdrawFee: number;
}> {
  const result = await bybitGet<CoinInfoResult>(
    network,
    "/v5/asset/coin/query-info",
    { coin },
    creds,
  );
  const row = result.rows?.find((r) => r.coin?.toUpperCase() === coin.toUpperCase());
  const chain = row?.chains?.find(
    (c) => c.chain?.toUpperCase() === DEPOSIT_CHAIN,
  );
  return {
    depositMin: Number(chain?.depositMin ?? "0"),
    withdrawMin: Number(chain?.withdrawMin ?? "0"),
    withdrawFee: Number(chain?.withdrawFee ?? "0"),
  };
}

export async function getMntChainInfo(
  network: BybitNetwork,
  creds: BybitCreds,
): Promise<{
  depositMin: number;
  withdrawMin: number;
  withdrawFee: number;
}> {
  return getCoinChainInfo(network, creds, DEPOSIT_COIN);
}

export async function interTransfer(args: {
  network: BybitNetwork;
  creds: BybitCreds;
  coin: string;
  amount: string;
  fromAccountType: "UNIFIED" | "FUND";
  toAccountType: "UNIFIED" | "FUND";
}): Promise<void> {
  await bybitPost(
    args.network,
    "/v5/asset/transfer/inter-transfer",
    {
      transferId: randomUUID(),
      coin: args.coin,
      amount: args.amount,
      fromAccountType: args.fromAccountType,
      toAccountType: args.toAccountType,
    },
    args.creds,
  );
}

export async function transferUnifiedToFund(
  network: BybitNetwork,
  creds: BybitCreds,
  amount: string,
): Promise<void> {
  await interTransfer({
    network,
    creds,
    coin: DEPOSIT_COIN,
    amount,
    fromAccountType: "UNIFIED",
    toAccountType: "FUND",
  });
}

interface ConvertQuoteResult {
  quoteTxId?: string;
  toAmount?: string;
}

interface ConvertStatusResult {
  result?: {
    exchangeStatus?: string;
    toAmount?: string;
    fromAmount?: string;
  };
}

function trimAmount(amount: number): string {
  if (!Number.isFinite(amount) || amount <= 0) return "0";
  return parseFloat(amount.toFixed(8)).toString();
}

async function pollConvertSuccess(args: {
  network: BybitNetwork;
  creds: BybitCreds;
  quoteTxId: string;
  maxWaitMs?: number;
}): Promise<ConvertStatusResult["result"]> {
  const maxWait = args.maxWaitMs ?? 60_000;
  const started = Date.now();
  while (Date.now() - started < maxWait) {
    const status = await bybitGet<ConvertStatusResult>(
      args.network,
      "/v5/asset/exchange/convert-result-query",
      { quoteTxId: args.quoteTxId, accountType: CONVERT_ACCOUNT_FUND },
      args.creds,
    );
    const row = status.result;
    if (row?.exchangeStatus === "success") return row;
    if (row?.exchangeStatus === "failure") {
      throw new Error("Bybit convert failed.");
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }
  throw new Error("Bybit convert timed out.");
}

export type RouteDepositResult =
  | { status: "ready"; usdtAmount: number; via: "transfer" | "convert" }
  | { status: "skipped"; reason: string }
  | { status: "failed"; error: string };

async function transferFundUsdtToUnified(
  network: BybitNetwork,
  creds: BybitCreds,
): Promise<number> {
  const fundUsdt = await getFundCoinBalance(network, creds, TRADING_COIN);
  const transferAmount = fundUsdt.transfer > 0 ? fundUsdt.transfer : fundUsdt.wallet;
  if (transferAmount <= 0) return 0;
  await interTransfer({
    network,
    creds,
    coin: TRADING_COIN,
    amount: trimAmount(transferAmount),
    fromAccountType: "FUND",
    toAccountType: "UNIFIED",
  });
  return transferAmount;
}

async function convertFundCoinToUsdt(args: {
  network: BybitNetwork;
  creds: BybitCreds;
  fromCoin: string;
  amount: number;
}): Promise<number> {
  const requestAmount = trimAmount(args.amount);
  const quote = await bybitPost<ConvertQuoteResult>(
    args.network,
    "/v5/asset/exchange/quote-apply",
    {
      accountType: CONVERT_ACCOUNT_FUND,
      fromCoin: args.fromCoin,
      toCoin: TRADING_COIN,
      requestCoin: args.fromCoin,
      requestAmount,
    },
    args.creds,
  );
  const quoteTxId = quote.quoteTxId;
  if (!quoteTxId) {
    throw new Error("convert quote missing quoteTxId");
  }

  await bybitPost(
    args.network,
    "/v5/asset/exchange/convert-execute",
    { quoteTxId },
    args.creds,
  );

  const convertResult = await pollConvertSuccess({
    network: args.network,
    creds: args.creds,
    quoteTxId,
  });
  return Number(convertResult?.toAmount ?? quote.toAmount ?? "0");
}

/**
 * Move a freshly credited fund deposit into unified USDT trading.
 * USDT → inter-transfer. Any other coin → convert to USDT, then transfer.
 */
export async function routeFundDepositToTrading(args: {
  network: BybitNetwork;
  creds: BybitCreds;
  coin: string;
}): Promise<RouteDepositResult> {
  const coin = args.coin.toUpperCase();
  try {
    if (coin === TRADING_COIN) {
      const moved = await transferFundUsdtToUnified(args.network, args.creds);
      if (moved <= 0) {
        return { status: "skipped", reason: `no ${TRADING_COIN} in fund account` };
      }
      return { status: "ready", usdtAmount: moved, via: "transfer" };
    }

    const fund = await getFundCoinBalance(args.network, args.creds, coin);
    const amount = fund.transfer > 0 ? fund.transfer : fund.wallet;
    if (amount <= 0) {
      return { status: "skipped", reason: `no ${coin} in fund account` };
    }

    const converted = await convertFundCoinToUsdt({
      network: args.network,
      creds: args.creds,
      fromCoin: coin,
      amount,
    });
    const moved = await transferFundUsdtToUnified(args.network, args.creds);
    const usdtAmount = moved > 0 ? moved : converted;
    return { status: "ready", usdtAmount, via: "convert" };
  } catch (err) {
    return { status: "failed", error: (err as Error).message };
  }
}

interface DepositRecordResult {
  rows?: Array<{
    coin?: string;
    chain?: string;
    amount?: string;
    txID?: string;
    status?: number;
    successAt?: string;
  }>;
}

export async function queryDepositRecords(
  network: BybitNetwork,
  creds: BybitCreds,
  coin: string,
  limit = 50,
): Promise<DepositRecordResult["rows"]> {
  const result = await bybitGet<DepositRecordResult>(
    network,
    "/v5/asset/deposit/query-record",
    { coin, limit },
    creds,
  );
  return result.rows ?? [];
}

export type DepositPollStatus = "pending" | "credited" | "timeout";

export async function pollDepositCredit(args: {
  network: BybitNetwork;
  creds: BybitCreds;
  coin: string;
  txHash: string;
  maxWaitMs?: number;
}): Promise<DepositPollStatus> {
  const maxWait = args.maxWaitMs ?? 5 * 60_000;
  const started = Date.now();
  const needle = args.txHash.toLowerCase();

  while (Date.now() - started < maxWait) {
    const rows =
      (await queryDepositRecords(args.network, args.creds, args.coin, 50)) ?? [];
    for (const row of rows) {
      const txId = (row.txID ?? "").toLowerCase();
      if (!txId.includes(needle.slice(2)) && txId !== needle) continue;
      if (row.status === 3 || row.successAt) {
        return "credited";
      }
      return "pending";
    }
    await new Promise((r) => setTimeout(r, 10_000));
  }
  return "timeout";
}

export async function createWithdraw(args: {
  network: BybitNetwork;
  creds: BybitCreds;
  address: string;
  amount: string;
}): Promise<string> {
  const result = await bybitPost<WithdrawCreateResult>(
    args.network,
    "/v5/asset/withdraw/create",
    {
      coin: DEPOSIT_COIN,
      chain: DEPOSIT_CHAIN,
      address: args.address,
      amount: args.amount,
      timestamp: Date.now(),
      forceChain: 0,
      accountType: "FUND",
    },
    args.creds,
  );
  return result.id ?? "submitted";
}
