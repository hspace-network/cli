import chalk from "chalk";
import { validateAgentName, createAgent, updateAgentConfig } from "../services/agent.service.js";
import {
  generateWallet,
  importFromPrivateKey,
  importFromMnemonic,
  saveWallet,
} from "../services/wallet.service.js";
import { loadCliConfig } from "../services/config.service.js";
import { registerAgent } from "../services/registration.service.js";
import { dirExists, getAgentDir } from "../utils/fs.js";
import { setBusy } from "../utils/busy.js";
import { log } from "../utils/logger.js";
import type { InteractiveResult, PendingPrompt } from "./index.js";

function walletSuccessLines(name: string, address: string, privateKey?: string): string[] {
  const lines = [
    log.blank(),
    log.success(`Registered ${chalk.cyanBright.bold(name)} with the node.`),
    log.raw(`  ${chalk.dim("Address")}  ${chalk.white(address)}`),
  ];
  if (privateKey) {
    lines.push(
      log.blank(),
      log.warn("Back up this private key — it will not be shown again:"),
      log.raw(`  ${chalk.yellow(privateKey)}`),
    );
  }
  lines.push(
    log.blank(),
    log.dim(`  Run ${chalk.cyan(`edit ${name}`)} to define its strategy.`),
    log.blank(),
  );
  return lines;
}

async function handleWalletSave(
  name: string,
  result: { address: string; privateKey: string },
  showKey: boolean,
): Promise<{ lines: string[] }> {
  const cfg = await loadCliConfig();

  setBusy("Registering agent with node...");
  try {
    await registerAgent({
      nodeUrl: cfg.nodeUrl,
      name,
      address: result.address,
      privateKey: result.privateKey as `0x${string}`,
    });
  } catch (err) {
    setBusy(null);
    return {
      lines: [
        log.error(`Registration failed: ${(err as Error).message}`),
        log.dim("  Agent was not created."),
      ],
    };
  }
  setBusy(null);

  try {
    await createAgent(name);
    await saveWallet(name, result);
    await updateAgentConfig(name, { walletAddress: result.address });
  } catch (err) {
    return {
      lines: [
        log.error(`Failed to persist agent locally: ${(err as Error).message}`),
        log.dim("  Note: the agent was registered with the node."),
      ],
    };
  }

  return { lines: walletSuccessLines(name, result.address, showKey ? result.privateKey : undefined) };
}

function walletPrompt(name: string): PendingPrompt {
  return {
    prompt: `${chalk.dim("Wallet setup:")} ${chalk.white("(1)")} Generate new  ${chalk.white("(2)")} Import private key  ${chalk.white("(3)")} Import mnemonic`,
    onResponse: async (input: string) => {
      const choice = input.trim();

      if (choice === "1") {
        try {
          const wallet = generateWallet();
          return handleWalletSave(name, wallet, true);
        } catch (err) {
          return { lines: [log.error((err as Error).message)] };
        }
      }

      if (choice === "2") {
        return {
          lines: [],
          nextPrompt: {
            prompt: `${chalk.dim("Enter private key")} ${chalk.dim("(0x...):")}`,
            onResponse: async (keyInput: string) => {
              try {
                const wallet = importFromPrivateKey(keyInput);
                return handleWalletSave(name, wallet, false);
              } catch (err) {
                return { lines: [log.error((err as Error).message)] };
              }
            },
          },
        };
      }

      if (choice === "3") {
        return {
          lines: [],
          nextPrompt: {
            prompt: `${chalk.dim("Enter mnemonic phrase (12 or 24 words):")}`,
            onResponse: async (mnemonicInput: string) => {
              try {
                const wallet = importFromMnemonic(mnemonicInput);
                return handleWalletSave(name, wallet, false);
              } catch (err) {
                return { lines: [log.error((err as Error).message)] };
              }
            },
          },
        };
      }

      return {
        lines: [log.error("Invalid choice. Please enter 1, 2, or 3.")],
        nextPrompt: walletPrompt(name),
      };
    },
  };
}

export async function createCommand(args: string[]): Promise<InteractiveResult> {
  const name = args[0];
  const validationError = validateAgentName(name);
  if (validationError) {
    return { lines: [log.error(validationError)] };
  }

  if (await dirExists(getAgentDir(name!))) {
    return { lines: [log.error(`Agent "${name}" already exists.`)] };
  }

  return {
    lines: [
      log.blank(),
      log.dim(`  Creating agent ${chalk.cyanBright.bold(name!)}...`),
    ],
    prompt: walletPrompt(name!),
  };
}
