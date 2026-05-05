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

function buildSystemPrompt(prompts: PromptsFile, strategy?: string): string {
  if (!strategy) return prompts.system.ask;
  const preamble = prompts.system.strategyPreamble.replace(
    /\{\{strategy\}\}/g,
    strategy,
  );
  return `${prompts.system.ask}\n\n${preamble}`;
}

async function askOpenAI(args: AskArgs, system: string): Promise<void> {
  const client = new OpenAI({ apiKey: args.apiKey });
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

export async function askLLM(args: AskArgs): Promise<void> {
  const prompts = await loadPrompts();
  const system = buildSystemPrompt(prompts, args.strategy);

  const provider = args.provider;

  if (provider === "OpenAI") {
    return askOpenAI(args, system);
  }
  if (provider === "Claude") {
    return askClaude(args, system);
  }
  if (provider === "0G") {
    throw new Error(
      "0G provider is not implemented yet. Pick OpenAI or Claude in settings.",
    );
  }

  throw new Error(`Unsupported provider "${provider}".`);
}
