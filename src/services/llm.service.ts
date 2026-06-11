import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import type { ChatMessage } from "./conversation.service.js";

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
  };
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

const ZAI_BASE_URL = "https://api.z.ai/api/paas/v4/";

async function askOpenAICompatible(
  args: AskArgs,
  system: string,
  baseURL?: string,
): Promise<void> {
  const client = new OpenAI({ apiKey: args.apiKey, baseURL });
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
  const client = new Anthropic({ apiKey: args.apiKey });
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

function parseVote(raw: string, capUsd: number): VoteResult {
  const fallback: VoteResult = {
    way: "NOTR",
    rationale: raw.slice(0, 280),
    sizeUsd: 0,
  };
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return fallback;
  try {
    const parsed = JSON.parse(match[0]) as {
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

export async function askVote(
  ctx: DiscussionContext,
  phase: "initial" | "final",
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
  const question = `${intro}\n\n${capLine}\n\nDiscussion so far:\n${formatTranscript(
    ctx.transcript,
  )}\n\nRespond with the required JSON object only.`;

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

  const question = `Market: ${ctx.market} | Timeframe: ${ctx.interval} | Round: ${round}\n\nDiscussion so far:\n${formatTranscript(
    ctx.transcript,
  )}\n\nIt is your turn to speak. Contribute your message now.`;

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
