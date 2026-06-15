/**
 * Sandbox configuration constants.
 *
 * The sandbox lets an agent's LLM author and run JS/TS research code in an
 * isolated, per-agent virtual environment. Because that code is model-authored
 * (and ultimately shaped by user-editable, untrusted strategy text), every
 * value here is a safety control: the package allowlist limits supply-chain
 * exposure, and the time/memory caps bound a single run.
 */

/**
 * Packages an agent is allowed to install into its sandbox. There is no human
 * in the loop to approve installs, so anything outside this list is rejected.
 */
export const PACKAGE_ALLOWLIST: readonly string[] = [
  "ccxt",
  "technicalindicators",
  "danfojs-node",
  "simple-statistics",
  "dayjs",
  "mathjs",
];

/**
 * Packages installed into the shared sandbox base on first use. Kept small so
 * the one-time cold-start install stays fast.
 */
export const DEFAULT_SANDBOX_DEPS: Readonly<Record<string, string>> = {
  ccxt: "^4.4.0",
  technicalindicators: "^3.1.0",
};

/** Default wall-clock limit for a single sandbox run. */
export const DEFAULT_RUN_TIMEOUT_MS = 15_000;

/** Default heap cap (MB) passed to the child via --max-old-space-size. */
export const DEFAULT_RUN_MEMORY_MB = 256;

/** Budget for the background pre-session research loop (kept tight for speed). */
export const DEFAULT_RESEARCH_BUDGET_MS = 30_000;

/**
 * Max run→fix cycles the dedicated self-debug loop will attempt before giving
 * up on a script. Bounds both wall-clock time and model spend.
 */
export const DEFAULT_DEBUG_ATTEMPTS = 4;

/** Maximum concurrent sandbox child processes across all agents. */
export const MAX_CONCURRENT_RUNS = 2;

/** Marker the runner prints before its JSON envelope so the parent can parse it. */
export const ENVELOPE_MARKER = "<<<SANDBOX_RESULT>>>";

/** Strict validators — names/versions are interpolated into install commands. */
export const PACKAGE_NAME_REGEX = /^[a-z0-9@._\-/]+$/;
export const PACKAGE_VERSION_REGEX = /^[0-9a-zA-Z.\-^~*]+$/;

/** Sandbox script names map to files on disk, so keep them filename-safe. */
export const SCRIPT_NAME_REGEX = /^[a-zA-Z0-9._-]+$/;

export function isAllowedPackage(name: string): boolean {
  return PACKAGE_ALLOWLIST.includes(name);
}
