import chalk from "chalk";
import {
  createWithdraw,
  getBybitCoinBalances,
  getCoinChainInfo,
  getWithdrawable,
  transferUnifiedToFund,
} from "../services/bybit-asset.service.js";
import { BybitApiError } from "../services/bybit.service.js";
import { setBusy } from "../utils/busy.js";
import { log } from "../utils/logger.js";
import type { InteractiveResult } from "./index.js";
import { resolveBalanceContext } from "./_balance-shared.js";

export async function withdrawCommand(args: string[]): Promise<InteractiveResult> {
  const agentName = args[0];
  const amountStr = args[1];
  if (!amountStr) {
    return { lines: [log.error("Usage: withdraw <agent> <amount>")] };
  }

  const ctx = await resolveBalanceContext(agentName);
  if ("error" in ctx) {
    return { lines: [log.error(ctx.error)] };
  }

  const { profile } = ctx;
  const coin = profile.railCoin;
  const bybitChain = profile.bybitChain;

  if (ctx.platform === "Avantis") {
    return {
      lines: [
        log.error(`${ctx.agentName} is an Avantis agent — no Bybit withdrawal.`),
        log.dim(
          `  Avantis keeps ${profile.stableCoin} in the agent's own wallet on ${profile.label}. Move it on-chain from that wallet.`,
        ),
      ],
    };
  }

  if (!profile.bybitRail) {
    return {
      lines: [
        log.error(`Bybit withdrawals aren't wired for ${profile.label}.`),
        log.dim(`  The Bybit funding rail runs on Mantle. Switch chain to mantle in "settings" to withdraw.`),
      ],
    };
  }

  if (!ctx.creds) {
    return {
      lines: [log.error('Set your Bybit API key in settings ("settings" → Platform).')],
    };
  }
  const creds = ctx.creds;

  const amount = Number(amountStr);
  if (!Number.isFinite(amount) || amount <= 0) {
    return { lines: [log.error(`Invalid amount "${amountStr}".`)] };
  }

  let chainInfo: { withdrawMin: number; withdrawFee: number };
  let withdrawable: number;
  try {
    [chainInfo, withdrawable] = await Promise.all([
      getCoinChainInfo(ctx.network, creds, coin, bybitChain),
      getWithdrawable(ctx.network, creds, coin),
    ]);
  } catch (err) {
    const msg =
      err instanceof BybitApiError
        ? err.message
        : (err as Error).message;
    return { lines: [log.error(`Could not load withdraw info: ${msg}`)] };
  }

  if (chainInfo.withdrawMin > 0 && amount < chainInfo.withdrawMin) {
    return {
      lines: [
        log.error(
          `Minimum withdraw is ${chainInfo.withdrawMin} ${coin} on ${bybitChain}.`,
        ),
      ],
    };
  }

  const totalNeeded = amount + chainInfo.withdrawFee;
  if (withdrawable < totalNeeded) {
    return {
      lines: [
        log.error(
          `Insufficient withdrawable balance: ${withdrawable.toFixed(4)} ${coin} (need ${totalNeeded.toFixed(4)} incl. fee).`,
        ),
        log.dim(
          "  Funds must be in FUND account. Trading profits may sit in UNIFIED — we can transfer before withdraw.",
        ),
      ],
    };
  }

  const feeNote =
    chainInfo.withdrawFee > 0
      ? ` (fee ~${chainInfo.withdrawFee} ${coin})`
      : "";
  const prompt = [
    `${chalk.yellow("[!]")} Withdraw ${chalk.cyan(amountStr)} ${coin} from Bybit`,
    `to ${chalk.cyanBright(ctx.agentName)} wallet`,
    chalk.dim(ctx.walletAddress),
    `on ${ctx.chainId}${feeNote}?`,
    chalk.dim("(y/N)"),
  ].join(" ");

  return {
    lines: [
      log.dim(
        "  Requires Bybit API key with Wallet / Withdraw permission and a whitelisted address.",
      ),
    ],
    prompt: {
      prompt,
      onResponse: async (input: string) => {
        if (input.trim().toLowerCase() !== "y") {
          return { lines: [log.dim("  Cancelled.")] };
        }

        setBusy("Submitting Bybit withdraw...");
        try {
          const balances = await getBybitCoinBalances(ctx.network, creds, coin);
          if (balances.fund < totalNeeded && balances.unified > 0) {
            const move = Math.min(
              balances.unified,
              totalNeeded - balances.fund,
            ).toFixed(8);
            await transferUnifiedToFund(ctx.network, creds, coin, move);
          }

          const withdrawId = await createWithdraw({
            network: ctx.network,
            creds,
            coin,
            bybitChain,
            address: ctx.walletAddress,
            amount: amountStr,
          });
          setBusy(null);

          return {
            lines: [
              log.blank(),
              log.success(
                `Withdraw submitted: ${chalk.cyan(amountStr)} ${coin} → ${chalk.cyanBright(ctx.agentName)}.`,
              ),
              log.raw(`  ${chalk.dim("Id")}     ${withdrawId}`),
              log.raw(`  ${chalk.dim("Chain")}  ${bybitChain} (${ctx.chainId})`),
              log.dim(
                "  Bybit may require email/2FA for new addresses. Check your Bybit account.",
              ),
              log.blank(),
            ],
          };
        } catch (err) {
          setBusy(null);
          const msg =
            err instanceof BybitApiError
              ? `${err.message} — ensure Withdraw API permission and whitelisted address.`
              : (err as Error).message;
          return { lines: [log.error(`Withdraw failed: ${msg}`)] };
        }
      },
    },
  };
}
