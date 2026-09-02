/**
 * Headless agent runner. Launched as a detached child by the `auto` command
 * (via `<entry> __agent-runner <agent> <room>`), it holds the node socket and
 * answers vote/turn requests for one agent+room, surviving the CLI it was
 * started from. No Ink/TUI here — it runs until killed (SIGTERM).
 */
import {
  loadCliConfig,
  fetchNodeConfig,
  setCachedNodeConfig,
} from "./services/config.service.js";
import { getAgent } from "./services/agent.service.js";
import { walletExists } from "./services/wallet.service.js";
import { runAgent, disconnectAllSockets } from "./services/socket.service.js";

export async function runAgentDaemon(agent: string, room: string): Promise<void> {
  if (!agent || !room) {
    console.error("[auto] usage: __agent-runner <agent> <room>");
    process.exit(1);
  }

  const cfg = await loadCliConfig();

  // The vote/turn path resolves provider + model from the cached node config,
  // so a fresh daemon process must fetch it before joining (the TUI does this
  // on `node set`; this process has an empty cache).
  try {
    setCachedNodeConfig(await fetchNodeConfig(cfg.nodeUrl));
  } catch (err) {
    console.error(`[auto] cannot reach node ${cfg.nodeUrl}: ${(err as Error).message}`);
    process.exit(1);
  }

  try {
    await getAgent(agent);
    if (!(await walletExists(agent))) throw new Error(`no wallet on disk for "${agent}"`);
  } catch (err) {
    console.error(`[auto] ${(err as Error).message}`);
    process.exit(1);
  }

  const shutdown = () => {
    console.log(`[auto] ${agent} stopping (${room}) ${new Date().toISOString()}`);
    try {
      disconnectAllSockets();
    } catch {
      /* ignore */
    }
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  try {
    await runAgent({ nodeUrl: cfg.nodeUrl, agentName: agent, roomId: room });
  } catch (err) {
    console.error(`[auto] failed to join ${room}: ${(err as Error).message}`);
    process.exit(1);
  }

  console.log(
    `[auto] ${agent} live in ${room} · pid ${process.pid} · ${new Date().toISOString()}`,
  );

  // Nothing else to do on the main thread — the socket handlers drive the work.
  // Keep the event loop alive until a signal arrives.
  setInterval(() => {}, 1 << 30);
}
