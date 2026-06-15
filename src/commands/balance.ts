import chalk from "chalk";

import {

  getBybitTradingBalances,

  TRADING_COIN,

  DEPOSIT_COIN,

} from "../services/bybit-asset.service.js";

import {

  resolveWalletDepositAsset,

  WALLET_DEPOSIT_ASSETS,

} from "../services/deposit-assets.js";

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



  let walletMntWei: bigint;

  let walletUsdtWei: bigint | null = null;

  let bybit: Awaited<ReturnType<typeof getBybitTradingBalances>>;

  try {

    const usdtAsset = resolveWalletDepositAsset("USDT", ctx.chainId);

    const usdtToken =

      !("error" in usdtAsset) && usdtAsset.kind === "erc20"

        ? usdtAsset.tokenAddress![ctx.chainId]

        : undefined;



    [walletMntWei, bybit, walletUsdtWei] = await Promise.all([

      getWalletMntBalance(ctx.walletAddress, ctx.chainId),

      getBybitTradingBalances(ctx.network, ctx.creds),

      usdtToken

        ? getWalletTokenBalance({

            chainId: ctx.chainId,

            tokenAddress: usdtToken,

            walletAddress: ctx.walletAddress,

          })

        : Promise.resolve(null),

    ]);

  } catch (err) {

    return [log.error(`Balance lookup failed: ${(err as Error).message}`)];

  }



  const walletMnt = formatMnt(walletMntWei);

  const usdtDisplay =

    bybit.usdtEquity > 0 && Math.abs(bybit.usdtEquity - bybit.usdtWallet) > 0.0001

      ? bybit.usdtEquity

      : bybit.usdtWallet;



  const lines = [

    log.blank(),

    log.heading(`  Balances — ${ctx.agentName}`),

    log.blank(),

    log.raw(

      `  ${chalk.dim("Wallet".padEnd(12))} ${chalk.cyanBright(walletMnt)} ${DEPOSIT_COIN}  ${chalk.dim(`(${ctx.chainId})`)}`,

    ),

  ];



  if (walletUsdtWei !== null && walletUsdtWei > 0n) {

    const usdtDecimals = WALLET_DEPOSIT_ASSETS.USDT!.decimals;

    lines.push(

      log.raw(

        `  ${"".padEnd(12)} ${chalk.cyanBright(formatTokenAmount(walletUsdtWei, usdtDecimals))} ${TRADING_COIN}`,

      ),

    );

  }



  lines.push(

    log.raw(

      `  ${chalk.dim("Bybit".padEnd(12))} ${chalk.green(usdtDisplay.toFixed(4))} ${TRADING_COIN}  ${chalk.dim("unified trading")}`,

    ),

  );



  if (bybit.mntFund > 0 || bybit.mntUnified > 0) {

    lines.push(

      log.raw(

        `  ${"".padEnd(12)} ${chalk.yellow(bybit.mntFund.toFixed(4))} ${DEPOSIT_COIN} fund  ${chalk.dim(`unified ${bybit.mntUnified.toFixed(4)}`)}`,

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


