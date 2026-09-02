import chalk from "chalk";
import { getAgent, updateAgentConfig, type AgentConfig } from "../services/agent.service.js";
import { log } from "../utils/logger.js";

type LimitField =
  | "maxLeverage"
  | "maxPositionUsd"
  | "maxTradesPerDay"
  | "notr"
  | "sl"
  | "tp"
  | "platform"
  | "avantisLeverage";

const FIELD_ALIASES: Record<string, LimitField> = {
  maxleverage: "maxLeverage",
  maxpositionusd: "maxPositionUsd",
  maxtradesperday: "maxTradesPerDay",
  notr: "notr",
  sl: "sl",
  tp: "tp",
  platform: "platform",
  venue: "platform",
  avantislev: "avantisLeverage",
  avantisleverage: "avantisLeverage",
};

function showLimits(cfg: AgentConfig): string[] {
  const cap = cfg.spendingCapUsd ?? 0;
  const maxPos = cfg.maxPositionUsd ?? cap;
  const lines = [
    log.blank(),
    log.heading(`  Limits — ${cfg.name}`),
    log.blank(),
    log.raw(`  ${chalk.dim("Venue".padEnd(18))} ${chalk.white(cfg.platform ?? "Bybit")}${cfg.platform === "Avantis" ? chalk.dim(` (lev ${cfg.avantisLeverage ?? 2}x)`) : ""}`),
    log.raw(`  ${chalk.dim("Spending cap".padEnd(18))} ${cap > 0 ? chalk.green(`$${cap}`) : chalk.dim("disabled")}`),
    log.raw(`  ${chalk.dim("Max position".padEnd(18))} ${maxPos > 0 ? chalk.green(`$${maxPos}`) : chalk.dim("(cap)")}`),
    log.raw(`  ${chalk.dim("Max leverage".padEnd(18))} ${chalk.white(String(cfg.maxLeverage ?? 10))}`),
    log.raw(`  ${chalk.dim("Max trades/day".padEnd(18))} ${chalk.white(String(cfg.maxTradesPerDay ?? 50))}`),
    log.raw(`  ${chalk.dim("NOTR behavior".padEnd(18))} ${chalk.white(cfg.notrBehavior ?? "hold")}`),
    log.raw(
      `  ${chalk.dim("Auto SL / TP".padEnd(18))} ${cfg.defaultSlPct != null ? `${cfg.defaultSlPct}%` : chalk.dim("off")} / ${cfg.defaultTpPct != null ? `${cfg.defaultTpPct}%` : chalk.dim("off")}`,
    ),
    log.blank(),
  ];
  return lines;
}

export async function limitsCommand(args: string[]): Promise<string[]> {
  const name = args[0];
  if (!name) {
    return [log.error("Usage: limits <agent> [field] [value]")];
  }

  let cfg: AgentConfig;
  try {
    cfg = await getAgent(name);
  } catch (err) {
    return [log.error((err as Error).message)];
  }

  const fieldRaw = args[1]?.toLowerCase();
  const valueRaw = args[2];

  if (!fieldRaw) {
    return showLimits(cfg);
  }

  const field = FIELD_ALIASES[fieldRaw];
  if (!field) {
    return [
      log.error(
        `Unknown field "${args[1]}". Use: maxLeverage, maxPositionUsd, maxTradesPerDay, notr, sl, tp`,
      ),
    ];
  }

  if (valueRaw === undefined) {
    return showLimits(cfg);
  }

  const patch: Partial<AgentConfig> = {};

  if (field === "notr") {
    const v = valueRaw.toLowerCase();
    if (v !== "hold" && v !== "flat") {
      return [log.error('NOTR behavior must be "hold" or "flat".')];
    }
    patch.notrBehavior = v;
  } else if (field === "platform") {
    const v = valueRaw.toLowerCase();
    if (v !== "bybit" && v !== "avantis") {
      return [log.error('Venue must be "Bybit" or "Avantis".')];
    }
    patch.platform = v === "avantis" ? "Avantis" : "Bybit";
  } else if (field === "avantisLeverage") {
    const n = Number(valueRaw);
    if (!Number.isFinite(n) || n <= 0) {
      return [log.error("Avantis leverage must be a positive number.")];
    }
    patch.avantisLeverage = n;
  } else if (field === "sl" || field === "tp") {
    const n = Number(valueRaw);
    if (!Number.isFinite(n) || n <= 0) {
      return [log.error("SL/TP must be a positive percent.")];
    }
    if (field === "sl") patch.defaultSlPct = n;
    else patch.defaultTpPct = n;
  } else {
    const n = Number(valueRaw);
    if (!Number.isFinite(n) || n < 0) {
      return [log.error("Value must be a non-negative number.")];
    }
    if (field === "maxLeverage") patch.maxLeverage = n;
    if (field === "maxPositionUsd") patch.maxPositionUsd = n;
    if (field === "maxTradesPerDay") patch.maxTradesPerDay = n;
  }

  try {
    await updateAgentConfig(name, patch);
  } catch (err) {
    return [log.error((err as Error).message)];
  }

  return [
    log.success(`Updated limits for ${chalk.cyanBright(name)}.`),
    ...showLimits({ ...cfg, ...patch }),
  ];
}
