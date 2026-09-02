import { spawn } from "node:child_process";
import fs from "node:fs";
import { join } from "node:path";
import chalk from "chalk";
import { getAgent } from "../services/agent.service.js";
import { walletExists } from "../services/wallet.service.js";
import { loadCliConfig, getCachedNodeConfig } from "../services/config.service.js";
import { getAgentsRoot, ensureDir } from "../utils/fs.js";
import { log } from "../utils/logger.js";

interface Job {
  pid: number;
  agent: string;
  room: string;
  nodeUrl: string;
  startedAt: string;
}

function autoDir(): string {
  return join(getAgentsRoot(), "auto");
}
function sanitize(room: string): string {
  return room.replace(/[^a-zA-Z0-9._-]/g, "-");
}
function jobPath(agent: string, room: string): string {
  return join(autoDir(), `${agent}__${sanitize(room)}.json`);
}
function logPath(agent: string, room: string): string {
  return join(autoDir(), `${agent}__${sanitize(room)}.log`);
}

/** Signal-0 probe: true if the pid is a live process this user can signal. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readJobs(): { file: string; job: Job }[] {
  const dir = autoDir();
  if (!fs.existsSync(dir)) return [];
  const out: { file: string; job: Job }[] = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    const file = join(dir, f);
    try {
      const job = JSON.parse(fs.readFileSync(file, "utf-8")) as Job;
      if (job && typeof job.pid === "number") out.push({ file, job });
    } catch {
      /* skip malformed */
    }
  }
  return out;
}

function resolveRoom(args: string[]): string | { error: string } {
  const cached = getCachedNodeConfig();
  if (!cached) return { error: 'Not connected to a node. Run "node set <url>" first.' };
  let room: string | undefined;
  if (args[1]?.includes(":")) room = args[1];
  else if (args[1] && args[2]) room = `${args[1]}:${args[2]}`;
  if (!room) return { error: "Usage: auto <agent> <market>:<interval>" };
  if (!cached.rooms.some((r) => r.id === room)) {
    return { error: `Unknown room "${room}". Run "rooms" to list available rooms.` };
  }
  return room;
}

async function startJob(args: string[]): Promise<string[]> {
  const agent = args[0]!;
  try {
    await getAgent(agent);
  } catch (err) {
    return [log.error((err as Error).message)];
  }
  if (!(await walletExists(agent))) {
    return [log.error(`Cannot run "${agent}" — no wallet on disk.`)];
  }

  const room = resolveRoom(args);
  if (typeof room !== "string") return [log.error(room.error)];

  const existing = readJobs().find(
    (j) => j.job.agent === agent && j.job.room === room,
  );
  if (existing && isAlive(existing.job.pid)) {
    return [
      log.error(`${agent} is already running ${room} in the background (pid ${existing.job.pid}).`),
      log.dim(`  "auto stop ${agent}" to stop it.`),
    ];
  }

  const cfg = await loadCliConfig();
  await ensureDir(autoDir());

  // Re-launch THIS entry (dist/index.js in prod, src/index.tsx under tsx) with
  // the hidden runner flag. Passing process.execArgv carries the tsx loader in
  // dev; in prod it's empty and node runs the compiled entry directly.
  const out = fs.openSync(logPath(agent, room), "a");
  const mainScript = process.argv[1]!;
  const child = spawn(
    process.execPath,
    [...process.execArgv, mainScript, "__agent-runner", agent, room],
    { detached: true, stdio: ["ignore", out, out], windowsHide: true },
  );
  child.unref();
  fs.closeSync(out);

  if (!child.pid) {
    return [log.error("Failed to start the background process.")];
  }

  const job: Job = {
    pid: child.pid,
    agent,
    room,
    nodeUrl: cfg.nodeUrl,
    startedAt: new Date().toISOString(),
  };
  fs.writeFileSync(jobPath(agent, room), JSON.stringify(job, null, 2));

  return [
    log.blank(),
    log.success(
      `${chalk.cyanBright(agent)} running ${chalk.green(room)} in the background (pid ${child.pid}).`,
    ),
    log.dim(`  Keeps running after you close the CLI.`),
    log.dim(`  "auto" to list · "auto stop ${agent}" to stop · logs: ${logPath(agent, room)}`),
    log.blank(),
  ];
}

function listJobs(): string[] {
  const jobs = readJobs();
  const live = jobs.filter(({ file, job }) => {
    if (isAlive(job.pid)) return true;
    try {
      fs.rmSync(file);
    } catch {
      /* ignore */
    }
    return false;
  });
  if (live.length === 0) {
    return [log.dim("  No background agents running.")];
  }
  const lines = [log.blank(), log.heading("  Background agents")];
  for (const { job } of live) {
    lines.push(
      log.raw(
        `  ${chalk.cyanBright(job.agent)} ${chalk.green(job.room)}  ${chalk.dim(
          `pid ${job.pid} · since ${job.startedAt.slice(11, 19)} UTC`,
        )}`,
      ),
    );
  }
  lines.push(log.blank());
  return lines;
}

function stopJobs(agent?: string, room?: string): string[] {
  if (!agent) {
    return [log.error("Usage: auto stop <agent> [market:interval]")];
  }
  const matches = readJobs().filter(
    ({ job }) => job.agent === agent && (!room || job.room === room),
  );
  if (matches.length === 0) {
    return [log.dim(`  No background job for "${agent}"${room ? ` in ${room}` : ""}.`)];
  }
  const stopped: string[] = [];
  for (const { file, job } of matches) {
    try {
      process.kill(job.pid, "SIGTERM");
    } catch {
      /* already gone */
    }
    try {
      fs.rmSync(file);
    } catch {
      /* ignore */
    }
    stopped.push(`${job.agent} ${job.room}`);
  }
  return [log.success(`Stopped: ${stopped.join(", ")}`)];
}

export async function autoCommand(args: string[]): Promise<string[]> {
  const sub = args[0];
  if (!sub || sub === "list") return listJobs();
  if (sub === "stop") return stopJobs(args[1], args[2]);
  return startJob(args);
}
