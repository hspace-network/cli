/**
 * Background sandbox research scheduler.
 *
 * When an agent joins a room (`run`), we periodically run its sandbox research
 * loop ahead of the node's discussion tick so a fresh signal is cached before
 * voting. This keeps heavy authoring/analysis OUT of the latency-sensitive vote
 * path. Timers are per (agent, room) and stop when the agent leaves the room.
 * Research is suppressed while a room has a live discussion so it never competes
 * with the vote/turn LLM calls, and its tool activity is surfaced into the logs.
 */
import { runResearch, resolveResearchContext } from "./research.service.js";
import { intervalToMs } from "./signals.service.js";
import { subscribeDiscussion } from "./discussion.bus.js";
import { makeCodeReporters } from "./sandbox.reporters.js";

const timers = new Map<string, ReturnType<typeof setInterval>>();
const inFlight = new Set<string>();
const liveRooms = new Set<string>();
let busSubscribed = false;

function key(agentName: string, roomId: string): string {
  return `${agentName}|${roomId}`;
}

/** Track which rooms currently have an open discussion so we can pause research. */
function ensureBusSubscription(): void {
  if (busSubscribed) return;
  busSubscribed = true;
  subscribeDiscussion((event) => {
    if (event.type === "open") liveRooms.add(event.roomId);
    else if (event.type === "close") liveRooms.delete(event.roomId);
  });
}

/** Refresh cadence: track the room interval, but clamp to a sane 5min..60min. */
function cadenceMs(roomId: string): number {
  return Math.min(Math.max(intervalToMs(roomId), 5 * 60_000), 60 * 60_000);
}

async function refreshOnce(agentName: string, roomId: string): Promise<void> {
  const k = key(agentName, roomId);
  if (inFlight.has(k)) return; // never overlap research for the same room
  if (liveRooms.has(roomId)) return; // don't compete with an active discussion
  inFlight.add(k);
  try {
    const ctx = await resolveResearchContext(agentName, roomId);
    if (!ctx) return;
    const reporters = makeCodeReporters(agentName, roomId);
    await runResearch({
      agent: ctx.agent,
      provider: ctx.provider,
      model: ctx.model,
      apiKey: ctx.apiKey,
      strategy: ctx.strategy,
      market: ctx.market,
      interval: ctx.interval,
      roomId: ctx.roomId,
      network: "mainnet",
      // Give the loop room to author + self-debug a script (develop_script runs
      // its own bounded fix cycle), so research isn't cut off mid-repair.
      maxIters: 8,
      maxMs: Math.max(ctx.researchBudgetMs, 60_000),
      persist: true,
      onToolCall: reporters.onToolCall,
      onToolResult: reporters.onToolResult,
    });
  } catch {
    // best-effort; research must never break the run/discussion flow
  } finally {
    inFlight.delete(k);
  }
}

export function startSandboxResearch(agentName: string, roomId: string): void {
  ensureBusSubscription();
  const k = key(agentName, roomId);
  if (timers.has(k)) return;
  const timer = setInterval(() => {
    void refreshOnce(agentName, roomId);
  }, cadenceMs(roomId));
  if (typeof timer.unref === "function") timer.unref();
  timers.set(k, timer);
  // Warm the signal shortly after joining, without blocking the run ack.
  setTimeout(() => void refreshOnce(agentName, roomId), 3_000);
}

export function stopSandboxResearch(agentName: string, roomId: string): void {
  const k = key(agentName, roomId);
  const timer = timers.get(k);
  if (timer) clearInterval(timer);
  timers.delete(k);
}

export function stopAllSandboxResearch(agentName?: string): void {
  for (const [k, timer] of timers) {
    if (agentName && !k.startsWith(`${agentName}|`)) continue;
    clearInterval(timer);
    timers.delete(k);
  }
}
