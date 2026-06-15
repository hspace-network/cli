import { authedFetch } from "./auth.service.js";

export async function syncAgentLimits(args: {
  nodeUrl: string;
  name: string;
  spendingCapUsd: number;
}): Promise<void> {
  const path = `/agents/${encodeURIComponent(args.name)}`;
  await authedFetch({
    nodeUrl: args.nodeUrl,
    name: args.name,
    path,
    options: {
      method: "PATCH",
      body: { spendingCapUsd: args.spendingCapUsd },
    },
  });
}

/** Push local spending cap to the node so vote logs match trade execution. */
export async function ensureAgentLimitsSynced(args: {
  nodeUrl: string;
  name: string;
  spendingCapUsd: number;
}): Promise<void> {
  try {
    await syncAgentLimits(args);
  } catch {
    // best-effort; run should still proceed
  }
}

export async function deleteAgentOnNode(args: {
  nodeUrl: string;
  name: string;
}): Promise<void> {
  const path = `/agents/${encodeURIComponent(args.name)}`;
  await authedFetch<{ ok: boolean }>({
    nodeUrl: args.nodeUrl,
    name: args.name,
    path,
    options: { method: "DELETE" },
  });
}
