import { io, type Socket } from "socket.io-client";
import { getAuthHeader } from "./auth.service.js";
import { attachDiscussionHandlers } from "./discussion.client.js";
import { getAgent } from "./agent.service.js";
import { ensureAgentLimitsSynced } from "./nodeAgent.service.js";
import {
  startSandboxResearch,
  stopSandboxResearch,
} from "./sandbox.scheduler.js";

interface SocketEntry {
  socket: Socket;
  nodeUrl: string;
}

const sockets = new Map<string, SocketEntry>();

const ACK_TIMEOUT_MS = 5000;

function trimUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

function tokenFromHeader(header: { Authorization: string }): string {
  const value = header.Authorization;
  return value.startsWith("Bearer ") ? value.slice("Bearer ".length) : value;
}

async function getSocket(args: {
  nodeUrl: string;
  agentName: string;
}): Promise<Socket> {
  const base = trimUrl(args.nodeUrl);
  const key = `${base}::${args.agentName}`;
  const existing = sockets.get(key);
  if (existing && existing.socket.connected) return existing.socket;

  const header = await getAuthHeader({
    nodeUrl: args.nodeUrl,
    name: args.agentName,
  });
  const token = tokenFromHeader(header);

  const socket = io(base, {
    transports: ["websocket", "polling"],
    auth: { token },
    extraHeaders: { Authorization: `Bearer ${token}` },
    autoConnect: false,
    reconnection: true,
    reconnectionAttempts: 3,
    timeout: 8000,
  });

  attachDiscussionHandlers(socket, args.agentName);

  try {
    const agentCfg = await getAgent(args.agentName);
    await ensureAgentLimitsSynced({
      nodeUrl: args.nodeUrl,
      name: args.agentName,
      spendingCapUsd: agentCfg.spendingCapUsd ?? 0,
    });
  } catch {
    // cap sync is best-effort
  }

  await new Promise<void>((resolve, reject) => {
    const onConnect = () => {
      socket.off("connect_error", onError);
      resolve();
    };
    const onError = (err: Error) => {
      socket.off("connect", onConnect);
      reject(new Error(err.message || "socket connection failed"));
    };
    socket.once("connect", onConnect);
    socket.once("connect_error", onError);
    socket.connect();
  });

  sockets.set(key, { socket, nodeUrl: base });
  return socket;
}

interface AckResponse {
  ok: boolean;
  error?: string;
  roomId?: string;
}

function emitWithAck(
  socket: Socket,
  event: "agent:run" | "agent:stop",
  payload: { agentName: string; roomId: string },
): Promise<AckResponse> {
  return new Promise<AckResponse>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(
          `Node did not respond to ${event} within ${ACK_TIMEOUT_MS}ms. Is the node running the latest build with socket handlers?`,
        ),
      );
    }, ACK_TIMEOUT_MS);

    socket.emit(event, payload, (response: AckResponse | undefined) => {
      clearTimeout(timer);
      if (!response) {
        reject(new Error(`Empty ack from node for ${event}.`));
        return;
      }
      resolve(response);
    });
  });
}

export async function runAgent(args: {
  nodeUrl: string;
  agentName: string;
  roomId: string;
}): Promise<void> {
  try {
    const agentCfg = await getAgent(args.agentName);
    await ensureAgentLimitsSynced({
      nodeUrl: args.nodeUrl,
      name: args.agentName,
      spendingCapUsd: agentCfg.spendingCapUsd ?? 0,
    });
  } catch {
    // cap sync is best-effort
  }
  const socket = await getSocket(args);
  const ack = await emitWithAck(socket, "agent:run", {
    agentName: args.agentName,
    roomId: args.roomId,
  });
  if (!ack.ok) {
    throw new Error(ack.error ?? "Run was rejected by node.");
  }
  // Warm sandbox signals in the background for this room.
  startSandboxResearch(args.agentName, args.roomId);
}

export async function stopAgent(args: {
  nodeUrl: string;
  agentName: string;
  roomId: string;
}): Promise<void> {
  const socket = await getSocket(args);
  const ack = await emitWithAck(socket, "agent:stop", {
    agentName: args.agentName,
    roomId: args.roomId,
  });
  if (!ack.ok) {
    throw new Error(ack.error ?? "Stop was rejected by node.");
  }
  stopSandboxResearch(args.agentName, args.roomId);
}

export function disconnectAllSockets(): void {
  for (const entry of sockets.values()) {
    try {
      entry.socket.disconnect();
    } catch {
      // ignore
    }
  }
  sockets.clear();
}
