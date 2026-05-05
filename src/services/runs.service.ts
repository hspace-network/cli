import { authedFetch } from "./auth.service.js";

export interface AgentRuns {
  name: string;
  rooms: string[];
}

interface RunsResponse {
  runs: AgentRuns[];
}

export async function fetchAllRuns(args: {
  nodeUrl: string;
  agentName: string;
}): Promise<AgentRuns[]> {
  const res = await authedFetch<RunsResponse>({
    nodeUrl: args.nodeUrl,
    name: args.agentName,
    path: "/agents/me/runs",
    options: { method: "GET" },
  });
  return Array.isArray(res?.runs) ? res.runs : [];
}

export async function fetchRunsForAgent(args: {
  nodeUrl: string;
  agentName: string;
}): Promise<string[]> {
  const all = await fetchAllRuns(args);
  const entry = all.find((r) => r.name === args.agentName);
  return entry?.rooms ?? [];
}
