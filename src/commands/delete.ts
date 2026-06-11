import chalk from "chalk";
import { deleteAgent, getAgent } from "../services/agent.service.js";
import { deleteAgentOnNode } from "../services/nodeAgent.service.js";
import { loadCliConfig } from "../services/config.service.js";
import { walletExists } from "../services/wallet.service.js";
import { clearAgent } from "../services/runs.cache.js";
import {
  getActiveAgent,
  clearActiveAgent,
} from "../services/active-agent.service.js";
import { fileExists, getAgentTokenPath, removeFile } from "../utils/fs.js";
import { setBusy } from "../utils/busy.js";
import { HttpError } from "../utils/http.js";
import { log } from "../utils/logger.js";
import type { InteractiveResult } from "./index.js";

export async function deleteCommand(args: string[]): Promise<InteractiveResult> {
  const name = args[0];
  if (!name) {
    return { lines: [log.error("Usage: delete <name>")] };
  }

  try {
    await getAgent(name);
  } catch (err) {
    return { lines: [log.error((err as Error).message)] };
  }

  const prompt = `${chalk.yellow("[!]")} Delete agent ${chalk.red.bold(name)}? This cannot be undone. (y/N)`;

  return {
    lines: [],
    prompt: {
      prompt,
      onResponse: async (input: string) => {
        if (input.trim().toLowerCase() !== "y") {
          return { lines: [log.dim("  Cancelled.")] };
        }

        if (!(await walletExists(name))) {
          return {
            lines: [
              log.error(
                `Cannot delete "${name}" on the node without a wallet file. Import or generate a wallet first.`,
              ),
            ],
          };
        }

        const cfg = await loadCliConfig();

        setBusy("Deleting agent on node...");
        try {
          await deleteAgentOnNode({ nodeUrl: cfg.nodeUrl, name });
        } catch (err) {
          setBusy(null);
          const msg =
            err instanceof HttpError
              ? err.message
              : (err as Error).message;
          return {
            lines: [
              log.error(`Node did not delete the agent: ${msg}`),
              log.dim("  Local files were not changed."),
            ],
          };
        }
        setBusy(null);

        const tokenPath = getAgentTokenPath(name);
        if (await fileExists(tokenPath)) {
          await removeFile(tokenPath);
        }

        await deleteAgent(name);
        clearAgent(name);
        if (getActiveAgent() === name) {
          clearActiveAgent();
        }

        const hasWallet = await walletExists(name);
        const lines = [
          log.success(
            `Agent ${chalk.cyanBright(name)} removed from the node and locally.`,
          ),
        ];
        if (hasWallet) {
          lines.push(log.dim("  Wallet data preserved."));
        }
        return { lines };
      },
    },
  };
}
