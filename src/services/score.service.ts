import { request, HttpError } from "../utils/http.js";

export interface AgentScore {
  agent: string;
  score: number;
}

/**
 * Look up an agent's excellence score on the node.
 * Returns null if the agent does not exist (404).
 */
export async function fetchAgentScore(args: {
  nodeUrl: string;
  agentName: string;
}): Promise<AgentScore | null> {
  const base = args.nodeUrl.replace(/\/+$/, "");
  const url = `${base}/score?agent=${encodeURIComponent(args.agentName)}`;

  try {
    return await request<AgentScore>(url, { method: "GET" });
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) {
      return null;
    }
    throw err;
  }
}

/**
 * Returns true if the agent name is already registered on the node.
 */
export async function agentExistsOnNode(args: {
  nodeUrl: string;
  agentName: string;
}): Promise<boolean> {
  const score = await fetchAgentScore(args);
  return score !== null;
}

export interface AgentScoreEntry {
  agent: string;
  score: number | null;
}

export async function fetchAllAgentScores(args: {
  nodeUrl: string;
  agentNames: string[];
}): Promise<AgentScoreEntry[]> {
  const results = await Promise.all(
    args.agentNames.map(async (agent) => {
      const res = await fetchAgentScore({
        nodeUrl: args.nodeUrl,
        agentName: agent,
      });
      return { agent, score: res?.score ?? null };
    }),
  );
  return results;
}
