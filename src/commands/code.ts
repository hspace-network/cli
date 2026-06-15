import chalk from "chalk";
import {
  loadCliConfig,
  getCachedNodeConfig,
  getEffectiveSelection,
  getProviderApiKey,
} from "../services/config.service.js";
import { getAgent } from "../services/agent.service.js";
import { resolveStrategyForAgent } from "../services/strategy.service.js";
import {
  readScript,
  deleteScript,
  installPackage,
  runScript,
} from "../services/sandbox.service.js";
import {
  buildSandboxTools,
  type SandboxSignal,
} from "../services/tools.service.js";
import {
  runToolLoop,
  buildSandboxSystemPrompt,
  askVote,
  askDiscussionTurn,
  type DiscussionContext,
} from "../services/llm.service.js";
import { runResearch } from "../services/research.service.js";
import { formatSignalsBlock } from "../services/signals.service.js";
import { log } from "../utils/logger.js";
import type { InteractiveResult, StreamHandle } from "./index.js";

interface LlmSelection {
  provider: string;
  model: string;
  apiKey: string;
}

async function resolveLlm(): Promise<
  { ok: true; sel: LlmSelection } | { ok: false; lines: string[] }
> {
  const cfg = await loadCliConfig();
  const nodeCfg = getCachedNodeConfig();
  const effective = getEffectiveSelection(cfg, nodeCfg?.defaults, nodeCfg?.providers);
  if (!effective.provider || !effective.model) {
    return { ok: false, lines: [log.error('Pick a provider and model in "settings" first.')] };
  }
  const apiKey = getProviderApiKey(cfg, effective.provider);
  if (!apiKey) {
    return {
      ok: false,
      lines: [
        log.error(
          `No API key for "${effective.provider}". Run "settings", pick the provider, and add its key.`,
        ),
      ],
    };
  }
  return { ok: true, sel: { provider: effective.provider, model: effective.model, apiKey } };
}

function parseRoom(tokens: string[]): { market: string; interval: string } | null {
  if (tokens.length === 0) return null;
  const first = tokens[0]!;
  if (first.includes(":")) {
    const [market = "", interval = ""] = first.split(":");
    if (!market || !interval) return null;
    return { market, interval };
  }
  const market = first;
  const interval = tokens[1] ?? "1h";
  return { market, interval };
}

function compact(value: unknown, max = 160): string {
  let s: string;
  try {
    s = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    s = String(value);
  }
  if (!s) return "";
  return s.length > max ? s.slice(0, max) + "…" : s;
}

/** Indent a multi-line block so long errors/stdout stay readable in the pane. */
function indentBlock(text: string, prefix = "    "): string {
  return text
    .split("\n")
    .map((line) => prefix + line)
    .join("\n");
}

function section(label: string): string {
  return `\n${chalk.cyanBright("▌")} ${chalk.bold(label)}\n`;
}

/** Render a tool result: failures show the full error + stderr; successes stay compact. */
function renderToolResult(handle: StreamHandle, r: unknown): void {
  const obj = (r ?? {}) as {
    ok?: boolean;
    error?: string;
    stderr?: string;
    stdout?: string;
  };
  if (obj && obj.ok === false && (obj.error || obj.stderr)) {
    handle.appendToken(`${chalk.red("  ← error")}\n`);
    if (obj.error) handle.appendToken(chalk.red(indentBlock(obj.error)) + "\n");
    if (obj.stderr) handle.appendToken(chalk.dim(indentBlock(obj.stderr)) + "\n");
    return;
  }
  handle.appendToken(`${chalk.dim(`  ← ${compact(r, 400)}`)}\n`);
}

function toolRenderers(handle: StreamHandle, status: (s: string | null) => void) {
  return {
    onToolCall: (name: string, a: Record<string, unknown>) => {
      handle.appendToken(`\n${chalk.cyan(`  → ${name}`)} ${chalk.dim(compact(a))}\n`);
      status(`running ${name}…`); // spinner while the tool executes
    },
    onToolResult: (name: string, r: unknown) => {
      status(null);
      renderToolResult(handle, r);
    },
  };
}


export async function codeCommand(args: string[]): Promise<InteractiveResult> {
  const agentName = args[0];
  if (!agentName) {
    return {
      lines: [
        log.error("Usage: code <agent> <prompt>"),
        log.dim("  code <agent> scripts | read <name> | run <name> [market] | rm <name>"),
        log.dim("  code <agent> install <package>"),
        log.dim("  code <agent> dry-run <market>:<interval>"),
      ],
    };
  }

  let strategy: string | undefined;
  try {
    await getAgent(agentName);
  } catch (err) {
    return { lines: [log.error((err as Error).message)] };
  }
  strategy = (await resolveStrategyForAgent(agentName)) ?? undefined;

  const sub = args[1];
  const rest = args.slice(2);

  // --- Non-LLM subcommands -------------------------------------------------

  if (sub === "scripts") {
    return { lines: [], openScriptsScreen: { agentName } };
  }

  if (sub === "read") {
    const name = rest[0];
    if (!name) return { lines: [log.error("Usage: code <agent> read <name>")] };
    const code = await readScript(agentName, name);
    if (code === null) return { lines: [log.error(`Script "${name}" not found.`)] };
    return { lines: [log.blank(), log.dim(`  ── ${name}.ts ──`), code, log.blank()] };
  }

  if (sub === "rm") {
    const name = rest[0];
    if (!name) return { lines: [log.error("Usage: code <agent> rm <name>")] };
    const ok = await deleteScript(agentName, name);
    return {
      lines: ok
        ? [log.success(`Deleted script "${name}".`)]
        : [log.error(`Script "${name}" not found.`)],
    };
  }

  if (sub === "install") {
    const name = rest[0];
    if (!name) return { lines: [log.error("Usage: code <agent> install <package>")] };
    const res = await installPackage({ agent: agentName, name });
    return {
      lines: res.ok
        ? [log.success(`Installed "${name}" into ${agentName}'s sandbox.`)]
        : [log.error(res.output)],
    };
  }

  if (sub === "run") {
    const name = rest[0];
    if (!name) return { lines: [log.error("Usage: code <agent> run <name> [market] [interval]")] };
    const room = rest[1] ? parseRoom(rest.slice(1)) : null;
    const res = await runScript({
      agent: agentName,
      name,
      market: room?.market,
      interval: room?.interval,
    });
    const lines = [log.blank()];
    if (res.stdout) lines.push(log.dim(res.stdout));
    if (res.ok) {
      lines.push(log.success(`run ok (${res.durationMs}ms)`));
      lines.push(log.raw(`  ${chalk.dim("result")} ${compact(res.result, 600)}`));
    } else {
      lines.push(log.error(res.error ?? "run failed"));
    }
    lines.push(log.blank());
    return { lines };
  }

  // --- LLM subcommands -----------------------------------------------------

  const llm = await resolveLlm();
  if (!llm.ok) return { lines: llm.lines };
  const { provider, model, apiKey } = llm.sel;

  if (sub === "dry-run") {
    const room = parseRoom(rest);
    if (!room) {
      return { lines: [log.error("Usage: code <agent> dry-run <market>:<interval>")] };
    }
    const agentCfg = await getAgent(agentName);
    const capUsd = agentCfg.spendingCapUsd ?? 0;
    const roomId = `${room.market}:${room.interval}`;

    return {
      lines: [log.dim(`  ${agentName} · dry-run ${roomId} (local, no node, no trade)`)],
      stream: {
        prefixLine: "",
        start: async (handle: StreamHandle) => {
          const status = (s: string | null) => handle.setStatus(s);
          try {
            const r = toolRenderers(handle, status);

            handle.appendToken(section("research"));
            status(`analyzing ${room.market} ${room.interval}…`);
            const research = await runResearch({
              agent: agentName,
              provider,
              model,
              apiKey,
              strategy,
              market: room.market,
              interval: room.interval,
              roomId,
              network: "mainnet",
              maxIters: 8,
              maxMs: 60_000,
              onToken: (c) => {
                status(null);
                handle.appendToken(c);
              },
              onToolCall: r.onToolCall,
              onToolResult: r.onToolResult,
            });
            status(null);

            const signalsText: string | undefined = research.signal
              ? formatSignalsBlock(research.signal)
              : undefined;
            handle.appendToken(
              `\n${chalk.cyan("signal:")} ${signalsText ? compact(signalsText, 200) : chalk.dim("none emitted")}\n`,
            );

            const ctx: DiscussionContext = {
              provider,
              model,
              apiKey,
              agentName,
              strategy,
              market: room.market,
              interval: room.interval,
              transcript: [],
              capUsd,
              signals: signalsText,
            };

            handle.appendToken(section("initial vote"));
            status("casting initial vote…");
            const initial = await askVote(ctx, "initial");
            status(null);
            handle.appendToken(
              `  ${voteColor(initial.way)} ${chalk.dim(`$${initial.sizeUsd}`)} — ${initial.rationale}\n`,
            );

            handle.appendToken(section("discussion turn"));
            status("composing argument…");
            const turn = await askDiscussionTurn(ctx, 1);
            status(null);
            handle.appendToken(`  ${chalk.dim(compact(turn, 280))}\n`);

            handle.appendToken(section("final vote"));
            status("casting final vote…");
            const final = await askVote(ctx, "final");
            status(null);
            handle.appendToken(
              `  ${voteColor(final.way)} ${chalk.dim(`$${final.sizeUsd}`)} — ${final.rationale}\n`,
            );

            handle.finalize([
              log.blank(),
              log.success(
                `dry-run complete — initial ${initial.way}, final ${final.way}` +
                  (research.toolsUsed ? "" : " (no tools were called this run)"),
              ),
              log.blank(),
            ]);
          } catch (err) {
            handle.fail(log.error((err as Error).message));
          }
        },
      },
    };
  }

  // Free-form reasoning prompt: code <agent> <prompt...>
  const prompt = args.slice(1).join(" ").trim();
  if (!prompt) {
    return { lines: [log.error("Usage: code <agent> <prompt>")] };
  }

  return {
    lines: [log.dim(`  ${agentName} · sandbox`)],
    stream: {
      prefixLine: "",
      start: async (handle: StreamHandle) => {
        const status = (s: string | null) => handle.setStatus(s);
        try {
          const r = toolRenderers(handle, status);
          let signal: SandboxSignal | null = null;
          const system = await buildSandboxSystemPrompt(strategy);
          const tools = buildSandboxTools({
            agent: agentName,
            network: "mainnet",
            onSignal: (s) => {
              signal = s;
            },
            llm: { provider, model, apiKey, system },
          });
          status("thinking…");
          const loop = await runToolLoop({
            provider,
            model,
            apiKey,
            system,
            userMessage: prompt,
            tools,
            maxIters: 8,
            maxMs: 90_000,
            onToken: (c) => {
              status(null);
              handle.appendToken(c);
            },
            onToolCall: r.onToolCall,
            onToolResult: r.onToolResult,
          });
          status(null);
          const extra = [log.blank()];
          if (signal) {
            extra.push(log.success(`signal: ${formatSignalsBlock(signal)}`));
          }
          extra.push(
            log.dim(
              `  ${loop.toolCalls} tool call${loop.toolCalls === 1 ? "" : "s"}` +
                (loop.toolsUsed ? "" : " — no tools were called this run"),
            ),
            log.blank(),
          );
          handle.finalize(extra);
        } catch (err) {
          handle.fail(log.error((err as Error).message));
        }
      },
    },
  };
}

function voteColor(way: string): string {
  if (way === "LONG") return chalk.green(way);
  if (way === "SHORT") return chalk.red(way);
  return chalk.yellow(way);
}
