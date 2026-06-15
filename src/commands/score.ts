import chalk from "chalk";
import { listAgents } from "../services/agent.service.js";
import { loadCliConfig } from "../services/config.service.js";
import { fetchAllAgentScores } from "../services/score.service.js";
import { log } from "../utils/logger.js";

export async function scoreCommand(args: string[]): Promise<string[]> {
  const cfg = await loadCliConfig();

  // `score <name>` → that one agent; bare `score` → all of the user's agents.
  let names: string[];
  if (args[0]) {
    names = [args[0]];
  } else {
    const agents = await listAgents();
    if (agents.length === 0) {
      return [log.dim("  No agents found.")];
    }
    names = agents.map((a) => a.name);
  }

  let scores;
  try {
    scores = await fetchAllAgentScores({ nodeUrl: cfg.nodeUrl, agentNames: names });
  } catch (err) {
    return [log.error(`Could not reach node: ${(err as Error).message}`)];
  }

  if (names.length === 1) {
    const entry = scores[0];
    if (!entry || entry.score === null) {
      return [
        log.error(`Agent "${names[0]}" is not registered on the node (no score).`),
      ];
    }
    return [
      log.blank(),
      log.raw(
        `  ${chalk.cyanBright.bold(entry.agent)}  score ${chalk.green(entry.score.toFixed(1))} ${chalk.dim("/ 100")}`,
      ),
      log.blank(),
    ];
  }

  const sorted = [...scores].sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
  const lines = [log.blank(), log.heading("  Excellence Scores"), log.blank()];

  for (const entry of sorted) {
    if (entry.score === null) {
      lines.push(
        log.raw(
          `  ${chalk.cyanBright(entry.agent.padEnd(20))} ${chalk.dim("not on node")}`,
        ),
      );
      continue;
    }
    lines.push(
      log.raw(
        `  ${chalk.cyanBright(entry.agent.padEnd(20))} ${chalk.green(entry.score.toFixed(1).padStart(5))} ${chalk.dim("/ 100")}`,
      ),
    );
  }

  lines.push(log.blank());
  return lines;
}
