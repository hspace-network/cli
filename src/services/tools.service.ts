/**
 * MCP-shaped tool registry for the sandbox reasoning loop.
 *
 * Each tool is a neutral spec (name + JSON-Schema parameters + handler) that
 * `runToolLoop` exposes to the model. Provider-specific adapters convert the
 * neutral specs into OpenAI / Anthropic tool definitions. Handlers close over
 * a single agent's sandbox, so a tool call can only touch that agent's venv.
 */
import {
  runCode,
  runScript,
  saveScript,
  readScript,
  listScripts,
  deleteScript,
  installPackage,
  listPackages,
  resolveSignalScriptName,
  type SandboxResult,
} from "./sandbox.service.js";
import { PACKAGE_ALLOWLIST } from "./sandbox.constants.js";
import { developScript } from "./sandbox.debug.js";
import type { CodeReporters } from "./sandbox.reporters.js";

export type JsonSchema = Record<string, unknown>;

export interface ToolSpec {
  name: string;
  description: string;
  parameters: JsonSchema;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

export type VoteBias = "LONG" | "SHORT" | "NOTR";

export interface SandboxSignal {
  bias: VoteBias;
  confidence: number;
  notes?: string;
  data?: unknown;
}

export interface ToolContext {
  agent: string;
  market?: string;
  interval?: string;
  network?: "mainnet" | "testnet";
  /** Called when the model emits a structured signal via set_signal. */
  onSignal?: (signal: SandboxSignal) => void;
  /**
   * LLM credentials + sandbox system prompt. When present, the `develop_script`
   * self-debug tool is registered (it needs to call the model to repair code).
   */
  llm?: {
    provider: string;
    model: string;
    apiKey: string;
    system: string;
  };
  /** Forwarded to the develop loop so its run/fix cycle surfaces in the logs. */
  reporters?: CodeReporters;
}

/** Compact a raw tool result value for the model. */
function clipResult(value: unknown, max = 1500): string | undefined {
  if (value === undefined) return undefined;
  let s: string;
  try {
    s = JSON.stringify(value);
  } catch {
    s = String(value);
  }
  if (!s) return s;
  return s.length > max ? s.slice(0, max) + "…" : s;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** Keep tool observations compact so the loop stays cheap on tokens. */
function summarizeRun(res: SandboxResult): Record<string, unknown> {
  const out: Record<string, unknown> = {
    ok: res.ok,
    durationMs: res.durationMs,
  };
  // Errors are shown in full (up to a generous cap) so the model can self-correct.
  if (res.error) out.error = res.error.slice(0, 4000);
  if (res.stderr) out.stderr = res.stderr.slice(-1500);
  if (res.stdout) out.stdout = res.stdout.slice(-1500);
  if (res.signal) out.signal = res.signal;
  if (res.ok) {
    let resultStr: string;
    try {
      resultStr = JSON.stringify(res.result);
    } catch {
      resultStr = String(res.result);
    }
    out.result = resultStr ? resultStr.slice(0, 1500) : resultStr;
  }
  return out;
}

function clampConfidence(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function parseBias(v: unknown): VoteBias {
  const up = str(v).trim().toUpperCase();
  return up === "LONG" || up === "SHORT" ? (up as VoteBias) : "NOTR";
}

export function buildSandboxTools(tctx: ToolContext): ToolSpec[] {
  const agent = tctx.agent;
  const runDefaults = {
    market: tctx.market,
    interval: tctx.interval,
    network: tctx.network ?? "mainnet",
  } as const;

  const specs: ToolSpec[] = [
    {
      name: "run_code",
      description:
        "Transpile and execute TypeScript/JavaScript in the isolated sandbox. " +
        "The code must `export default async (ctx) => {...}` and return a JSON-serializable value. " +
        "`ctx` provides: ccxt, ta (technicalindicators), exchange (Bybit public), fetchOHLCV(symbol,timeframe,limit), " +
        "fetchTicker, closes/highs/lows/volumes(ohlcv), market, symbol, params. Network access is allowed; secrets are not. " +
        "To emit a trading signal directly from the script, either return an object shaped like " +
        "{ bias: 'LONG'|'SHORT'|'NOTR', confidence: 0..1, notes } or call ctx.setSignal({...}); do NOT call set_signal as a bare function inside the code.",
      parameters: {
        type: "object",
        properties: {
          code: { type: "string", description: "TS/JS source with a default-exported async function." },
          market: { type: "string", description: "Optional market override, e.g. SOLUSDT." },
          timeframe: { type: "string", description: "Optional default timeframe, e.g. 1h." },
        },
        required: ["code"],
      },
      handler: async (args) => {
        const res = await runCode({
          agent,
          code: str(args.code),
          market: str(args.market) || runDefaults.market,
          interval: str(args.timeframe) || runDefaults.interval,
          network: runDefaults.network,
          params: { timeframe: str(args.timeframe) || runDefaults.interval },
        });
        if (res.signal) tctx.onSignal?.(res.signal);
        return summarizeRun(res);
      },
    },
    {
      name: "run_script",
      description: "Run a previously saved sandbox script by name and return its result.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
          market: { type: "string" },
        },
        required: ["name"],
      },
      handler: async (args) => {
        const res = await runScript({
          agent,
          name: str(args.name),
          market: str(args.market) || runDefaults.market,
          interval: runDefaults.interval,
          network: runDefaults.network,
        });
        if (res.signal) tctx.onSignal?.(res.signal);
        return summarizeRun(res);
      },
    },
    {
      name: "save_script",
      description:
        "Save reusable TS/JS to the sandbox library under a name. " +
        "Use this for code you will run again (e.g. your signal script). Overwrites keep a versioned backup.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Filename-safe name, no extension." },
          code: { type: "string" },
        },
        required: ["name", "code"],
      },
      handler: async (args) => {
        const name = await resolveSignalScriptName(agent, str(args.name));
        const path = await saveScript(agent, name, str(args.code));
        return { ok: true, saved: name, path };
      },
    },
    {
      name: "read_script",
      description: "Read the source of a saved sandbox script.",
      parameters: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      },
      handler: async (args) => {
        const code = await readScript(agent, str(args.name));
        return code === null ? { ok: false, error: "not found" } : { ok: true, code };
      },
    },
    {
      name: "list_scripts",
      description: "List saved sandbox scripts for this agent.",
      parameters: { type: "object", properties: {} },
      handler: async () => ({ scripts: await listScripts(agent) }),
    },
    {
      name: "delete_script",
      description: "Delete a saved sandbox script.",
      parameters: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      },
      handler: async (args) => ({ ok: await deleteScript(agent, str(args.name)) }),
    },
    {
      name: "install_package",
      description:
        "Install an allowlisted npm package into the sandbox. Allowed: " +
        PACKAGE_ALLOWLIST.join(", ") +
        ". ccxt and technicalindicators are preinstalled.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
          version: { type: "string" },
        },
        required: ["name"],
      },
      handler: async (args) => {
        const res = await installPackage({
          agent,
          name: str(args.name),
          version: str(args.version) || undefined,
        });
        return { ok: res.ok, output: res.output.slice(-600) };
      },
    },
    {
      name: "list_packages",
      description: "List packages available in the sandbox.",
      parameters: { type: "object", properties: {} },
      handler: async () => ({ packages: await listPackages(agent) }),
    },
    {
      name: "set_signal",
      description:
        "Emit your final structured trading signal for the current market. " +
        "Call this once you have analyzed the data. bias is LONG/SHORT/NOTR, confidence is 0..1.",
      parameters: {
        type: "object",
        properties: {
          bias: { type: "string", enum: ["LONG", "SHORT", "NOTR"] },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          notes: { type: "string", description: "One or two sentences of rationale." },
          data: { type: "object", description: "Optional supporting numbers (indicator values)." },
        },
        required: ["bias", "confidence"],
      },
      handler: async (args) => {
        const signal: SandboxSignal = {
          bias: parseBias(args.bias),
          confidence: clampConfidence(args.confidence),
          notes: str(args.notes) || undefined,
          data: args.data,
        };
        tctx.onSignal?.(signal);
        return { ok: true, recorded: signal };
      },
    },
  ];

  // Self-debugging authoring tool: only available when LLM creds are supplied,
  // because it calls the model to repair failing code in a bounded loop.
  if (tctx.llm) {
    const llm = tctx.llm;
    specs.push({
      name: "develop_script",
      description:
        "Author or repair a sandbox script with an automatic run-and-fix loop. " +
        "Provide a 'goal' (what the script must compute and return) and optionally starting 'code'. " +
        "It runs the script and, if it errors, fixes it using the actual error/stderr — repeating a few times — " +
        "then saves the working script under 'name'. PREFER this over save_script for any new or changed script, " +
        "so you never rely on code you have not actually run. Returns { ok, attempts, saved, error, result }.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Filename-safe name to save the working script under." },
          goal: { type: "string", description: "What the script must accomplish and return." },
          code: {
            type: "string",
            description: "Optional starting source; omit to have it authored from scratch.",
          },
          market: { type: "string", description: "Optional market override, e.g. SOLUSDT." },
        },
        required: ["name", "goal"],
      },
      handler: async (args) => {
        const requested = str(args.name);
        const name = requested
          ? await resolveSignalScriptName(agent, requested)
          : undefined;
        const res = await developScript({
          agent,
          provider: llm.provider,
          model: llm.model,
          apiKey: llm.apiKey,
          system: llm.system,
          goal: str(args.goal),
          code: str(args.code) || undefined,
          name,
          market: str(args.market) || runDefaults.market,
          interval: runDefaults.interval,
          network: runDefaults.network,
          reporters: tctx.reporters,
        });
        if (res.ok && res.signal) tctx.onSignal?.(res.signal);
        return {
          ok: res.ok,
          attempts: res.attempts,
          saved: res.saved,
          error: res.ok ? undefined : res.error,
          result: res.ok ? clipResult(res.result) : undefined,
        };
      },
    });
  }

  return specs;
}

// --- Provider adapters -----------------------------------------------------

export function toOpenAITools(specs: ToolSpec[]): Array<{
  type: "function";
  function: { name: string; description: string; parameters: JsonSchema };
}> {
  return specs.map((s) => ({
    type: "function",
    function: { name: s.name, description: s.description, parameters: s.parameters },
  }));
}

export function toAnthropicTools(specs: ToolSpec[]): Array<{
  name: string;
  description: string;
  input_schema: JsonSchema;
}> {
  return specs.map((s) => ({
    name: s.name,
    description: s.description,
    input_schema: s.parameters,
  }));
}

export async function dispatchTool(
  specs: ToolSpec[],
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const spec = specs.find((s) => s.name === name);
  if (!spec) return { ok: false, error: `unknown tool "${name}"` };
  try {
    return await spec.handler(args);
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
