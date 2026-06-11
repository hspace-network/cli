import type { Socket } from "socket.io-client";
import { getAgent } from "./agent.service.js";
import { resolveStrategyForAgent } from "./strategy.service.js";
import {
  loadCliConfig,
  getCachedNodeConfig,
  getEffectiveSelection,
  getProviderApiKey,
  getPlatformCreds,
  getEffectiveNetwork,
  type BybitNetwork,
} from "./config.service.js";
import {
  askVote,
  askDiscussionTurn,
  type DiscussionContext,
  type DiscussionTurn,
  type VoteResult,
} from "./llm.service.js";
import { resolveSymbol, type BybitCreds } from "./bybit.service.js";
import {
  getOpenPosition,
  closePosition,
  openMarketNotional,
  reducePosition,
  positionNotionalUsd,
  fetchPositionSnapshot,
  type PositionSnapshot,
} from "./positions.service.js";
import { fetchLastPrice, getInstrument } from "./bybit.service.js";
import { emitDiscussionEvent } from "./discussion.bus.js";
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
  ctx: DiscussionContext;
  network: BybitNetwork;
  creds: BybitCreds | null;
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

  const strategy = (await resolveStrategyForAgent(agentName)) ?? undefined;
  const { market, interval } = splitRoom(roomId);

  let capUsd = 0;
  try {
    const agentCfg = await getAgent(agentName);
    capUsd = agentCfg.spendingCapUsd ?? 0;
  } catch {
    capUsd = 0;
  }

  return {
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
    },
    network: getEffectiveNetwork(cfg),
    creds: getPlatformCreds(cfg, "Bybit") ?? null,
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

/**
 * Reconcile open position to the final vote using target-size semantics:
 * sizeUsd is the desired total notional in USD for LONG/SHORT votes.
 */
async function reconcilePosition(
  run: AgentRunContext,
  vote: VoteResult,
): Promise<ReconcileResult> {
  const { ctx, network, creds } = run;
  if (!creds) {
    return {
      type: "skipped",
      ok: false,
      message: "no Bybit credentials set — skipped auto-trade",
    };
  }

  const symbol = resolveSymbol(ctx.market);

  try {
    const position = await getOpenPosition(symbol, network, creds);

    if (vote.way === "NOTR") {
      if (!position) {
        return { type: "none", ok: true, message: "NOTR — stayed flat", position: null };
      }
      const closed = await closePosition(symbol, network, creds);
      return {
        type: "close",
        ok: true,
        message: `NOTR — closed ${symbol} ${closed?.size ?? ""}`.trim(),
        position: null,
      };
    }

    const targetSide = vote.way === "LONG" ? "long" : "short";
    const targetUsd = vote.sizeUsd;

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
        return {
          type: "close",
          ok: true,
          message: `closed opposite ${symbol} (no stake to re-open)`,
          position: null,
        };
      }
      const opened = await openMarketNotional(symbol, targetSide, targetUsd, network, creds);
      return {
        type: "flip",
        ok: true,
        message: `flipped to ${vote.way} ${symbol} ${opened.qty} (~$${targetUsd})`,
        position: await snapshotAfter(symbol, network, creds),
      };
    }

    // Same side — adjust toward target total size.
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
      const added = await openMarketNotional(symbol, targetSide, diff, network, creds);
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
        const result = await askVote(run.ctx, phase);
        ack?.({
          way: result.way,
          rationale: result.rationale,
          sizeUsd: result.sizeUsd,
        });

        const record = getRecord(agentName, sessionId, roomId);
        if (phase === "initial") {
          record.initial = result;
        } else {
          record.final = result;
          const action = await reconcilePosition(run, result);
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
      if (!once(`close:${payload.sessionId}`)) return;
      emitDiscussionEvent({
        type: "close",
        sessionId: payload.sessionId,
        roomId: payload.roomId,
        rounds: payload.rounds,
        tally: payload.tally,
      });
    },
  );
}
