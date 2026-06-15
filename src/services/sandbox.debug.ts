/**
 * Dedicated sandbox self-debug loop.
 *
 * Agents tend to "one-shot" scripts: they write code, run it once, and trust
 * whatever comes back even if it errored. `developScript` instead runs a bounded
 * write -> run -> read-error -> fix cycle: it executes the code, and on failure
 * asks the model to repair it using the exact error/stderr, repeating up to a
 * capped number of attempts. Only a script that actually runs clean is saved
 * (and `saveScript` itself validates), so broken code never enters the library.
 */
import { runCode, saveScript, type SandboxResult } from "./sandbox.service.js";
import type { SandboxSignal } from "./tools.service.js";
import { completePrompt } from "./llm.service.js";
import type { CodeReporters } from "./sandbox.reporters.js";
import { DEFAULT_DEBUG_ATTEMPTS, DEFAULT_RUN_TIMEOUT_MS } from "./sandbox.constants.js";

export interface DevelopArgs {
  agent: string;
  provider: string;
  model: string;
  apiKey: string;
  /** Sandbox system prompt (already merged with the agent's strategy). */
  system: string;
  /** Plain-language description of what the script must accomplish. */
  goal: string;
  /** Optional starting source. When omitted, the model authors it first. */
  code?: string;
  /** When set, the working script is saved under this name on success. */
  name?: string;
  market?: string;
  interval?: string;
  network?: "mainnet" | "testnet";
  maxAttempts?: number;
  timeoutMs?: number;
  reporters?: CodeReporters;
  signal?: AbortSignal;
}

export interface DevelopResult {
  ok: boolean;
  attempts: number;
  code: string;
  result?: unknown;
  signal?: SandboxSignal | null;
  error?: string;
  saved?: string;
}

const SCRIPT_SHAPE_HINT =
  "The script MUST `export default async (ctx) => { ... }` and return a " +
  "JSON-serializable value (or call ctx.setSignal). `ctx` provides ccxt, ta, " +
  "exchange, fetchOHLCV(symbol,timeframe,limit), fetchTicker, closes/highs/lows/" +
  "volumes(ohlcv), market, symbol, interval, params. " +
  "Return ONLY the full TypeScript source in a single ``` code block, no prose.";

/** Pull the source out of a model reply: first fenced block, else the whole text. */
function extractCode(raw: string): string {
  const fence = raw.match(/```(?:ts|typescript|js|javascript)?\s*([\s\S]*?)```/i);
  if (fence && fence[1]) return fence[1].trim();
  return raw.trim();
}

/** Reshape a run result into the {ok,error,stdout,result} the reporters expect. */
function forReporter(res: SandboxResult): Record<string, unknown> {
  let result: string | undefined;
  try {
    result = res.result === undefined ? undefined : JSON.stringify(res.result);
  } catch {
    result = String(res.result);
  }
  return { ok: res.ok, error: res.error, stdout: res.stdout, result };
}

async function authorInitial(args: DevelopArgs): Promise<string> {
  const reply = await completePrompt({
    provider: args.provider,
    model: args.model,
    apiKey: args.apiKey,
    system: args.system,
    user:
      `Write a sandbox script that accomplishes this goal:\n${args.goal}\n\n` +
      `Market: ${args.market ?? "(default)"} | Timeframe: ${args.interval ?? "(default)"}\n\n` +
      SCRIPT_SHAPE_HINT,
    signal: args.signal,
  });
  return extractCode(reply);
}

async function askForFix(args: DevelopArgs, code: string, res: SandboxResult): Promise<string> {
  const errorText = (res.error || "").trim();
  const stderrText = (res.stderr || "").trim();
  const reply = await completePrompt({
    provider: args.provider,
    model: args.model,
    apiKey: args.apiKey,
    system: args.system,
    user:
      `Your sandbox script failed. Fix it so it runs cleanly and accomplishes:\n${args.goal}\n\n` +
      `--- CURRENT SOURCE ---\n${code}\n\n` +
      `--- ERROR ---\n${errorText || "(none)"}\n` +
      (stderrText ? `--- STDERR ---\n${stderrText.slice(-1500)}\n` : "") +
      `\nDiagnose the cause, then ${SCRIPT_SHAPE_HINT}`,
    signal: args.signal,
  });
  return extractCode(reply);
}

/**
 * Run a script to completion, repairing it on failure up to `maxAttempts` times.
 * Returns the last (working, if ok) source plus the run result or final error.
 */
export async function developScript(args: DevelopArgs): Promise<DevelopResult> {
  const maxAttempts = Math.max(1, args.maxAttempts ?? DEFAULT_DEBUG_ATTEMPTS);
  const timeoutMs = args.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;

  let code = (args.code ?? "").trim();
  if (!code) {
    code = await authorInitial(args);
  }
  if (!code) {
    return { ok: false, attempts: 0, code: "", error: "model produced no code" };
  }

  let attempts = 0;
  let lastError = "";

  while (attempts < maxAttempts) {
    attempts += 1;

    args.reporters?.onToolCall?.("run_code", { code });
    const res = await runCode({
      agent: args.agent,
      code,
      market: args.market,
      interval: args.interval,
      network: args.network ?? "mainnet",
      params: { timeframe: args.interval },
      timeoutMs,
    });
    args.reporters?.onToolResult?.("run_code", forReporter(res));

    if (res.ok) {
      let saved: string | undefined;
      if (args.name) {
        try {
          await saveScript(args.agent, args.name, code);
          saved = args.name;
        } catch {
          // save can still fail validation in rare races; surface as unsaved
        }
      }
      return {
        ok: true,
        attempts,
        code,
        result: res.result,
        signal: res.signal ?? null,
        saved,
      };
    }

    lastError = (res.error || res.stderr || "unknown error").slice(0, 4000);
    if (attempts >= maxAttempts) break;

    try {
      const fixed = await askForFix(args, code, res);
      if (fixed && fixed !== code) {
        code = fixed;
      } else if (!fixed) {
        break; // model gave nothing usable; stop early
      }
    } catch {
      break; // a failed fix request ends the loop with the last error
    }
  }

  return { ok: false, attempts, code, error: lastError };
}
