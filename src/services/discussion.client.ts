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
  getOpenPosition,
  closePosition,
  openMarketNotional,
  reducePosition,
  positionNotionalUsd,
  fetchPositionSnapshot,
  getSymbolLeverage,
  setPositionStops,
  type PositionSnapshot,
  type PositionSide,
} from "./positions.service.js";
import { fetchLastPrice, getInstrument } from "./bybit.service.js";
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

  // Current live position on this symbol, so the agent reasons about what it
  // already holds (add/reduce/flip/hold) rather than deciding in a vacuum.
  let position: string | undefined;
  if (creds) {
    try {
      const pos = await getOpenPosition(resolveSymbol(market), network, creds);
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

async function snapshotAfter(
  symbol: string,
  network: BybitNetwork,
  creds: BybitCreds,
): Promise<PositionSnapshot | null> {
  return fetchPositionSnapshot(symbol, network, creds);
}

async function applyAutoStops(
  symbol: string,
  side: PositionSide,
  entryPrice: number,
  agentCfg: AgentConfig,
  network: BybitNetwork,
  creds: BybitCreds,
): Promise<void> {
  try {
    await setPositionStops({
      symbol,
      side,
      entryPrice,
      slPct: agentCfg.defaultSlPct,
      tpPct: agentCfg.defaultTpPct,
      network,
      creds,
    });
  } catch {
    // stops are best-effort
  }
}

async function guardTradeLimits(
  run: AgentRunContext,
  targetUsd: number,
  symbol: string,
): Promise<ReconcileResult | null> {
  const { agentCfg, network, creds } = run;
  if (!creds) return null;

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
  const lev = await getSymbolLeverage(symbol, network, creds);
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
  const { ctx, network, creds, agentCfg } = run;
  if (!creds) {
    return {
      type: "skipped",
      ok: false,
      message: "no Bybit credentials set — skipped auto-trade",
    };
  }

  const symbol = resolveSymbol(ctx.market);
  const notrBehavior = agentCfg.notrBehavior ?? "hold";

  try {
    const position = await getOpenPosition(symbol, network, creds);

    if (vote.way === "NOTR") {
      if (!position) {
        return { type: "none", ok: true, message: "NOTR — stayed flat", position: null };
      }
      if (notrBehavior === "hold") {
        return {
          type: "none",
          ok: true,
          message: "NOTR — held position",
          position: await snapshotAfter(symbol, network, creds),
        };
      }
      const closed = await closePosition(symbol, network, creds);
      await incrementTradeCount(run.agentName);
      return {
        type: "close",
        ok: true,
        message: `NOTR — closed ${symbol} ${closed?.size ?? ""}`.trim(),
        position: null,
      };
    }

    const targetSide = vote.way === "LONG" ? "long" : "short";
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
      const opened = await openMarketNotional(symbol, targetSide, targetUsd, network, creds);
      await applyAutoStops(symbol, targetSide, opened.price, agentCfg, network, creds);
      await incrementTradeCount(run.agentName);
      return {
        type: "open",
        ok: true,
        message: `opened ${vote.way} ${symbol} ${opened.qty} (~$${targetUsd})`,
        position: await snapshotAfter(symbol, network, creds),
      };
    }

    if (position.side !== targetSide) {
      await closePosition(symbol, network, creds);
      if (targetUsd <= 0) {
        await incrementTradeCount(run.agentName);
        return {
          type: "close",
          ok: true,
          message: `closed opposite ${symbol} (no stake to re-open)`,
          position: null,
        };
      }
      const opened = await openMarketNotional(symbol, targetSide, targetUsd, network, creds);
      await applyAutoStops(symbol, targetSide, opened.price, agentCfg, network, creds);
      await incrementTradeCount(run.agentName);
      return {
        type: "flip",
        ok: true,
        message: `flipped to ${vote.way} ${symbol} ${opened.qty} (~$${targetUsd})`,
        position: await snapshotAfter(symbol, network, creds),
      };
    }

    const instrument = await getInstrument(symbol, network);
    const price = await fetchLastPrice(instrument.symbol, network);
    if (price === null || !Number.isFinite(price) || price <= 0) {
      throw new Error(`Could not fetch a price for ${instrument.symbol}.`);
    }

    const currentUsd = positionNotionalUsd(position, price);
    const minLotCost = instrument.minOrderQty * price;
    const tolerance = Math.max(currentUsd * 0.02, minLotCost);

    if (targetUsd <= 0) {
      const closed = await closePosition(symbol, network, creds);
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
        position: await snapshotAfter(symbol, network, creds),
      };
    }

    if (diff > tolerance) {
      const addGuard = await guardTradeLimits(run, targetUsd, symbol);
      if (addGuard) return addGuard;
      const added = await openMarketNotional(symbol, targetSide, diff, network, creds);
      await applyAutoStops(symbol, targetSide, added.price, agentCfg, network, creds);
      await incrementTradeCount(run.agentName);
      return {
        type: "add",
        ok: true,
        message: `added to ${vote.way} ${symbol} +${added.qty} (~$${diff.toFixed(0)})`,
        position: await snapshotAfter(symbol, network, creds),
      };
    }

    const reduceUsd = currentUsd - targetUsd;
    const reduceQty = reduceUsd / price;
    const reduced = await reducePosition(symbol, reduceQty, network, creds);
    await incrementTradeCount(run.agentName);
    const snap = await snapshotAfter(symbol, network, creds);
    return {
      type: "reduce",
      ok: true,
      message: `reduced ${vote.way} ${symbol} -${reduced?.size ?? reduceQty.toFixed(4)} (~$${reduceUsd.toFixed(0)})`,
      position: snap,
    };
  } catch (err) {
    return {
      type: "error",
      ok: false,
      message: (err as Error).message,
    };
  }
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
      },
      ack?: (response: {
        way: string;
        rationale: string;
        sizeUsd: number;
      }) => void,
    ) => {
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
          record.action = { type: "pending", ok: true, message: "executing…" };
          await writeHistory(record);
          const action = await reconcilePosition(run, vote);
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
      } catch {
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
