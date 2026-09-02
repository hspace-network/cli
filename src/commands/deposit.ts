import chalk from "chalk";
import {
  getDepositAddress,
  getCoinChainInfo,
  pollDepositCredit,
  routeFundDepositToTrading,
  UNIFIED_COIN,
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
    return { error: "Usage: deposit <agent> <amount> [coin]" };
  }
  const agentName = args[0]!;
  const last = args[args.length - 1]!.trim();
  // A non-numeric trailing arg is a coin symbol (e.g. USDC, ETH, MNT, USDT).
  if (args.length >= 3 && !Number.isFinite(Number(last))) {
    return { agentName, amountStr: args[1]!, coinInput: last.toUpperCase() };
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
  return getWalletTokenBalance({
    chainId,
    tokenAddress: asset.tokenAddress!,
    walletAddress,
  });
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

  const { profile } = ctx;

  // Avantis agents trade on-chain from their own wallet — depositing to a CEX
  // would strand their USDC collateral off Base. Route them to wallet funding.
  if (ctx.platform === "Avantis") {
    return [
      log.error(`${ctx.agentName} is an Avantis agent — it funds itself.`),
      log.dim(
        `  Avantis trades on-chain from the agent wallet. Send ${profile.stableCoin} to ${ctx.walletAddress} on ${profile.label}, then check it with "balance". No Bybit deposit needed.`,
      ),
    ];
  }

  // The Bybit CEX funding rail is enabled on Mantle only.
  if (!profile.bybitRail) {
    return [
      log.error(`Bybit deposits aren't wired for ${profile.label}.`),
      log.dim(
        `  The Bybit funding rail runs on Mantle. Switch chain to mantle in "settings" to deposit.`,
      ),
    ];
  }

  if (!ctx.creds) {
    return [log.error('Set your Bybit API key in settings ("settings" → Platform).')];
  }
  const creds = ctx.creds;

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
      getDepositAddress(ctx.network, creds, asset.coin, profile.bybitChain),
      getCoinChainInfo(ctx.network, creds, asset.coin, profile.bybitChain),
      getWalletAssetBalance(asset, ctx.chainId, ctx.walletAddress),
    ]);
  } catch (err) {
    const msg =
      err instanceof BybitApiError ? err.message : (err as Error).message;
    return [log.error(`Could not prepare deposit: ${msg}`)];
  }

  let gasNativeWei = 0n;
  try {
    if (asset.kind === "native") {
      gasNativeWei = await estimateMntTransferGas({
        chainId: ctx.chainId,
        from: ctx.privateKey,
        to: depositAddress,
        amountWei,
      });
    } else {
      gasNativeWei = await estimateTokenTransferGas({
        chainId: ctx.chainId,
        from: ctx.privateKey,
        tokenAddress: asset.tokenAddress!,
        to: depositAddress,
        amountWei,
      });
    }
  } catch {
    gasNativeWei = 0n;
  }

  const amountNum = Number(parsed.amountStr);
  if (chainInfo.depositMin > 0 && amountNum < chainInfo.depositMin) {
    return [
      log.error(
        `Minimum deposit is ${chainInfo.depositMin} ${asset.coin} on ${profile.bybitChain}.`,
      ),
    ];
  }

  const walletNativeWei = await getWalletMntBalance(ctx.walletAddress, ctx.chainId);
  const walletLabel = formatAssetAmount(asset, walletWei);
  const gas = profile.nativeCoin;

  if (asset.kind === "native") {
    const required = amountWei + gasNativeWei;
    if (walletWei < required) {
      return [
        log.error(
          `Insufficient wallet balance: ${walletLabel} ${asset.coin}. Need ${parsed.amountStr} + ~${formatMnt(gasNativeWei)} gas.`,
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
    if (walletNativeWei < gasNativeWei) {
      return [
        log.error(
          `Insufficient ${gas} for gas: ${formatMnt(walletNativeWei)} ${gas}, need ~${formatMnt(gasNativeWei)}.`,
        ),
      ];
    }
  }

  setBusy(`Sending ${asset.coin} on ${profile.label}...`);
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
        tokenAddress: asset.tokenAddress!,
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
      creds,
      coin: asset.coin,
      txHash,
    });
  } catch {
    creditStatus = "timeout";
  }

  let tradingLabel = chalk.dim("skipped — not credited yet");
  if (creditStatus === "credited") {
    setBusy(
      asset.coin === UNIFIED_COIN
        ? `Moving ${UNIFIED_COIN} to unified trading...`
        : `Converting ${asset.coin} → ${UNIFIED_COIN}...`,
    );
    const route = await routeFundDepositToTrading({
      network: ctx.network,
      creds,
      coin: asset.coin,
    });
    if (route.status === "ready") {
      const via =
        route.via === "convert"
          ? `${asset.coin} → ${UNIFIED_COIN}`
          : UNIFIED_COIN;
      tradingLabel = chalk.green(
        `+${route.usdtAmount.toFixed(4)} ${UNIFIED_COIN} unified (${via})`,
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
    log.raw(`  ${chalk.dim("Chain")}    ${ctx.chainId} (${profile.bybitChain})`),
    log.raw(`  ${chalk.dim("Tx")}       ${txHash}`),
  ];
  if (gasNativeWei > 0n) {
    lines.push(log.raw(`  ${chalk.dim("Est. gas")} ~${formatMnt(gasNativeWei)} ${gas}`));
  }
  lines.push(log.raw(`  ${chalk.dim("Bybit")}     ${creditLabel}`));
  if (creditStatus === "credited") {
    lines.push(log.raw(`  ${chalk.dim("Trading")}  ${tradingLabel}`));
  }
  lines.push(log.blank());
  return lines;
}
