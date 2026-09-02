import chalk from "chalk";
import {
  getBybitTradingBalances,
  UNIFIED_COIN,
} from "../services/bybit-asset.service.js";
import {
  formatMnt,
  formatTokenAmount,
  getWalletMntBalance,
  getWalletTokenBalance,
} from "../services/chain.service.js";
import { log } from "../utils/logger.js";
import { resolveBalanceContext } from "./_balance-shared.js";

export async function balanceCommand(args: string[]): Promise<string[]> {
  const agentName = args[0];
  const ctx = await resolveBalanceContext(agentName);
  if ("error" in ctx) {
    return [log.error(ctx.error)];
  }
  const { profile } = ctx;

  // Wallet balances (native gas + stablecoin) work on any settlement chain.
  let walletNativeWei: bigint;
  let walletStableWei: bigint | null = null;
  try {
    [walletNativeWei, walletStableWei] = await Promise.all([
      getWalletMntBalance(ctx.walletAddress, ctx.chainId),
      profile.stableToken
        ? getWalletTokenBalance({
            chainId: ctx.chainId,
            tokenAddress: profile.stableToken,
            walletAddress: ctx.walletAddress,
          })
        : Promise.resolve(null),
    ]);
  } catch (err) {
    return [log.error(`Wallet balance lookup failed: ${(err as Error).message}`)];
  }

  const lines = [
    log.blank(),
    log.heading(`  Balances — ${ctx.agentName}`),
    log.blank(),
    log.raw(
      `  ${chalk.dim("Wallet".padEnd(12))} ${chalk.cyanBright(formatMnt(walletNativeWei))} ${profile.nativeCoin}  ${chalk.dim(`(${profile.label})`)}`,
    ),
  ];
  if (walletStableWei !== null) {
    lines.push(
      log.raw(
        `  ${"".padEnd(12)} ${chalk.cyanBright(formatTokenAmount(walletStableWei, profile.stableDecimals))} ${profile.stableCoin}`,
      ),
    );
  }

  // Avantis agents hold collateral in their own wallet — no CEX balances.
  if (ctx.platform === "Avantis") {
    lines.push(
      log.blank(),
      log.dim(
        `  Avantis: trades from this wallet — fund with ${profile.stableCoin} at ${ctx.walletAddress}`,
      ),
      log.blank(),
    );
    return lines;
  }

  // The Bybit CEX funding rail is enabled on Mantle only.
  if (!profile.bybitRail || !ctx.creds) {
    lines.push(
      log.blank(),
      log.dim(
        `  Bybit funding runs on Mantle — switch chain to mantle in "settings" to deposit/withdraw.`,
      ),
      log.blank(),
    );
    return lines;
  }
  const creds = ctx.creds;

  let bybit: Awaited<ReturnType<typeof getBybitTradingBalances>>;
  try {
    bybit = await getBybitTradingBalances(ctx.network, creds, profile);
  } catch (err) {
    return [
      ...lines,
      log.blank(),
      log.dim(`  Bybit balance lookup failed: ${(err as Error).message}`),
      log.blank(),
    ];
  }

  const usdtDisplay =
    bybit.usdtEquity > 0 && Math.abs(bybit.usdtEquity - bybit.usdtWallet) > 0.0001
      ? bybit.usdtEquity
      : bybit.usdtWallet;

  lines.push(
    log.raw(
      `  ${chalk.dim("Bybit".padEnd(12))} ${chalk.green(usdtDisplay.toFixed(4))} ${UNIFIED_COIN}  ${chalk.dim("unified trading")}`,
    ),
  );

  if (bybit.nativeFund > 0 || bybit.nativeUnified > 0) {
    lines.push(
      log.raw(
        `  ${"".padEnd(12)} ${chalk.yellow(bybit.nativeFund.toFixed(4))} ${bybit.nativeCoin} fund  ${chalk.dim(`unified ${bybit.nativeUnified.toFixed(4)}`)}`,
      ),
    );
  }

  if (bybit.totalAvailableUsd > 0) {
    lines.push(
      log.raw(
        `  ${"".padEnd(12)} ${chalk.dim(`available ~$${bybit.totalAvailableUsd.toFixed(2)} USD`)}`,
      ),
    );
  }

  lines.push(log.blank());
  return lines;
}
