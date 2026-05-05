import { authedFetch } from "./auth.service.js";

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
