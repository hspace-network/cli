import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdir, readFile, copyFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { transform } from "esbuild";
import {
  getAgentsRoot,
  ensureDir,
  fileExists,
  dirExists,
  writeText,
  writeJson,
  readJson,
  removeFile,
} from "../utils/fs.js";
import {
  DEFAULT_SANDBOX_DEPS,
  DEFAULT_RUN_TIMEOUT_MS,
  DEFAULT_RUN_MEMORY_MB,
  MAX_CONCURRENT_RUNS,
  ENVELOPE_MARKER,
  PACKAGE_NAME_REGEX,
  PACKAGE_VERSION_REGEX,
  SCRIPT_NAME_REGEX,
  isAllowedPackage,
} from "./sandbox.constants.js";
import { RUNNER_SOURCE } from "./sandbox.runner.js";

export interface SandboxResult {
  ok: boolean;
  result?: unknown;
  /** Signal emitted by the script via ctx.setSignal / set_signal / return value. */
  signal?: {
    bias: "LONG" | "SHORT" | "NOTR";
    confidence: number;
    notes?: string;
    data?: unknown;
  } | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  error?: string;
}

export interface RunOptions {
  agent: string;
  /** Raw TS/JS source. The default export (or `run`) is invoked with `ctx`. */
  code: string;
  params?: Record<string, unknown>;
  market?: string;
  symbol?: string;
  interval?: string;
  network?: "mainnet" | "testnet";
  timeoutMs?: number;
  memoryMb?: number;
}

export interface ScriptMeta {
  name: string;
  updatedAt: string;
}

interface SandboxMeta {
  scripts: Record<string, { updatedAt: string }>;
}

// --- Paths -----------------------------------------------------------------

export function getSandboxRoot(): string {
  return join(getAgentsRoot(), ".sandbox");
}

function getRunnerPath(): string {
  return join(getSandboxRoot(), ".runner.mjs");
}

export function getSandboxAgentDir(agent: string): string {
  return join(getSandboxRoot(), "agents", agent);
}

function getScriptsDir(agent: string): string {
  return join(getSandboxAgentDir(agent), "scripts");
}

function getScriptVersionsDir(agent: string): string {
  return join(getScriptsDir(agent), ".versions");
}

function getRunsDir(agent: string): string {
  return join(getSandboxAgentDir(agent), "runs");
}

export function getSignalsDir(agent: string): string {
  return join(getSandboxAgentDir(agent), "data", "signals");
}

function getScriptPath(agent: string, name: string): string {
  return join(getScriptsDir(agent), `${name}.ts`);
}

/** Absolute path to a saved script's source file (for the editor/screen). */
export function scriptFilePath(agent: string, name: string): string {
  assertScriptName(name);
  return getScriptPath(agent, name);
}

function getMetaPath(agent: string): string {
  return join(getSandboxAgentDir(agent), "meta.json");
}

function assertScriptName(name: string): void {
  if (!SCRIPT_NAME_REGEX.test(name) || name.startsWith(".")) {
    throw new Error(
      `Invalid script name "${name}". Use letters, numbers, dot, dash or underscore.`,
    );
  }
}

// --- Scaffolding -----------------------------------------------------------

const TYPE_DECLARATION = `// Auto-generated. Type hints for sandbox scripts.
export interface SandboxCtx {
  params: Record<string, unknown>;
  market: string;
  symbol: string;
  interval: string;
  network: "mainnet" | "testnet";
  ccxt: any;
  ta: any;
  exchange: any;
  symbolFor(market: string): string;
  log(...args: unknown[]): void;
  fetchOHLCV(symbol?: string, timeframe?: string, limit?: number): Promise<number[][]>;
  /** fetchOHLCV with the live, still-forming last candle dropped (closed candles only). */
  fetchClosedOHLCV(symbol?: string, timeframe?: string, limit?: number): Promise<number[][]>;
  fetchTicker(symbol?: string): Promise<any>;
  /** All but the live in-progress candle. Use this for stable volume/indicator gates. */
  closedOHLCV(ohlcv: number[][]): number[][];
  /** The last CLOSED candle (second-to-last row); the last row is still forming. */
  lastClosed(ohlcv: number[][]): number[] | null;
  closes(ohlcv: number[][]): number[];
  highs(ohlcv: number[][]): number[];
  lows(ohlcv: number[][]): number[];
  volumes(ohlcv: number[][]): number[];
  /** Emit a trading signal from inside the script (alternative to the set_signal tool). */
  setSignal(signal: { bias: "LONG" | "SHORT" | "NOTR"; confidence: number; notes?: string; data?: unknown }): void;
}
export type SandboxScript = (ctx: SandboxCtx) => unknown | Promise<unknown>;
`;

let scaffolded = new Set<string>();

export async function ensureSandbox(agent: string): Promise<void> {
  const root = getSandboxRoot();
  await ensureDir(root);
  await ensureDir(getSandboxAgentDir(agent));
  await ensureDir(getScriptsDir(agent));
  await ensureDir(getScriptVersionsDir(agent));
  await ensureDir(getSignalsDir(agent));
  await ensureDir(getRunsDir(agent));

  const rootPkg = join(root, "package.json");
  if (!(await fileExists(rootPkg))) {
    await writeJson(rootPkg, {
      name: "hspace-sandbox-base",
      private: true,
      type: "module",
      dependencies: { ...DEFAULT_SANDBOX_DEPS },
    });
  }

  // Keep the runner in sync with the shipped source (cheap to rewrite).
  await writeText(getRunnerPath(), RUNNER_SOURCE);

  const agentPkg = join(getSandboxAgentDir(agent), "package.json");
  if (!(await fileExists(agentPkg))) {
    await writeJson(agentPkg, {
      name: `hspace-sandbox-${agent}`,
      private: true,
      type: "module",
      dependencies: {},
    });
  }

  await writeText(join(getSandboxAgentDir(agent), "sandbox.d.ts"), TYPE_DECLARATION);

  if (!(await fileExists(getMetaPath(agent)))) {
    await writeJson(getMetaPath(agent), { scripts: {} } satisfies SandboxMeta);
  }
  scaffolded.add(agent);
}

let baseDepsReady = false;
let baseDepsPromise: Promise<void> | null = null;

/** Install the shared default dependencies (ccxt, technicalindicators) once. */
export async function ensureBaseDeps(): Promise<void> {
  if (baseDepsReady) return;
  if (baseDepsPromise) return baseDepsPromise;
  baseDepsPromise = (async () => {
    const root = getSandboxRoot();
    const have = await dirExists(join(root, "node_modules", "ccxt"));
    if (!have) {
      await npmInstall(root, []);
    }
    baseDepsReady = true;
  })();
  try {
    await baseDepsPromise;
  } finally {
    baseDepsPromise = null;
  }
}

// --- Script library --------------------------------------------------------

async function readMeta(agent: string): Promise<SandboxMeta> {
  try {
    const meta = await readJson<SandboxMeta>(getMetaPath(agent));
    return { scripts: meta.scripts ?? {} };
  } catch {
    return { scripts: {} };
  }
}

export async function saveScript(
  agent: string,
  name: string,
  code: string,
): Promise<string> {
  assertScriptName(name);
  // Validate before persisting: never save code that cannot even compile, so a
  // broken script can't be silently reused later via run_script. The thrown
  // error surfaces back to the model (dispatchTool wraps it) so it can fix it.
  try {
    await transpile(code);
  } catch (err) {
    throw new Error(`compile error: ${(err as Error).message}`);
  }
  await ensureSandbox(agent);
  const path = getScriptPath(agent, name);

  // Keep the previous version as last-good history before overwriting.
  if (await fileExists(path)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const versionPath = join(getScriptVersionsDir(agent), `${name}.${stamp}.ts`);
    try {
      await copyFile(path, versionPath);
    } catch {
      // versioning is best-effort
    }
  }

  await writeText(path, code.endsWith("\n") ? code : code + "\n");

  const meta = await readMeta(agent);
  meta.scripts[name] = { updatedAt: new Date().toISOString() };
  await writeJson(getMetaPath(agent), meta);
  return path;
}

export async function readScript(agent: string, name: string): Promise<string | null> {
  assertScriptName(name);
  const path = getScriptPath(agent, name);
  if (!(await fileExists(path))) return null;
  return readFile(path, "utf-8");
}

export async function listScripts(agent: string): Promise<ScriptMeta[]> {
  const dir = getScriptsDir(agent);
  if (!(await dirExists(dir))) return [];
  const meta = await readMeta(agent);
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return [];
  }
  const out: ScriptMeta[] = [];
  for (const f of files) {
    if (!f.endsWith(".ts")) continue;
    const name = f.slice(0, -3);
    out.push({ name, updatedAt: meta.scripts[name]?.updatedAt ?? "" });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Funnel signal scripts into a single canonical file. Agents tend to author a
 * new "signal_*" variant on every run; if one already exists, reuse that name
 * (so the next save overwrites it) instead of accumulating near-duplicates.
 * Non-signal names pass through unchanged.
 */
export async function resolveSignalScriptName(
  agent: string,
  requested: string,
): Promise<string> {
  if (!/^signal/i.test(requested)) return requested;
  const existing = await listScripts(agent);
  if (existing.some((s) => s.name === requested)) return requested;
  const exact = existing.find((s) => s.name.toLowerCase() === "signal");
  if (exact) return exact.name;
  const fam = existing.find((s) => /^signal/i.test(s.name));
  return fam ? fam.name : requested;
}

export async function deleteScript(agent: string, name: string): Promise<boolean> {
  assertScriptName(name);
  const path = getScriptPath(agent, name);
  if (!(await fileExists(path))) return false;
  await removeFile(path);
  const meta = await readMeta(agent);
  delete meta.scripts[name];
  await writeJson(getMetaPath(agent), meta);
  return true;
}

// --- Packages --------------------------------------------------------------

export async function installPackage(args: {
  agent: string;
  name: string;
  version?: string;
}): Promise<{ ok: boolean; output: string }> {
  const { agent, name } = args;
  const version = args.version ?? "latest";
  if (!PACKAGE_NAME_REGEX.test(name) || !isAllowedPackage(name)) {
    return {
      ok: false,
      output: `Package "${name}" is not on the sandbox allowlist.`,
    };
  }
  if (version !== "latest" && !PACKAGE_VERSION_REGEX.test(version)) {
    return { ok: false, output: `Invalid version "${version}".` };
  }
  await ensureSandbox(agent);
  try {
    const spec = version === "latest" ? name : `${name}@${version}`;
    const output = await npmInstall(getSandboxAgentDir(agent), [spec]);
    return { ok: true, output };
  } catch (err) {
    return { ok: false, output: (err as Error).message };
  }
}

export async function listPackages(agent: string): Promise<string[]> {
  const out = new Set<string>();
  for (const dep of Object.keys(DEFAULT_SANDBOX_DEPS)) out.add(dep);
  try {
    const pkg = await readJson<{ dependencies?: Record<string, string> }>(
      join(getSandboxAgentDir(agent), "package.json"),
    );
    for (const dep of Object.keys(pkg.dependencies ?? {})) out.add(dep);
  } catch {
    // ignore
  }
  return [...out].sort();
}

function npmInstall(cwd: string, specs: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    // Specs are allowlist + regex validated upstream, so they are safe to pass
    // through a shell. The shell is required on Windows, where Node refuses to
    // spawn npm.cmd directly (EINVAL) since the CVE-2024-27980 hardening.
    const isWin = process.platform === "win32";
    // --ignore-scripts: package lifecycle (pre/post-install) scripts run OUTSIDE
    // the per-run permission sandbox, so a compromised dep could execute with
    // full user privileges. Block them; sandbox deps are pure JS libs anyway.
    const args = [
      "install",
      "--no-audit",
      "--no-fund",
      "--ignore-scripts",
      "--loglevel=error",
      ...specs,
    ];
    const child = spawn("npm", args, {
      cwd,
      env: minimalEnv(),
      windowsHide: true,
      shell: isWin,
    });
    let out = "";
    let err = "";
    child.stdout?.on("data", (d) => (out += d.toString()));
    child.stderr?.on("data", (d) => (err += d.toString()));
    child.on("error", (e) =>
      reject(new Error(`npm not available: ${e.message}`)),
    );
    child.on("close", (code) => {
      if (code === 0) resolve(out || "installed");
      else reject(new Error(err || out || `npm exited with code ${code}`));
    });
  });
}

// --- Execution -------------------------------------------------------------

let activeRuns = 0;
const waiters: Array<() => void> = [];

async function acquireSlot(): Promise<void> {
  if (activeRuns < MAX_CONCURRENT_RUNS) {
    activeRuns++;
    return;
  }
  await new Promise<void>((res) => waiters.push(res));
}

function releaseSlot(): void {
  const next = waiters.shift();
  if (next) next();
  else activeRuns--;
}

function minimalEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  const safe = [
    "PATH",
    "Path",
    "SystemRoot",
    "windir",
    "TEMP",
    "TMP",
    "COMSPEC",
    "PATHEXT",
    "LANG",
    "LC_ALL",
    "TZ",
  ];
  for (const k of safe) {
    if (process.env[k]) env[k] = process.env[k];
  }
  return env;
}

/**
 * Build the Node permission-model flags that confine a sandbox child to its own
 * agent dir. Returns null when this Node version has no permission model, so the
 * caller can refuse to run (fail closed) rather than execute model-authored code
 * with full filesystem access to the user's machine (incl. wallet keys).
 */
function permissionFlags(sandboxRoot: string, agentDir: string): string[] | null {
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  let flag: string | null = null;
  if (major > 23 || (major === 23 && minor >= 5) || major >= 24) {
    flag = "--permission";
  } else if (major >= 20) {
    flag = "--experimental-permission";
  }
  if (!flag) return null;
  return [
    flag,
    `--allow-fs-read=${sandboxRoot}`,
    `--allow-fs-read=${join(sandboxRoot, "*")}`,
    `--allow-fs-write=${agentDir}`,
    `--allow-fs-write=${join(agentDir, "*")}`,
  ];
}

/** Escape hatch for advanced users on a Node without the permission model. */
function allowUnsandboxed(): boolean {
  const v = process.env.HSPACE_SANDBOX_ALLOW_UNSAFE;
  return v === "1" || v?.toLowerCase() === "true";
}

async function transpile(code: string): Promise<string> {
  const result = await transform(code, {
    loader: "ts",
    format: "esm",
    target: "node18",
    sourcemap: false,
  });
  return result.code;
}

function parseEnvelope(stdout: string): SandboxResult | null {
  const idx = stdout.lastIndexOf(ENVELOPE_MARKER);
  if (idx === -1) return null;
  const after = stdout.slice(idx + ENVELOPE_MARKER.length);
  const newline = after.indexOf("\n");
  const json = newline === -1 ? after : after.slice(0, newline);
  try {
    return JSON.parse(json) as SandboxResult;
  } catch {
    return null;
  }
}

export async function runCode(options: RunOptions): Promise<SandboxResult> {
  const {
    agent,
    code,
    params = {},
    market = "",
    symbol = "",
    interval = "",
    network = "mainnet",
    timeoutMs = DEFAULT_RUN_TIMEOUT_MS,
    memoryMb = DEFAULT_RUN_MEMORY_MB,
  } = options;

  await ensureSandbox(agent);

  const sandboxRoot = getSandboxRoot();
  const agentDir = getSandboxAgentDir(agent);

  // Fail closed: if this Node version can't enforce the permission model, do not
  // run model-authored code with unrestricted filesystem access.
  const permFlags = permissionFlags(sandboxRoot, agentDir);
  if (permFlags === null && !allowUnsandboxed()) {
    return {
      ok: false,
      stdout: "",
      stderr: "",
      durationMs: 0,
      error:
        "Sandbox isolation unavailable: this Node version lacks the permission model (needs Node >= 20). " +
        "Refusing to run sandbox code without filesystem isolation. Upgrade Node, or set " +
        "HSPACE_SANDBOX_ALLOW_UNSAFE=1 to override (NOT recommended).",
    };
  }

  await ensureBaseDeps();

  let transpiled: string;
  try {
    transpiled = await transpile(code);
  } catch (err) {
    return {
      ok: false,
      stdout: "",
      stderr: "",
      durationMs: 0,
      error: `compile error: ${(err as Error).message}`,
    };
  }

  const runId = randomUUID();
  const runFile = join(getRunsDir(agent), `${runId}.mjs`);
  await writeText(runFile, transpiled);

  const runnerPath = getRunnerPath();
  const ctxOpts = JSON.stringify({ params, market, symbol, interval, network });

  await acquireSlot();
  try {
    return await new Promise<SandboxResult>((resolve) => {
      const args = [
        ...(permFlags ?? []),
        `--max-old-space-size=${memoryMb}`,
        runnerPath,
        runFile,
        ctxOpts,
      ];
      const child = spawn(process.execPath, args, {
        cwd: agentDir,
        env: minimalEnv(),
        windowsHide: true,
      });

      let stdout = "";
      let stderr = "";
      let settled = false;
      const start = Date.now();

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore
        }
        resolve({
          ok: false,
          stdout,
          stderr,
          durationMs: Date.now() - start,
          error: `timed out after ${timeoutMs}ms`,
        });
      }, timeoutMs);

      child.stdout?.on("data", (d) => (stdout += d.toString()));
      child.stderr?.on("data", (d) => (stderr += d.toString()));

      child.on("error", (e) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          ok: false,
          stdout,
          stderr,
          durationMs: Date.now() - start,
          error: `spawn failed: ${e.message}`,
        });
      });

      child.on("close", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const env = parseEnvelope(stdout);
        if (env) {
          resolve(env);
        } else {
          resolve({
            ok: false,
            stdout,
            stderr,
            durationMs: Date.now() - start,
            error: stderr.trim() || "no result envelope returned",
          });
        }
      });
    });
  } finally {
    releaseSlot();
    void removeFile(runFile).catch(() => {});
  }
}

export async function runScript(args: {
  agent: string;
  name: string;
  params?: Record<string, unknown>;
  market?: string;
  symbol?: string;
  interval?: string;
  network?: "mainnet" | "testnet";
  timeoutMs?: number;
  memoryMb?: number;
}): Promise<SandboxResult> {
  const code = await readScript(args.agent, args.name);
  if (code === null) {
    return {
      ok: false,
      stdout: "",
      stderr: "",
      durationMs: 0,
      error: `script "${args.name}" not found`,
    };
  }
  return runCode({ ...args, code });
}

/** Used by tooling/tests to verify the runner URL resolution is sane. */
export function runnerFileUrl(): string {
  return pathToFileURL(getRunnerPath()).href;
}
