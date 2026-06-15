import chalk from "chalk";
import {
  createWithdraw,
  getBybitMntBalances,
  getMntChainInfo,
  getWithdrawableMnt,
  transferUnifiedToFund,
  DEPOSIT_COIN,
  DEPOSIT_CHAIN,
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

  const amount = Number(amountStr);
  if (!Number.isFinite(amount) || amount <= 0) {
    return { lines: [log.error(`Invalid amount "${amountStr}".`)] };
  }

  let chainInfo: { withdrawMin: number; withdrawFee: number };
  let withdrawable: number;
  try {
    [chainInfo, withdrawable] = await Promise.all([
      getMntChainInfo(ctx.network, ctx.creds),
      getWithdrawableMnt(ctx.network, ctx.creds),
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
          `Minimum withdraw is ${chainInfo.withdrawMin} ${DEPOSIT_COIN} on ${DEPOSIT_CHAIN}.`,
        ),
      ],
    };
  }

  const totalNeeded = amount + chainInfo.withdrawFee;
  if (withdrawable < totalNeeded) {
    return {
      lines: [
        log.error(
          `Insufficient withdrawable balance: ${withdrawable.toFixed(4)} ${DEPOSIT_COIN} (need ${totalNeeded.toFixed(4)} incl. fee).`,
        ),
        log.dim(
          "  Funds must be in FUND account. Trading profits may sit in UNIFIED — we can transfer before withdraw.",
        ),
      ],
    };
  }

  const feeNote =
    chainInfo.withdrawFee > 0
      ? ` (fee ~${chainInfo.withdrawFee} ${DEPOSIT_COIN})`
      : "";
  const prompt = [
    `${chalk.yellow("[!]")} Withdraw ${chalk.cyan(amountStr)} ${DEPOSIT_COIN} from Bybit`,
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
          const balances = await getBybitMntBalances(ctx.network, ctx.creds);
          if (balances.fund < totalNeeded && balances.unified > 0) {
            const move = Math.min(
              balances.unified,
              totalNeeded - balances.fund,
            ).toFixed(8);
            await transferUnifiedToFund(ctx.network, ctx.creds, move);
          }

          const withdrawId = await createWithdraw({
            network: ctx.network,
            creds: ctx.creds,
            address: ctx.walletAddress,
            amount: amountStr,
          });
          setBusy(null);

          return {
            lines: [
              log.blank(),
              log.success(
                `Withdraw submitted: ${chalk.cyan(amountStr)} ${DEPOSIT_COIN} → ${chalk.cyanBright(ctx.agentName)}.`,
              ),
              log.raw(`  ${chalk.dim("Id")}     ${withdrawId}`),
              log.raw(`  ${chalk.dim("Chain")}  ${DEPOSIT_CHAIN} (${ctx.chainId})`),
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
