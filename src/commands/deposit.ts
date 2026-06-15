import chalk from "chalk";
import {
  getDepositAddress,
  getCoinChainInfo,
  pollDepositCredit,
  routeFundDepositToTrading,
  TRADING_COIN,
  DEPOSIT_CHAIN,
} from "../services/bybit-asset.service.js";
import {
  resolveWalletDepositAsset,
  type WalletDepositAsset,
} from "../services/deposit-assets.js";
import { BybitApiError } from "../services/bybit.service.js";
import type { ChainId } from "../services/config.service.js";
import {
  formatMnt,
  formatTokenAmount,
  getWalletMntBalance,
  getWalletTokenBalance,
  parseMntAmount,
  parseTokenAmount,
  sendMnt,
  sendToken,
  estimateMntTransferGas,
  estimateTokenTransferGas,
} from "../services/chain.service.js";
import { setBusy } from "../utils/busy.js";
import { log } from "../utils/logger.js";
import { resolveBalanceContext } from "./_balance-shared.js";

function parseDepositArgs(
  args: string[],
): { agentName: string; amountStr: string; coinInput?: string } | { error: string } {
  if (args.length < 2) {
    return { error: "Usage: deposit <agent> <amount> [MNT|USDT]" };
  }
  const agentName = args[0]!;
  const last = args[args.length - 1]!.trim().toUpperCase();
  if (args.length >= 3 && (last === "MNT" || last === "USDT")) {
    return { agentName, amountStr: args[1]!, coinInput: last };
  }
  return { agentName, amountStr: args[1]! };
}

async function getWalletAssetBalance(
  asset: WalletDepositAsset,
  chainId: ChainId,
  walletAddress: string,
): Promise<bigint> {
  if (asset.kind === "native") {
    return getWalletMntBalance(walletAddress, chainId);
  }
  const tokenAddress = asset.tokenAddress![chainId]!;
  return getWalletTokenBalance({ chainId, tokenAddress, walletAddress });
}

function formatAssetAmount(asset: WalletDepositAsset, wei: bigint): string {
  return asset.kind === "native"
    ? formatMnt(wei)
    : formatTokenAmount(wei, asset.decimals);
}

export async function depositCommand(args: string[]): Promise<string[]> {
  const parsed = parseDepositArgs(args);
  if ("error" in parsed) {
    return [log.error(parsed.error)];
  }

  const ctx = await resolveBalanceContext(parsed.agentName);
  if ("error" in ctx) {
    return [log.error(ctx.error)];
  }

  const asset = resolveWalletDepositAsset(parsed.coinInput, ctx.chainId);
  if ("error" in asset) {
    return [log.error(asset.error)];
  }

  let amountWei: bigint;
  try {
    amountWei =
      asset.kind === "native"
        ? parseMntAmount(parsed.amountStr)
        : parseTokenAmount(parsed.amountStr, asset.decimals);
  } catch (err) {
    return [log.error((err as Error).message)];
  }

  let depositAddress: string;
  let chainInfo: { depositMin: number };
  let walletWei: bigint;
  try {
    [depositAddress, chainInfo, walletWei] = await Promise.all([
      getDepositAddress(ctx.network, ctx.creds, asset.coin),
      getCoinChainInfo(ctx.network, ctx.creds, asset.coin),
      getWalletAssetBalance(asset, ctx.chainId, ctx.walletAddress),
    ]);
  } catch (err) {
    const msg =
      err instanceof BybitApiError ? err.message : (err as Error).message;
    return [log.error(`Could not prepare deposit: ${msg}`)];
  }

  let gasMntWei = 0n;
  try {
    if (asset.kind === "native") {
      gasMntWei = await estimateMntTransferGas({
        chainId: ctx.chainId,
        from: ctx.privateKey,
        to: depositAddress,
        amountWei,
      });
    } else {
      gasMntWei = await estimateTokenTransferGas({
        chainId: ctx.chainId,
        from: ctx.privateKey,
        tokenAddress: asset.tokenAddress![ctx.chainId]!,
        to: depositAddress,
        amountWei,
      });
    }
  } catch {
    gasMntWei = 0n;
  }

  const amountNum = Number(parsed.amountStr);
  if (chainInfo.depositMin > 0 && amountNum < chainInfo.depositMin) {
    return [
      log.error(
        `Minimum deposit is ${chainInfo.depositMin} ${asset.coin} on ${DEPOSIT_CHAIN}.`,
      ),
    ];
  }

  const walletMntWei = await getWalletMntBalance(ctx.walletAddress, ctx.chainId);
  const walletLabel = formatAssetAmount(asset, walletWei);

  if (asset.kind === "native") {
    const required = amountWei + gasMntWei;
    if (walletWei < required) {
      const gasMnt = formatMnt(gasMntWei);
      return [
        log.error(
          `Insufficient wallet balance: ${walletLabel} ${asset.coin}. Need ${parsed.amountStr} + ~${gasMnt} gas.`,
        ),
      ];
    }
  } else {
    if (walletWei < amountWei) {
      return [
        log.error(
          `Insufficient ${asset.coin}: ${walletLabel}, need ${parsed.amountStr}.`,
        ),
      ];
    }
    if (walletMntWei < gasMntWei) {
      return [
        log.error(
          `Insufficient MNT for gas: ${formatMnt(walletMntWei)} MNT, need ~${formatMnt(gasMntWei)}.`,
        ),
      ];
    }
  }

  setBusy(`Sending ${asset.coin} on Mantle...`);
  let txHash: string;
  try {
    if (asset.kind === "native") {
      txHash = await sendMnt({
        chainId: ctx.chainId,
        privateKey: ctx.privateKey,
        to: depositAddress,
        amountWei,
      });
    } else {
      txHash = await sendToken({
        chainId: ctx.chainId,
        privateKey: ctx.privateKey,
        tokenAddress: asset.tokenAddress![ctx.chainId]!,
        to: depositAddress,
        amountWei,
      });
    }
  } catch (err) {
    setBusy(null);
    return [log.error(`On-chain transfer failed: ${(err as Error).message}`)];
  }

  setBusy("Waiting for Bybit credit...");
  let creditStatus: "pending" | "credited" | "timeout" = "timeout";
  try {
    creditStatus = await pollDepositCredit({
      network: ctx.network,
      creds: ctx.creds,
      coin: asset.coin,
      txHash,
    });
  } catch {
    creditStatus = "timeout";
  }

  let tradingLabel = chalk.dim("skipped — not credited yet");
  if (creditStatus === "credited") {
    setBusy(
      asset.coin === TRADING_COIN
        ? `Moving ${TRADING_COIN} to unified trading...`
        : `Converting ${asset.coin} → ${TRADING_COIN}...`,
    );
    const route = await routeFundDepositToTrading({
      network: ctx.network,
      creds: ctx.creds,
      coin: asset.coin,
    });
    if (route.status === "ready") {
      const via =
        route.via === "convert"
          ? `${asset.coin} → ${TRADING_COIN}`
          : TRADING_COIN;
      tradingLabel = chalk.green(
        `+${route.usdtAmount.toFixed(4)} ${TRADING_COIN} unified (${via})`,
      );
    } else if (route.status === "skipped") {
      tradingLabel = chalk.dim(route.reason);
    } else {
      tradingLabel = chalk.yellow(`routing failed: ${route.error}`);
    }
  }
  setBusy(null);

  const creditLabel =
    creditStatus === "credited"
      ? chalk.green("credited")
      : creditStatus === "pending"
        ? chalk.yellow("pending")
        : chalk.dim("timeout — check Bybit manually");

  const lines = [
    log.blank(),
    log.success(
      `Sent ${chalk.cyan(parsed.amountStr)} ${asset.coin} from ${chalk.cyanBright(ctx.agentName)} to Bybit.`,
    ),
    log.raw(`  ${chalk.dim("To")}       ${depositAddress}`),
    log.raw(`  ${chalk.dim("Chain")}    ${ctx.chainId} (${DEPOSIT_CHAIN})`),
    log.raw(`  ${chalk.dim("Tx")}       ${txHash}`),
  ];
  if (gasMntWei > 0n) {
    lines.push(log.raw(`  ${chalk.dim("Est. gas")} ~${formatMnt(gasMntWei)} MNT`));
  }
  lines.push(log.raw(`  ${chalk.dim("Bybit")}     ${creditLabel}`));
  if (creditStatus === "credited") {
    lines.push(log.raw(`  ${chalk.dim("Trading")}  ${tradingLabel}`));
  }
  lines.push(log.blank());
  return lines;
}
