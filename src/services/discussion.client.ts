import type { Socket } from "socket.io-client";
import { resolveStrategyForAgent } from "./strategy.service.js";
import {
  loadCliConfig,
  getCachedNodeConfig,
  getEffectiveSelection,
  getProviderApiKey,
  getPlatformCreds,
  getEffectiveNetwork,
  getEffectiveChain,
  validateChainNetworkPair,
  type BybitNetwork,
} from "./config.service.js";
import { getAgent, type AgentConfig } from "./agent.service.js";
import { clampVote } from "./vote-clamp.js";
import { getTradeCountToday, incrementTradeCount } from "./trade-stats.service.js";
import {
  askVote,
  askDiscussionTurn,
  buildSandboxSystemPrompt,
  type DiscussionContext,
  type DiscussionTurn,
  type VoteResult,
  type VoteToolOptions,
} from "./llm.service.js";
import { buildSandboxTools } from "./tools.service.js";
import { makeCodeReporters } from "./sandbox.reporters.js";
import { writeSignals } from "./signals.service.js";
import { resolveSymbol, type BybitCreds } from "./bybit.service.js";
import {
  positionNotionalUsd,
  type PositionSnapshot,
  type PositionSide,
} from "./positions.service.js";
import { getVenue, type TradingVenue, type StopResult } from "./venue.js";
import { emitDiscussionEvent } from "./discussion.bus.js";
import { readActionableSignalsBlock } from "./signals.service.js";
import { readAgentMemory } from "./memory.service.js";
import { resolveResearchContext, runReflection } from "./research.service.js";
import {
  ensureDir,
  appendText,
  getAgentDir,
  getAgentHistoryPath,
} from "../utils/fs.js";

const attached = new WeakSet<Socket>();
const seenEvents = new Set<string>();

// If the CLI produced a final vote later than the node's vote window (minus this
// margin for the ack's return trip), the node has already recorded the agent as
// an abstainer, so we must NOT execute the trade — otherwise a real, unmanaged
// leveraged position opens that the platform's record, score, and anchored proof
// all deny. Skipping is the safe direction: at worst we miss one resize.
const VOTE_ACK_SAFETY_MS = 3_000;
const DEFAULT_VOTE_TIMEOUT_MS = 30_000;

// All local agents share ONE Bybit credential, so the account's net position on
// a symbol is shared. Without coordination, two agents on the same symbol (e.g.
// BTCUSDT:1m and BTCUSDT:1h) reconcile the same position and flip each other's
// real trades every session, and concurrent reconciles net against each other.
// Guard: serialize reconciliation per symbol, and let the first agent to hold a
// live position "own" that symbol — others hold instead of disturbing it.
// (The real fix is per-agent API keys; this makes the shared account safe today.)
const symbolLocks = new Map<string, Promise<void>>();
const symbolOwner = new Map<string, string>();

/**
 * Run fn as an exclusive critical section per symbol (promise-chain mutex).
 * Exported for tests — see test/symbol-lock.test.ts.
 */
export async function withSymbolLock<T>(symbol: string, fn: () => Promise<T>): Promise<T> {
  const prev = symbolLocks.get(symbol) ?? Promise.resolve();
  let done!: () => void;
  const mine = new Promise<void>((resolve) => {
    done = resolve;
  });
  const chained = prev.then(() => mine);
  symbolLocks.set(symbol, chained);
  await prev.catch(() => {});
  try {
    return await fn();
  } finally {
    done();
    // Drop the entry only if nobody chained after us, to avoid unbounded growth.
    if (symbolLocks.get(symbol) === chained) symbolLocks.delete(symbol);
  }
}

interface SessionRecord {
  sessionId: string;
  agentName: string;
  roomId: string;
  market: string;
  interval: string;
  startedAt: string;
  initial?: VoteResult;
  turns: { round: number; content: string }[];
  final?: VoteResult;
  action?: { type: string; ok: boolean; message: string };
}

const records = new Map<string, SessionRecord>();

function recordKey(agentName: string, sessionId: string): string {
  return `${agentName}:${sessionId}`;
}

function once(key: string): boolean {
  if (seenEvents.has(key)) return false;
  seenEvents.add(key);
  if (seenEvents.size > 500) seenEvents.clear();
  return true;
}

function splitRoom(roomId: string): { market: string; interval: string } {
  const [market = roomId, interval = ""] = roomId.split(":");
  return { market, interval };
}

function asTranscript(value: unknown): DiscussionTurn[] {
  if (!Array.isArray(value)) return [];
  const out: DiscussionTurn[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Partial<DiscussionTurn>;
    if (typeof e.agentName === "string" && typeof e.content === "string") {
      out.push({ agentName: e.agentName, content: e.content });
    }
  }
  return out;
}

interface AgentRunContext {
  agentName: string;
  agentCfg: AgentConfig;
  ctx: DiscussionContext;
  network: BybitNetwork;
  creds: BybitCreds | null;
  venue: TradingVenue | null;
}

/**
 * Ask for a vote, retrying once on a transient LLM failure before giving up.
 * Without this, a single rate-limit/timeout would be swallowed as a NOTR vote,
 * which silently flips a decided agent to "no trade".
 */
async function askVoteResilient(
  ctx: DiscussionContext,
  phase: "initial" | "final",
  opts?: VoteToolOptions,
): Promise<VoteResult> {
  try {
    return await askVote(ctx, phase, opts);
  } catch {
    await new Promise((r) => setTimeout(r, 600));
    return askVote(ctx, phase, opts);
  }
}

async function buildContext(
  agentName: string,
  roomId: string,
  transcript: unknown,
): Promise<AgentRunContext | null> {
  const cfg = await loadCliConfig();
  const nodeCfg = getCachedNodeConfig();
  const effective = getEffectiveSelection(
    cfg,
    nodeCfg?.defaults,
    nodeCfg?.providers,
  );
  if (!effective.provider || !effective.model) return null;
  const apiKey = getProviderApiKey(cfg, effective.provider);
  if (!apiKey) return null;

  const network = getEffectiveNetwork(cfg);
  const chain = getEffectiveChain(cfg);
  if (validateChainNetworkPair(chain, network)) return null;

  const strategy = (await resolveStrategyForAgent(agentName)) ?? undefined;
  const { market, interval } = splitRoom(roomId);

  let agentCfg: AgentConfig;
  try {
    agentCfg = await getAgent(agentName);
  } catch {
    return null;
  }
  const capUsd = agentCfg.spendingCapUsd ?? 0;

  let signals: string | undefined;
  try {
    signals = await readActionableSignalsBlock(agentName, roomId);
  } catch {
    signals = undefined;
  }

  // The agent's own recent decisions in THIS market, so votes are informed by
  // its track record instead of forgetting what it did last time.
  let memory: string | undefined;
  try {
    memory = await readAgentMemory(agentName, roomId, { limit: 5 });
  } catch {
    memory = undefined;
  }

  const creds = getPlatformCreds(cfg, "Bybit") ?? null;
  const venue = await getVenue(agentName, agentCfg, { network, creds });

  // Current live position on this symbol, so the agent reasons about what it
  // already holds (add/reduce/flip/hold) rather than deciding in a vacuum.
  let position: string | undefined;
  if (venue) {
    try {
      const pos = await venue.getOpenPosition(resolveSymbol(market));
      position = pos
        ? `${pos.side.toUpperCase()} ${pos.size} @ ${pos.avgPrice}`
        : "flat (no open position)";
    } catch {
      position = undefined;
    }
  }

  return {
    agentName,
    agentCfg,
    ctx: {
      provider: effective.provider,
      model: effective.model,
      apiKey,
      agentName,
      strategy,
      market,
      interval,
      transcript: asTranscript(transcript),
      capUsd,
      signals,
      memory,
      position,
    },
    network,
    creds,
    venue,
  };
}

function getRecord(
  agentName: string,
  sessionId: string,
  roomId: string,
): SessionRecord {
  const key = recordKey(agentName, sessionId);
  let record = records.get(key);
  if (!record) {
    const { market, interval } = splitRoom(roomId);
    record = {
      sessionId,
      agentName,
      roomId,
      market,
      interval,
      startedAt: new Date().toISOString(),
      turns: [],
    };
    records.set(key, record);
  }
  return record;
}

async function writeHistory(record: SessionRecord): Promise<void> {
  try {
    await ensureDir(getAgentDir(record.agentName));
    await appendText(
      getAgentHistoryPath(record.agentName),
      JSON.stringify(record) + "\n",
    );
  } catch {
    // history is best-effort; never break the discussion flow
  }
}

interface ReconcileResult {
  type: string;
  ok: boolean;
  message: string;
  position?: PositionSnapshot | null;
}

/** Suffix warning appended to an action message when a requested stop failed. */
function stopWarning(stops: StopResult): string {
  return stops.requested && !stops.set
    ? ` — WARNING: stop-loss NOT set (${stops.error ?? "unknown"})`
    : "";
}

async function guardTradeLimits(
  run: AgentRunContext,
  targetUsd: number,
  symbol: string,
): Promise<ReconcileResult | null> {
  const { agentCfg, venue } = run;
  if (!venue) return null;

  const maxTrades = agentCfg.maxTradesPerDay ?? 50;
  const todayCount = await getTradeCountToday(run.agentName);
  if (todayCount >= maxTrades) {
    return {
      type: "skipped",
      ok: false,
      message: `daily trade limit reached (${maxTrades}/day)`,
    };
  }

  const cap = agentCfg.spendingCapUsd ?? 0;
  const maxPos = agentCfg.maxPositionUsd ?? cap;
  if (maxPos > 0 && targetUsd > maxPos) {
    return {
      type: "skipped",
      ok: false,
      message: `target $${targetUsd} exceeds max position $${maxPos}`,
    };
  }

  const maxLev = agentCfg.maxLeverage ?? 10;
  const lev = await venue.getSymbolLeverage(symbol);
  if (lev !== null && lev > maxLev) {
    return {
      type: "skipped",
      ok: false,
      message: `leverage ${lev}x exceeds max ${maxLev}x`,
    };
  }

  return null;
}

/**
 * Reconcile open position to the final vote using target-size semantics:
 * sizeUsd is the desired total notional in USD for LONG/SHORT votes.
 */
async function reconcilePosition(
  run: AgentRunContext,
  vote: VoteResult,
): Promise<ReconcileResult> {
  const { ctx, venue, agentCfg } = run;
  if (!venue) {
    return {
      type: "skipped",
      ok: false,
      message: "no trading venue configured — skipped auto-trade",
    };
  }

  const symbol = resolveSymbol(ctx.market);
  const notrBehavior = agentCfg.notrBehavior ?? "hold";
  const stopArgs = (side: PositionSide, entryPrice: number) => ({
    symbol,
    side,
    entryPrice,
    slPct: agentCfg.defaultSlPct,
    tpPct: agentCfg.defaultTpPct,
  });

  try {
    const position = await venue.getOpenPosition(symbol);

    if (vote.way === "NOTR") {
      if (!position) {
        return { type: "none", ok: true, message: "NOTR — stayed flat", position: null };
      }
      if (notrBehavior === "hold") {
        return {
          type: "none",
          ok: true,
          message: "NOTR — held position",
          position: await venue.fetchPositionSnapshot(symbol),
        };
      }
      const closed = await venue.closePosition(symbol);
      await incrementTradeCount(run.agentName);
      return {
        type: "close",
        ok: true,
        message: `NOTR — closed ${symbol} ${closed?.size ?? ""}`.trim(),
        position: null,
      };
    }

    const targetSide: PositionSide = vote.way === "LONG" ? "long" : "short";
    const targetUsd = vote.sizeUsd;

    const guard = await guardTradeLimits(run, targetUsd, symbol);
    if (guard) return guard;

    if (!position) {
      if (targetUsd <= 0) {
        return {
          type: "none",
          ok: true,
          message: `${vote.way} but no stake (sizeUsd 0)`,
          position: null,
        };
      }
      const opened = await venue.openMarketNotional(symbol, targetSide, targetUsd);
      const openStops = await venue.setPositionStops(stopArgs(targetSide, opened.price));
      await incrementTradeCount(run.agentName);
      return {
        type: "open",
        ok: true,
        message: `opened ${vote.way} ${symbol} ${opened.qty} (~$${targetUsd})${stopWarning(openStops)}`,
        position: await venue.fetchPositionSnapshot(symbol),
      };
    }

    if (position.side !== targetSide) {
      await venue.closePosition(symbol);
      if (targetUsd <= 0) {
        await incrementTradeCount(run.agentName);
        return {
          type: "close",
          ok: true,
          message: `closed opposite ${symbol} (no stake to re-open)`,
          position: null,
        };
      }
      const opened = await venue.openMarketNotional(symbol, targetSide, targetUsd);
      const flipStops = await venue.setPositionStops(stopArgs(targetSide, opened.price));
      await incrementTradeCount(run.agentName);
      return {
        type: "flip",
        ok: true,
        message: `flipped to ${vote.way} ${symbol} ${opened.qty} (~$${targetUsd})${stopWarning(flipStops)}`,
        position: await venue.fetchPositionSnapshot(symbol),
      };
    }

    const instrument = await venue.getInstrument(symbol);
    const price = await venue.fetchLastPrice(symbol);
    if (price === null || !Number.isFinite(price) || price <= 0) {
      throw new Error(`Could not fetch a price for ${symbol}.`);
    }

    const currentUsd = positionNotionalUsd(position, price);
    const minLotCost = instrument.minOrderQty * price;
    const tolerance = Math.max(currentUsd * 0.02, minLotCost);

    if (targetUsd <= 0) {
      const closed = await venue.closePosition(symbol);
      await incrementTradeCount(run.agentName);
      return {
        type: "close",
        ok: true,
        message: `closed ${vote.way} ${symbol} ${closed?.size ?? ""}`.trim(),
        position: null,
      };
    }

    const diff = targetUsd - currentUsd;
    if (Math.abs(diff) <= tolerance) {
      return {
        type: "hold",
        ok: true,
        message: `kept ${vote.way} ${symbol} (~$${currentUsd.toFixed(0)})`,
        position: await venue.fetchPositionSnapshot(symbol),
      };
    }

    if (diff > tolerance) {
      const addGuard = await guardTradeLimits(run, targetUsd, symbol);
      if (addGuard) return addGuard;
      const added = await venue.openMarketNotional(symbol, targetSide, diff);
      const addStops = await venue.setPositionStops(stopArgs(targetSide, added.price));
      await incrementTradeCount(run.agentName);
      return {
        type: "add",
        ok: true,
        message: `added to ${vote.way} ${symbol} +${added.qty} (~$${diff.toFixed(0)})${stopWarning(addStops)}`,
        position: await venue.fetchPositionSnapshot(symbol),
      };
    }

    const reduceUsd = currentUsd - targetUsd;
    const reduceQty = reduceUsd / price;
    const reduced = await venue.reducePosition(symbol, reduceQty);
    await incrementTradeCount(run.agentName);
    return {
      type: "reduce",
      ok: true,
      message: `reduced ${vote.way} ${symbol} -${reduced?.size ?? reduceQty.toFixed(4)} (~$${reduceUsd.toFixed(0)})`,
      position: await venue.fetchPositionSnapshot(symbol),
    };
  } catch (err) {
    return {
      type: "error",
      ok: false,
      message: (err as Error).message,
    };
  }
}

/**
 * reconcilePosition wrapped in the shared-account guard: serialize per symbol,
 * and refuse to disturb a symbol another local agent currently holds on the one
 * shared Bybit account. Ownership is claimed by whoever holds a live position
 * and released when the symbol goes flat. Avantis agents each trade their own
 * wallet, so they need no cross-agent guard and reconcile directly.
 */
async function reconcileGuarded(
  run: AgentRunContext,
  vote: VoteResult,
): Promise<ReconcileResult> {
  const { ctx, venue } = run;
  if (!venue || venue.id !== "Bybit") return reconcilePosition(run, vote);
  const symbol = resolveSymbol(ctx.market);

  return withSymbolLock(symbol, async () => {
    const owner = symbolOwner.get(symbol);
    if (owner && owner !== run.agentName) {
      // Confirm the owner's position is still live before blocking, so a crashed
      // or closed-out owner cannot lock the symbol to itself forever.
      const held = await venue.getOpenPosition(symbol);
      if (held) {
        return {
          type: "skipped",
          ok: false,
          message: `${symbol} is held by ${owner} on the shared Bybit account — not trading it`,
        };
      }
      symbolOwner.delete(symbol);
    }

    const result = await reconcilePosition(run, vote);

    // A successful reconcile that leaves a live position claims the symbol for
    // this agent; a flat outcome releases it. Errors/skips leave ownership as-is.
    if (result.ok) {
      if (result.position) symbolOwner.set(symbol, run.agentName);
      else symbolOwner.delete(symbol);
    }
    return result;
  });
}

export function attachDiscussionHandlers(
  socket: Socket,
  agentName: string,
): void {
  if (attached.has(socket)) return;
  attached.add(socket);

  socket.on(
    "discussion:vote-request",
    async (
      payload: {
        sessionId?: string;
        roomId?: string;
        phase?: "initial" | "final";
        transcript?: unknown;
        timeoutMs?: number;
      },
      ack?: (response: {
        way: string;
        rationale: string;
        sizeUsd: number;
      }) => void,
    ) => {
      const receivedAt = Date.now();
      try {
        const roomId = payload?.roomId ?? "";
        const sessionId = payload?.sessionId ?? "";
        const phase = payload?.phase === "final" ? "final" : "initial";
        const run = await buildContext(agentName, roomId, payload?.transcript);
        if (!run) {
          ack?.({ way: "NOTR", rationale: "", sizeUsd: 0 });
          return;
        }

        // Make the decision tool-capable: let the agent run its saved scripts or
        // write a quick ccxt fetch to get any data its strategy needs, instead
        // of voting NOTR because "data is not provided". Signals it emits are
        // cached so the discussion turns and the final vote can reuse them.
        const reporters = makeCodeReporters(agentName, roomId);
        const sandboxSystem = await buildSandboxSystemPrompt(run.ctx.strategy);
        const voteTools: VoteToolOptions = {
          tools: buildSandboxTools({
            agent: agentName,
            market: run.ctx.market,
            interval: run.ctx.interval,
            network: run.network,
            onSignal: (s) => {
              void writeSignals(agentName, roomId, s).catch(() => {});
            },
            llm: {
              provider: run.ctx.provider,
              model: run.ctx.model,
              apiKey: run.ctx.apiKey,
              system: sandboxSystem,
            },
            reporters,
          }),
          onToolCall: reporters.onToolCall,
          onToolResult: reporters.onToolResult,
        };

        const result = await askVoteResilient(run.ctx, phase, voteTools);
        const clamped = clampVote(result.way, result.sizeUsd, run.ctx.capUsd);
        const vote: VoteResult = {
          way: clamped.way,
          sizeUsd: clamped.sizeUsd,
          rationale: result.rationale,
        };
        ack?.({
          way: vote.way,
          rationale: vote.rationale,
          sizeUsd: vote.sizeUsd,
        });

        const voteKey = `vote:${sessionId}:${agentName}:${phase}`;
        if (once(voteKey)) {
          emitDiscussionEvent({
            type: "vote",
            sessionId,
            roomId,
            agentName,
            phase,
            way: vote.way,
            rationale: vote.rationale,
          });
        }

        const record = getRecord(agentName, sessionId, roomId);
        if (phase === "initial") {
          record.initial = vote;
        } else {
          record.final = vote;
          if (record.action) return;
          if (!once(`reconcile:${agentName}:${sessionId}`)) return;

          // Do not trade a vote we produced after the node's window closed — by
          // then the node has recorded this agent as an abstainer, so opening a
          // real position would diverge from the record, the score, and the
          // on-chain proof. Skip and surface why.
          const timeoutMs =
            typeof payload?.timeoutMs === "number" && payload.timeoutMs > 0
              ? payload.timeoutMs
              : DEFAULT_VOTE_TIMEOUT_MS;
          if (Date.now() - receivedAt > timeoutMs - VOTE_ACK_SAFETY_MS) {
            const late = {
              type: "skipped",
              ok: false,
              message: `vote ready after the ${Math.round(
                timeoutMs / 1000,
              )}s window — not trading (node recorded an abstain)`,
            };
            record.action = late;
            emitDiscussionEvent({
              type: "action",
              sessionId,
              roomId,
              agentName,
              kind: "skipped",
              ok: false,
              message: late.message,
            });
            await writeHistory(record);
            records.delete(recordKey(agentName, sessionId));
            return;
          }

          record.action = { type: "pending", ok: true, message: "executing…" };
          await writeHistory(record);
          const action = await reconcileGuarded(run, vote);
          record.action = action;
          emitDiscussionEvent({
            type: "action",
            sessionId,
            roomId,
            agentName,
            kind: action.type as
              | "open"
              | "flip"
              | "add"
              | "reduce"
              | "close"
              | "hold"
              | "none"
              | "skipped"
              | "error",
            ok: action.ok,
            message: action.message,
            position: action.position,
          });
          await writeHistory(record);
          records.delete(recordKey(agentName, sessionId));
        }
      } catch (err) {
        // Abstain (safe outcome — never trade on a failed decision), but make
        // the failure visible instead of silently voting NOTR: a bad model id,
        // wrong API key, or provider outage would otherwise look like a healthy
        // "no trade" and never get diagnosed.
        const reason = err instanceof Error ? err.message : String(err);
        emitDiscussionEvent({
          type: "action",
          sessionId: payload?.sessionId ?? "",
          roomId: payload?.roomId ?? "",
          agentName,
          kind: "error",
          ok: false,
          message: `vote failed, abstaining: ${reason}`,
        });
        ack?.({ way: "NOTR", rationale: "", sizeUsd: 0 });
      }
    },
  );

  socket.on(
    "discussion:turn-request",
    async (
      payload: {
        sessionId?: string;
        roomId?: string;
        round?: number;
        transcript?: unknown;
      },
      ack?: (response: { content: string }) => void,
    ) => {
      try {
        const roomId = payload?.roomId ?? "";
        const sessionId = payload?.sessionId ?? "";
        const round = typeof payload?.round === "number" ? payload.round : 1;
        const run = await buildContext(agentName, roomId, payload?.transcript);
        if (!run) {
          ack?.({ content: "" });
          return;
        }
        const content = await askDiscussionTurn(run.ctx, round);
        ack?.({ content });
        if (content.trim()) {
          getRecord(agentName, sessionId, roomId).turns.push({ round, content });
        }
      } catch {
        ack?.({ content: "" });
      }
    },
  );

  socket.on(
    "session:open",
    (payload: {
      sessionId: string;
      roomId: string;
      market: string;
      interval: string;
      participants: string[];
    }) => {
      if (!once(`open:${payload.sessionId}`)) return;
      emitDiscussionEvent({
        type: "open",
        sessionId: payload.sessionId,
        roomId: payload.roomId,
        market: payload.market,
        interval: payload.interval,
        participants: payload.participants ?? [],
      });
    },
  );

  socket.on(
    "session:turn",
    (payload: {
      sessionId: string;
      roomId: string;
      agentName: string;
      round: number;
      content: string;
    }) => {
      if (
        !once(`turn:${payload.sessionId}:${payload.agentName}:${payload.round}`)
      )
        return;
      emitDiscussionEvent({
        type: "turn",
        sessionId: payload.sessionId,
        roomId: payload.roomId,
        agentName: payload.agentName,
        round: payload.round,
        content: payload.content,
      });
    },
  );

  socket.on(
    "session:vote",
    (payload: {
      sessionId: string;
      roomId: string;
      agentName: string;
      phase: "initial" | "final";
      way: "LONG" | "SHORT" | "NOTR";
      rationale: string;
    }) => {
      // Own votes are logged from discussion:vote-request (authoritative ack).
      if (payload.agentName === agentName) return;
      if (
        !once(`vote:${payload.sessionId}:${payload.agentName}:${payload.phase}`)
      )
        return;
      emitDiscussionEvent({
        type: "vote",
        sessionId: payload.sessionId,
        roomId: payload.roomId,
        agentName: payload.agentName,
        phase: payload.phase,
        way: payload.way,
        rationale: payload.rationale ?? "",
      });
    },
  );

  socket.on(
    "session:close",
    (payload: {
      sessionId: string;
      roomId: string;
      rounds: number;
      tally: { LONG: number; SHORT: number; NOTR: number };
    }) => {
      if (once(`close:${payload.sessionId}`)) {
        emitDiscussionEvent({
          type: "close",
          sessionId: payload.sessionId,
          roomId: payload.roomId,
          rounds: payload.rounds,
          tally: payload.tally,
        });
      }
      // Post-session self-improvement: best-effort, once per agent per session.
      if (once(`reflect:${payload.sessionId}:${agentName}`)) {
        void (async () => {
          try {
            const rctx = await resolveResearchContext(agentName, payload.roomId);
            if (rctx) {
              await runReflection(rctx, {
                tally: payload.tally,
                rounds: payload.rounds,
              });
            }
          } catch {
            // reflection is best-effort; never disrupt the session flow
          }
        })();
      }
    },
  );
}
