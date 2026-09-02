import { getAgent } from "../services/agent.service.js";
import {
  loadCliConfig,
  getEffectiveNetwork,
  getEffectiveChain,
  validateChainNetworkPair,
  getPlatformCreds,
  type BybitNetwork,
  type ChainId,
  type CliConfig,
} from "../services/config.service.js";
import { loadWallet } from "../services/wallet.service.js";
import type { BybitCreds } from "../services/bybit.service.js";
import { chainProfile, type ChainProfile } from "../services/deposit-assets.js";

export interface BalanceContext {
  agentName: string;
  cfg: CliConfig;
  network: BybitNetwork;
  chainId: ChainId;
  profile: ChainProfile;
  /** Per-agent venue. Avantis agents fund their own wallet (no Bybit rail). */
  platform: "Bybit" | "Avantis";
  /** Bybit credentials — null is allowed for Avantis agents (no CEX needed). */
  creds: BybitCreds | null;
  walletAddress: string;
  privateKey: `0x${string}`;
}

export async function resolveBalanceContext(
  agentName: string,
): Promise<BalanceContext | { error: string }> {
  if (!agentName) {
    return { error: "Usage: <command> <agent> ..." };
  }

  let agentCfg;
  try {
    agentCfg = await getAgent(agentName);
  } catch (err) {
    return { error: (err as Error).message };
  }

  let wallet;
  try {
    wallet = await loadWallet(agentName);
  } catch (err) {
    return { error: (err as Error).message };
  }

  const cfg = await loadCliConfig();
  const network = getEffectiveNetwork(cfg);
  const chainId = getEffectiveChain(cfg);
  const pairErr = validateChainNetworkPair(chainId, network);
  if (pairErr) {
    return { error: pairErr };
  }

  const platform = agentCfg.platform === "Avantis" ? "Avantis" : "Bybit";
  const creds = getPlatformCreds(cfg, "Bybit") ?? null;
  if (platform === "Bybit" && !creds) {
    return {
      error: 'Set your Bybit API key in settings ("settings" → Platform).',
    };
  }

  return {
    agentName,
    cfg,
    network,
    chainId,
    profile: chainProfile(chainId),
    platform,
    creds,
    walletAddress: wallet.address,
    privateKey: wallet.privateKey as `0x${string}`,
  };
}
