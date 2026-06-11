import { askLLM } from "../services/llm.service.js";
import {
  loadCliConfig,
  getCachedNodeConfig,
  getEffectiveSelection,
  getProviderApiKey,
} from "../services/config.service.js";
import { listAgents } from "../services/agent.service.js";
import { resolveStrategyForAgent } from "../services/strategy.service.js";
import {
  getHistory,
  pushExchange,
} from "../services/conversation.service.js";
import { log } from "../utils/logger.js";
import type { InteractiveResult } from "./index.js";

interface ResolvedScope {
  agentName?: string;
  strategy?: string;
  question: string;
  hint?: string;
  error?: string;
}

async function resolveScope(args: string[]): Promise<ResolvedScope> {
  const agents = await listAgents();
  const agentNames = new Set(agents.map((a) => a.name));

  const firstToken = args[0];
  if (firstToken && agentNames.has(firstToken)) {
    const remaining = args.slice(1).join(" ").trim();
    if (!remaining) {
      return {
        question: "",
        error: `Provide a question after the agent name. Usage: /ask ${firstToken} <question>`,
      };
    }
    const strategy = await resolveStrategyForAgent(firstToken);
    if (!strategy) {
      return {
        question: remaining,
        agentName: firstToken,
        hint: `agent "${firstToken}" has no strategy. Run "set strategy <name>" or open "strategy".`,
      };
    }
    return {
      question: remaining,
      agentName: firstToken,
      strategy,
      hint: `using strategy from agent "${firstToken}"`,
    };
  }

  const fullQuestion = args.join(" ").trim();

  if (agents.length === 0) {
    return { question: fullQuestion };
  }

  if (agents.length === 1) {
    const only = agents[0]!;
    const strategy = await resolveStrategyForAgent(only.name);
    if (!strategy) {
      return {
        question: fullQuestion,
        agentName: only.name,
        hint: `agent "${only.name}" has no strategy. Run "set strategy <name>" or open "strategy".`,
      };
    }
    return {
      question: fullQuestion,
      agentName: only.name,
      strategy,
      hint: `using strategy from agent "${only.name}"`,
    };
  }

  return {
    question: fullQuestion,
    error:
      "Multiple agents found. Specify one: /ask <agentName> <question>.",
  };
}

export async function askCommand(args: string[]): Promise<InteractiveResult> {
  const rawQuestion = args.join(" ").trim();
  if (!rawQuestion) {
    return { lines: [log.error("Usage: /ask <question>")] };
  }

  const cfg = await loadCliConfig();
  const nodeCfg = getCachedNodeConfig();
  const effective = getEffectiveSelection(cfg, nodeCfg?.defaults, nodeCfg?.providers);

  if (!effective.provider || !effective.model) {
    return {
      lines: [log.error('Pick a provider and model in "settings" first.')],
    };
  }

  const providerApiKey = getProviderApiKey(cfg, effective.provider);
  if (!providerApiKey) {
    return {
      lines: [
        log.error(
          `No API key for "${effective.provider}". Run "settings", pick the provider, and add its key.`,
        ),
      ],
    };
  }

  const scope = await resolveScope(args);
  if (scope.error) {
    return { lines: [log.error(scope.error)] };
  }

  const provider = effective.provider;
  const model = effective.model;
  const apiKey = providerApiKey;
  const question = scope.question;
  const strategy = scope.strategy;
  const scopeKey = scope.agentName;
  const history = getHistory(scopeKey);

  const prelude: string[] = [];
  if (scope.hint) {
    prelude.push(log.dim(`  ${scope.hint}`));
  }

  return {
    lines: prelude,
    stream: {
      prefixLine: "",
      start: async (handle) => {
        let answer = "";
        try {
          await askLLM({
            provider,
            model,
            apiKey,
            question,
            strategy,
            history,
            onToken: (chunk) => {
              answer += chunk;
              handle.appendToken(chunk);
            },
          });
          if (answer.trim()) {
            pushExchange(scopeKey, question, answer);
          }
          handle.finalize([log.blank()]);
        } catch (err) {
          handle.fail(log.error((err as Error).message));
        }
      },
    },
  };
}
