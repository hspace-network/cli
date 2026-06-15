/**
 * Pre-discussion research loop.
 *
 * Runs the agent's reasoning-with-tools loop to analyze a market, optionally
 * authoring and saving sandbox scripts, and captures the structured signal the
 * model emits via set_signal. The signal is persisted per room so the (fast)
 * discussion vote path can inject it without doing heavy work inside the node's
 * vote timeout. This is the "before discussion" code path.
 */
import { runToolLoop, buildSandboxSystemPrompt } from "./llm.service.js";
import { buildSandboxTools, type SandboxSignal } from "./tools.service.js";
import { ensureSandbox, listScripts } from "./sandbox.service.js";
import { writeSignals } from "./signals.service.js";
import {
  loadCliConfig,
  getCachedNodeConfig,
  getEffectiveSelection,
  getProviderApiKey,
} from "./config.service.js";
import { getAgent } from "./agent.service.js";
import { resolveStrategyForAgent } from "./strategy.service.js";
import { DEFAULT_RESEARCH_BUDGET_MS } from "./sandbox.constants.js";

export interface ResearchArgs {
  agent: string;
  provider: string;
  model: string;
  apiKey: string;
  strategy?: string;
  market: string;
  interval: string;
  roomId?: string;
  network?: "mainnet" | "testnet";
  maxIters?: number;
  maxMs?: number;
  persist?: boolean;
  onToken?: (chunk: string) => void;
  onToolCall?: (name: string, args: Record<string, unknown>) => void;
  onToolResult?: (name: string, result: unknown) => void;
  signal?: AbortSignal;
}

export interface ResearchResult {
  signal: SandboxSignal | null;
  text: string;
  toolCalls: number;
  toolsUsed: boolean;
}

export async function runResearch(args: ResearchArgs): Promise<ResearchResult> {
  await ensureSandbox(args.agent);

  let captured: SandboxSignal | null = null;
  const system = await buildSandboxSystemPrompt(args.strategy);
  const reporters =
    args.onToolCall && args.onToolResult
      ? { onToolCall: args.onToolCall, onToolResult: args.onToolResult }
      : undefined;
  const tools = buildSandboxTools({
    agent: args.agent,
    market: args.market,
    interval: args.interval,
    network: args.network ?? "mainnet",
    onSignal: (s) => {
      captured = s;
    },
    llm: {
      provider: args.provider,
      model: args.model,
      apiKey: args.apiKey,
      system,
    },
    reporters,
  });
  const existing = await listScripts(args.agent);
  const inventory =
    existing.length > 0
      ? `You already have these saved scripts: ${existing.map((s) => s.name).join(", ")}. ` +
        `If one already computes your signal, RUN it (run_script) and use its output; only rewrite it under the SAME name if it is broken or wrong. Do NOT create a second script for the same purpose. `
      : `You have no saved scripts yet. If you author one, save it under a stable name like "signal" and reuse it on later runs instead of making new variants. `;

  const userMessage =
    `Assess ${args.market} on the ${args.interval} timeframe for its near-term direction. ` +
    `Only write or run code if your strategy needs computed or live data; otherwise decide directly and be quick. ` +
    `Your strategy may reference data for OTHER symbols than the room market (for example a BTC volume gate) — fetch those too when needed. ` +
    inventory +
    `When you read candles, gate decisions on the LAST CLOSED candle (use ctx.lastClosed / ctx.closedOHLCV / ctx.fetchClosedOHLCV), never the live in-progress candle, so the same period gives the same number every run. ` +
    `Finish by emitting your conclusion with set_signal (bias, confidence 0..1, short note); if you have no strong data-driven view, a NOTR with low confidence is fine.`;

  const loop = await runToolLoop({
    provider: args.provider,
    model: args.model,
    apiKey: args.apiKey,
    system,
    userMessage,
    tools,
    maxIters: args.maxIters,
    maxMs: args.maxMs,
    onToken: args.onToken,
    onToolCall: args.onToolCall,
    onToolResult: args.onToolResult,
    signal: args.signal,
  });

  const persist = args.persist ?? true;
  const finalSignal = captured as SandboxSignal | null;
  if (persist && finalSignal) {
    const roomId = args.roomId ?? `${args.market}:${args.interval}`;
    try {
      await writeSignals(args.agent, roomId, finalSignal);
    } catch {
      // signal persistence is best-effort; never break the caller
    }
  }

  return {
    signal: finalSignal,
    text: loop.text,
    toolCalls: loop.toolCalls,
    toolsUsed: loop.toolsUsed,
  };
}

// --- Shared resolver + post-session reflection -----------------------------

export interface ResolvedResearchContext {
  agent: string;
  provider: string;
  model: string;
  apiKey: string;
  strategy?: string;
  market: string;
  interval: string;
  roomId: string;
  researchBudgetMs: number;
}

function splitRoom(roomId: string): { market: string; interval: string } {
  const [market = roomId, interval = ""] = roomId.split(":");
  return { market, interval };
}

/**
 * Resolve everything needed to run sandbox research for an agent in a room.
 * Returns null when the agent has no LLM configured or sandbox is disabled, so
 * callers can silently skip (the discussion never depends on this succeeding).
 */
export async function resolveResearchContext(
  agentName: string,
  roomId: string,
): Promise<ResolvedResearchContext | null> {
  const cfg = await loadCliConfig();
  const nodeCfg = getCachedNodeConfig();
  const effective = getEffectiveSelection(cfg, nodeCfg?.defaults, nodeCfg?.providers);
  if (!effective.provider || !effective.model) return null;
  const apiKey = getProviderApiKey(cfg, effective.provider);
  if (!apiKey) return null;

  let agentCfg;
  try {
    agentCfg = await getAgent(agentName);
  } catch {
    return null;
  }
  if (agentCfg.sandbox?.enabled === false) return null;

  const strategy = (await resolveStrategyForAgent(agentName)) ?? undefined;
  const { market, interval } = splitRoom(roomId);

  return {
    agent: agentName,
    provider: effective.provider,
    model: effective.model,
    apiKey,
    strategy,
    market,
    interval,
    roomId,
    researchBudgetMs: agentCfg.sandbox?.researchBudgetMs ?? DEFAULT_RESEARCH_BUDGET_MS,
  };
}

/**
 * Post-session reflection: lets the agent improve its saved scripts based on the
 * just-closed session. Best-effort and bounded; it does not emit a new signal.
 */
export async function runReflection(
  ctx: ResolvedResearchContext,
  outcome: { tally?: { LONG: number; SHORT: number; NOTR: number }; rounds?: number },
): Promise<void> {
  // Nothing to improve if the agent never saved a script — skip the (costly) loop.
  const scripts = await listScripts(ctx.agent);
  if (scripts.length === 0) return;

  const system = await buildSandboxSystemPrompt(ctx.strategy);
  const tools = buildSandboxTools({
    agent: ctx.agent,
    market: ctx.market,
    interval: ctx.interval,
    network: "mainnet",
    llm: {
      provider: ctx.provider,
      model: ctx.model,
      apiKey: ctx.apiKey,
      system,
    },
  });
  const tally = outcome.tally
    ? `tally LONG=${outcome.tally.LONG} SHORT=${outcome.tally.SHORT} NOTR=${outcome.tally.NOTR}`
    : "outcome unknown";
  const userMessage =
    `The discussion session for ${ctx.market} on ${ctx.interval} just closed (${tally}). ` +
    `Briefly reflect on whether your saved signal script could be improved for next time. ` +
    `If so, update it with save_script and verify it by running it. Do NOT emit a signal now.`;

  await runToolLoop({
    provider: ctx.provider,
    model: ctx.model,
    apiKey: ctx.apiKey,
    system,
    userMessage,
    tools,
    maxIters: 4,
    maxMs: 30_000,
  });
}
