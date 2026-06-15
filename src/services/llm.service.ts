import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import type { ChatMessage } from "./conversation.service.js";
import {
  toOpenAITools,
  toAnthropicTools,
  dispatchTool,
  type ToolSpec,
} from "./tools.service.js";

// Client factory seam — overridable so tests can inject a mock provider.
let makeOpenAI = (apiKey: string, baseURL?: string): OpenAI =>
  new OpenAI({ apiKey, baseURL });
let makeAnthropic = (apiKey: string): Anthropic => new Anthropic({ apiKey });

export function __setLlmClients(opts: {
  openai?: (apiKey: string, baseURL?: string) => OpenAI;
  anthropic?: (apiKey: string) => Anthropic;
}): void {
  if (opts.openai) makeOpenAI = opts.openai;
  if (opts.anthropic) makeAnthropic = opts.anthropic;
}

export interface AskArgs {
  provider: string;
  model: string;
  apiKey: string;
  question: string;
  onToken: (chunk: string) => void;
  signal?: AbortSignal;
  strategy?: string;
  history?: ChatMessage[];
}

interface PromptsFile {
  system: {
    ask: string;
    strategyPreamble: string;
    vote: string;
    discussion: string;
    sandbox?: string;
  };
}

const DEFAULT_SANDBOX_SYSTEM =
  "You are an autonomous crypto-trading research agent with a code sandbox. " +
  "Use the tools to fetch market data with ccxt, compute indicators with technicalindicators, " +
  "backtest ideas, and save reusable scripts. Prefer running a previously saved script over " +
  "rewriting it. When finished, call set_signal with your bias (LONG/SHORT/NOTR), a 0..1 confidence, " +
  "and a short note. Ground every decision in live data and your strategy.";

/**
 * Appended to the vote system prompt when the agent is given sandbox tools, so
 * it fetches the data its strategy needs instead of claiming it is unavailable.
 */
const SANDBOX_DECISION_HINT =
  "You have a code sandbox. If your strategy depends on market data you do not " +
  "already have — an indicator value, a volume threshold, or another symbol such " +
  "as BTC — obtain it before deciding: run one of your saved scripts (preferred, " +
  "fast) or write a short ccxt fetch with run_code. Never claim data is " +
  "'not provided' or 'unavailable' — you can fetch it. If your strategy needs no " +
  "external data (for example a fixed directional rule), answer immediately " +
  "without calling any tools. Keep tool use minimal, then output ONLY the JSON vote.";

/** Optional sandbox tools that make a vote decision tool-capable. */
export interface VoteToolOptions {
  tools?: ToolSpec[];
  maxIters?: number;
  maxMs?: number;
  onToolCall?: (name: string, args: Record<string, unknown>) => void;
  onToolResult?: (name: string, result: unknown) => void;
}

let cachedPrompts: PromptsFile | null = null;

async function loadPrompts(): Promise<PromptsFile> {
  if (cachedPrompts) return cachedPrompts;
  const path = fileURLToPath(new URL("../../data/prompts.json", import.meta.url));
  const raw = await readFile(path, "utf-8");
  const parsed = JSON.parse(raw) as PromptsFile;
  if (!parsed?.system?.ask || typeof parsed.system.ask !== "string") {
    throw new Error('prompts.json is missing system.ask string.');
  }
  if (!parsed.system.strategyPreamble || typeof parsed.system.strategyPreamble !== "string") {
    throw new Error('prompts.json is missing system.strategyPreamble string.');
  }
  cachedPrompts = parsed;
  return parsed;
}

function appendStrategy(base: string, strategy: string | undefined, preamble: string): string {
  if (!strategy) return base;
  const block = preamble.replace(/\{\{strategy\}\}/g, strategy);
  return `${base}\n\n${block}`;
}

function buildSystemPrompt(prompts: PromptsFile, strategy?: string): string {
  return appendStrategy(prompts.system.ask, strategy, prompts.system.strategyPreamble);
}

export async function buildSandboxSystemPrompt(strategy?: string): Promise<string> {
  const prompts = await loadPrompts();
  const base = prompts.system.sandbox ?? DEFAULT_SANDBOX_SYSTEM;
  return appendStrategy(base, strategy, prompts.system.strategyPreamble);
}

const ZAI_BASE_URL = "https://api.z.ai/api/paas/v4/";

async function askOpenAICompatible(
  args: AskArgs,
  system: string,
  baseURL?: string,
): Promise<void> {
  const client = makeOpenAI(args.apiKey, baseURL);
  const history = args.history ?? [];
  const stream = await client.chat.completions.create(
    {
      model: args.model,
      stream: true,
      messages: [
        { role: "system", content: system },
        ...history.map((m) => ({ role: m.role, content: m.content })),
        { role: "user", content: args.question },
      ],
    },
    { signal: args.signal },
  );

  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta?.content;
    if (delta) args.onToken(delta);
  }
}

async function askClaude(args: AskArgs, system: string): Promise<void> {
  const client = makeAnthropic(args.apiKey);
  const history = args.history ?? [];
  const stream = client.messages.stream(
    {
      model: args.model,
      max_tokens: 1024,
      system,
      messages: [
        ...history.map((m) => ({ role: m.role, content: m.content })),
        { role: "user", content: args.question },
      ],
    },
    { signal: args.signal },
  );

  stream.on("text", (text: string) => {
    if (text) args.onToken(text);
  });

  await stream.finalMessage();
}

async function dispatch(args: AskArgs, system: string): Promise<void> {
  const provider = args.provider;

  if (provider === "OpenAI") {
    return askOpenAICompatible(args, system);
  }
  if (provider === "z.ai") {
    return askOpenAICompatible(args, system, ZAI_BASE_URL);
  }
  if (provider === "Claude") {
    return askClaude(args, system);
  }

  throw new Error(`Unsupported provider "${provider}".`);
}

export async function askLLM(args: AskArgs): Promise<void> {
  const prompts = await loadPrompts();
  const system = buildSystemPrompt(prompts, args.strategy);
  return dispatch(args, system);
}

/**
 * One-shot, non-streaming completion with an explicit system prompt. Used by the
 * sandbox self-debug loop to ask the model to author or fix a script.
 */
export async function completePrompt(args: {
  provider: string;
  model: string;
  apiKey: string;
  system: string;
  user: string;
  signal?: AbortSignal;
}): Promise<string> {
  return completeText(
    {
      provider: args.provider,
      model: args.model,
      apiKey: args.apiKey,
      question: args.user,
      onToken: () => {},
      signal: args.signal,
    },
    args.system,
  );
}

export interface DiscussionTurn {
  agentName: string;
  content: string;
}

export interface DiscussionContext {
  provider: string;
  model: string;
  apiKey: string;
  agentName: string;
  strategy?: string;
  market: string;
  interval: string;
  transcript: DiscussionTurn[];
  capUsd: number;
  /** Compact research signals from the agent's sandbox, injected into prompts. */
  signals?: string;
  /** Recap of this agent's own recent decisions + outcomes in this market. */
  memory?: string;
  /** One-line summary of the agent's current open position in this market. */
  position?: string;
  signal?: AbortSignal;
}

export type VoteWay = "LONG" | "SHORT" | "NOTR";

export interface VoteResult {
  way: VoteWay;
  rationale: string;
  sizeUsd: number;
}

function formatTranscript(transcript: DiscussionTurn[]): string {
  if (transcript.length === 0) {
    return "No messages have been exchanged yet; you are among the first to speak.";
  }
  return transcript
    .map((t) => `${t.agentName}: ${t.content}`)
    .join("\n");
}

function signalsBlock(signals?: string): string {
  if (!signals || !signals.trim()) return "";
  return (
    "\n\nSupplementary research from your sandbox (advisory only — it may be " +
    "incomplete or wrong; your strategy and the discussion decide, not this):\n" +
    signals.trim() +
    "\n"
  );
}

function positionBlock(position?: string): string {
  if (!position || !position.trim()) return "";
  return `\n\nYour current position in this market: ${position.trim()}`;
}

function memoryBlock(memory?: string): string {
  if (!memory || !memory.trim()) return "";
  return (
    "\n\nYour own recent decisions in this market and how they turned out " +
    "(your track record — be consistent with it unless the setup has clearly " +
    "changed, and learn from past mistakes):\n" +
    memory.trim()
  );
}

async function completeText(args: AskArgs, system: string): Promise<string> {
  let text = "";
  const accumulate: AskArgs = {
    ...args,
    onToken: (chunk: string) => {
      text += chunk;
    },
  };
  await dispatch(accumulate, system);
  return text.trim();
}

function clampSize(value: unknown, way: VoteWay, capUsd: number): number {
  if (way === "NOTR") return 0;
  const cap = Number.isFinite(capUsd) && capUsd > 0 ? capUsd : 0;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(n, cap);
}

/** Find the last balanced top-level {...} object in a string, or null. */
function lastBalancedObject(s: string): string | null {
  let depth = 0;
  let start = -1;
  let last: string | null = null;
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (c === "{") {
      if (depth === 0) start = i;
      depth += 1;
    } else if (c === "}") {
      if (depth > 0) {
        depth -= 1;
        if (depth === 0 && start >= 0) last = s.slice(start, i + 1);
      }
    }
  }
  return last;
}

/**
 * Extract the JSON vote object from a model response. Returns the LAST balanced
 * object so that tool-using votes (which may prepend reasoning/observations
 * before the final JSON) parse correctly rather than greedily matching across
 * unrelated braces.
 */
function extractJsonObject(raw: string): string | null {
  const scanned = lastBalancedObject(raw);
  if (scanned) return scanned;
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return fenced ? lastBalancedObject(fenced[1]!) : null;
}

function parseVote(raw: string, capUsd: number): VoteResult {
  const fallback: VoteResult = {
    way: "NOTR",
    rationale: raw.slice(0, 280),
    sizeUsd: 0,
  };
  const jsonText = extractJsonObject(raw);
  if (!jsonText) return fallback;
  try {
    const parsed = JSON.parse(jsonText) as {
      way?: unknown;
      rationale?: unknown;
      sizeUsd?: unknown;
    };
    const wayRaw =
      typeof parsed.way === "string" ? parsed.way.trim().toUpperCase() : "";
    const way: VoteWay =
      wayRaw === "LONG" || wayRaw === "SHORT" ? (wayRaw as VoteWay) : "NOTR";
    const rationale =
      typeof parsed.rationale === "string" ? parsed.rationale.trim() : "";
    return { way, rationale, sizeUsd: clampSize(parsed.sizeUsd, way, capUsd) };
  } catch {
    return fallback;
  }
}

/** Test seam: parse a raw model response into a vote (covers tool-using output). */
export function __parseVoteForTest(raw: string, capUsd: number): VoteResult {
  return parseVote(raw, capUsd);
}

export async function askVote(
  ctx: DiscussionContext,
  phase: "initial" | "final",
  opts?: VoteToolOptions,
): Promise<VoteResult> {
  const prompts = await loadPrompts();
  const system = appendStrategy(
    prompts.system.vote,
    ctx.strategy,
    prompts.system.strategyPreamble,
  );

  const intro =
    phase === "initial"
      ? `You are about to enter a discussion about ${ctx.market} on the ${ctx.interval} timeframe. State your opening position.`
      : `The discussion about ${ctx.market} on the ${ctx.interval} timeframe is over. State your final position.`;
  const capLine =
    ctx.capUsd > 0
      ? `Your spending cap for this trade is $${ctx.capUsd}. Choose a sizeUsd between 0 and ${ctx.capUsd}.`
      : `Your spending cap is $0, so sizeUsd must be 0 (you cannot open a position right now).`;
  const question = `${intro}\n\n${capLine}${positionBlock(ctx.position)}${memoryBlock(
    ctx.memory,
  )}\n\nDiscussion so far:\n${formatTranscript(
    ctx.transcript,
  )}${signalsBlock(ctx.signals)}\n\nRespond with the required JSON object only.`;

  // Tool-capable decision: when sandbox tools are supplied, let the agent fetch
  // any data its strategy needs (run a saved script, write a quick ccxt fetch)
  // before voting, instead of claiming data is unavailable.
  if (opts?.tools && opts.tools.length > 0) {
    const toolSystem = `${system}\n\n${SANDBOX_DECISION_HINT}`;
    const loop = await runToolLoop({
      provider: ctx.provider,
      model: ctx.model,
      apiKey: ctx.apiKey,
      system: toolSystem,
      userMessage: `${question}\n\nIf your strategy depends on market data you do not already have (an indicator, a volume threshold, another symbol such as BTC), use your tools to obtain it first, then output ONLY the final JSON vote object.`,
      tools: opts.tools,
      maxIters: opts.maxIters ?? 3,
      maxMs: opts.maxMs ?? 24_000,
      onToolCall: opts.onToolCall,
      onToolResult: opts.onToolResult,
      signal: ctx.signal,
    });
    return parseVote(loop.text, ctx.capUsd);
  }

  const raw = await completeText(
    {
      provider: ctx.provider,
      model: ctx.model,
      apiKey: ctx.apiKey,
      question,
      signal: ctx.signal,
      onToken: () => {},
    },
    system,
  );
  return parseVote(raw, ctx.capUsd);
}

export async function askDiscussionTurn(
  ctx: DiscussionContext,
  round: number,
): Promise<string> {
  const prompts = await loadPrompts();
  const system = appendStrategy(
    prompts.system.discussion,
    ctx.strategy,
    prompts.system.strategyPreamble,
  );

  const question = `Market: ${ctx.market} | Timeframe: ${ctx.interval} | Round: ${round}${positionBlock(
    ctx.position,
  )}${memoryBlock(ctx.memory)}\n\nDiscussion so far:\n${formatTranscript(
    ctx.transcript,
  )}${signalsBlock(ctx.signals)}\n\nIt is your turn to speak. Contribute your message now.`;

  return completeText(
    {
      provider: ctx.provider,
      model: ctx.model,
      apiKey: ctx.apiKey,
      question,
      signal: ctx.signal,
      onToken: () => {},
    },
    system,
  );
}

// --- Tool-calling loop (the in-process "MCP") ------------------------------

export interface ToolLoopArgs {
  provider: string;
  model: string;
  apiKey: string;
  system: string;
  userMessage: string;
  tools: ToolSpec[];
  maxIters?: number;
  maxMs?: number;
  onToken?: (chunk: string) => void;
  onToolCall?: (name: string, args: Record<string, unknown>) => void;
  onToolResult?: (name: string, result: unknown) => void;
  signal?: AbortSignal;
}

export interface ToolLoopResult {
  text: string;
  iterations: number;
  toolCalls: number;
  toolsUsed: boolean;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "null";
  } catch {
    return String(value);
  }
}

/** Thrown when a model genuinely rejects the tools parameter on the first call. */
class ToolsUnsupportedError extends Error {
  constructor(readonly original: unknown) {
    super("tools_unsupported");
    this.name = "ToolsUnsupportedError";
  }
}

/**
 * Heuristic: does this error mean the provider/model does not support tool
 * calling at all (as opposed to a transient/network/auth error)? Kept narrow so
 * real failures surface instead of being silently swallowed.
 */
function isToolUnsupportedError(err: unknown): boolean {
  const e = err as {
    status?: number;
    message?: string;
    error?: { message?: string };
  };
  const msg = `${e?.message ?? ""} ${e?.error?.message ?? ""}`.toLowerCase();
  const mentionsTools =
    msg.includes("tool") || msg.includes("function");
  const saysBad =
    msg.includes("not support") ||
    msg.includes("unsupported") ||
    msg.includes("unrecognized") ||
    msg.includes("unknown") ||
    msg.includes("invalid") ||
    msg.includes("no such");
  const status = e?.status;
  const badRequest =
    status === 400 || status === 404 || status === 422 || status === 501;
  return mentionsTools && (saysBad || badRequest);
}

async function openAIToolLoop(
  client: OpenAI,
  args: ToolLoopArgs,
): Promise<ToolLoopResult> {
  const tools = toOpenAITools(args.tools);
  // OpenAI message shapes vary across roles; keep them loose here.
  const messages: any[] = [
    { role: "system", content: args.system },
    { role: "user", content: args.userMessage },
  ];
  let text = "";
  let toolCalls = 0;
  let iterations = 0;
  const maxIters = args.maxIters ?? 8;
  const deadline = Date.now() + (args.maxMs ?? 60_000);

  for (; iterations < maxIters; iterations++) {
    let resp;
    try {
      resp = await client.chat.completions.create(
        { model: args.model, messages, tools, tool_choice: "auto" },
        { signal: args.signal },
      );
    } catch (err) {
      // Only the very first call can reveal a model that lacks tool support;
      // later failures are real errors and must propagate.
      if (iterations === 0 && isToolUnsupportedError(err)) {
        throw new ToolsUnsupportedError(err);
      }
      throw err;
    }
    const msg = resp.choices[0]?.message;
    if (!msg) break;
    if (msg.content) {
      text += msg.content;
      args.onToken?.(msg.content);
    }
    const calls = msg.tool_calls ?? [];
    if (calls.length === 0) break;
    messages.push(msg);
    for (const call of calls) {
      if (call.type !== "function") continue;
      const name = call.function.name;
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(call.function.arguments || "{}");
      } catch {
        parsed = {};
      }
      args.onToolCall?.(name, parsed);
      const result = await dispatchTool(args.tools, name, parsed);
      args.onToolResult?.(name, result);
      toolCalls++;
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: safeJson(result),
      });
    }
    if (Date.now() > deadline) break;
  }
  return { text, iterations, toolCalls, toolsUsed: toolCalls > 0 };
}

async function anthropicToolLoop(
  client: Anthropic,
  args: ToolLoopArgs,
): Promise<ToolLoopResult> {
  const tools = toAnthropicTools(args.tools);
  const messages: any[] = [{ role: "user", content: args.userMessage }];
  let text = "";
  let toolCalls = 0;
  let iterations = 0;
  const maxIters = args.maxIters ?? 8;
  const deadline = Date.now() + (args.maxMs ?? 60_000);

  for (; iterations < maxIters; iterations++) {
    let resp;
    try {
      resp = await client.messages.create(
        {
          model: args.model,
          max_tokens: 1024,
          system: args.system,
          messages,
          tools: tools as any,
        },
        { signal: args.signal },
      );
    } catch (err) {
      if (iterations === 0 && isToolUnsupportedError(err)) {
        throw new ToolsUnsupportedError(err);
      }
      throw err;
    }
    const blocks = (resp.content ?? []) as any[];
    for (const b of blocks) {
      if (b.type === "text" && b.text) {
        text += b.text;
        args.onToken?.(b.text);
      }
    }
    const toolUses = blocks.filter((b) => b.type === "tool_use");
    if (toolUses.length === 0) break;
    messages.push({ role: "assistant", content: blocks });
    const toolResults: any[] = [];
    for (const tu of toolUses) {
      const name = tu.name as string;
      const input = (tu.input ?? {}) as Record<string, unknown>;
      args.onToolCall?.(name, input);
      const result = await dispatchTool(args.tools, name, input);
      args.onToolResult?.(name, result);
      toolCalls++;
      toolResults.push({
        type: "tool_result",
        tool_use_id: tu.id,
        content: safeJson(result),
      });
    }
    messages.push({ role: "user", content: toolResults });
    if (resp.stop_reason !== "tool_use") break;
    if (Date.now() > deadline) break;
  }
  return { text, iterations, toolCalls, toolsUsed: toolCalls > 0 };
}

/**
 * Run a reasoning loop where the model may call sandbox tools. Tool calling is
 * supported for every provider (OpenAI, z.ai via the OpenAI-compatible API, and
 * Claude). It only falls back to a plain text completion when a model genuinely
 * rejects the tools parameter on the first call; any other error (network,
 * rate limit, auth, mid-loop failure) propagates so it is visible.
 */
export async function runToolLoop(args: ToolLoopArgs): Promise<ToolLoopResult> {
  try {
    if (args.provider === "Claude") {
      return await anthropicToolLoop(makeAnthropic(args.apiKey), args);
    }
    if (args.provider === "OpenAI" || args.provider === "z.ai") {
      const baseURL = args.provider === "z.ai" ? ZAI_BASE_URL : undefined;
      return await openAIToolLoop(makeOpenAI(args.apiKey, baseURL), args);
    }
    throw new Error(`Unsupported provider "${args.provider}".`);
  } catch (err) {
    if (!(err instanceof ToolsUnsupportedError)) throw err;
    // The model does not support tools at all — answer as plain text instead.
    const text = await completeText(
      {
        provider: args.provider,
        model: args.model,
        apiKey: args.apiKey,
        question: args.userMessage,
        signal: args.signal,
        onToken: args.onToken ?? (() => {}),
      },
      args.system,
    );
    return { text, iterations: 1, toolCalls: 0, toolsUsed: false };
  }
}
