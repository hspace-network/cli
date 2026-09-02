import {
  createPublicClient,
  createWalletClient,
  http,
  parseEther,
  formatEther,
  parseUnits,
  formatUnits,
  erc20Abi,
  type PublicClient,
  type WalletClient,
  type Chain,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mantle, mantleSepoliaTestnet, base, baseSepolia } from "viem/chains";
import type { ChainId } from "./config.service.js";

const CHAINS: Record<ChainId, Chain> = {
  mantle,
  "mantle-sepolia": mantleSepoliaTestnet,
  base,
  "base-sepolia": baseSepolia,
};

export function getViemChain(chainId: ChainId): Chain {
  return CHAINS[chainId];
}

export function getPublicClient(chainId: ChainId): PublicClient {
  return createPublicClient({
    chain: getViemChain(chainId),
    transport: http(),
  });
}

export function getWalletClient(
  chainId: ChainId,
  privateKey: `0x${string}`,
): WalletClient {
  const account = privateKeyToAccount(privateKey);
  return createWalletClient({
    account,
    chain: getViemChain(chainId),
    transport: http(),
  });
}

export async function getWalletMntBalance(
  address: string,
  chainId: ChainId,
): Promise<bigint> {
  const client = getPublicClient(chainId);
  return client.getBalance({ address: address as `0x${string}` });
}

export function formatMnt(wei: bigint): string {
  const s = formatEther(wei);
  const n = Number(s);
  if (!Number.isFinite(n)) return s;
  if (n >= 1000) return n.toFixed(2);
  if (n >= 1) return n.toFixed(4);
  return n.toFixed(6);
}

export function parseMntAmount(amount: string): bigint {
  const trimmed = amount.trim();
  if (!trimmed) throw new Error("Amount is required.");
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`Invalid amount "${amount}".`);
  }
  return parseEther(trimmed);
}

export async function estimateMntTransferGas(args: {
  chainId: ChainId;
  from: `0x${string}`;
  to: string;
  amountWei: bigint;
}): Promise<bigint> {
  const client = getPublicClient(args.chainId);
  const gas = await client.estimateGas({
    account: args.from,
    to: args.to as `0x${string}`,
    value: args.amountWei,
  });
  const fees = await client.getGasPrice();
  return gas * fees;
}

export async function sendMnt(args: {
  chainId: ChainId;
  privateKey: `0x${string}`;
  to: string;
  amountWei: bigint;
}): Promise<`0x${string}`> {
  const chain = getViemChain(args.chainId);
  const account = privateKeyToAccount(args.privateKey);
  const client = getWalletClient(args.chainId, args.privateKey);
  const hash = await client.sendTransaction({
    account,
    chain,
    to: args.to as `0x${string}`,
    value: args.amountWei,
  });
  return hash;
}

export async function getWalletTokenBalance(args: {
  chainId: ChainId;
  tokenAddress: `0x${string}`;
  walletAddress: string;
}): Promise<bigint> {
  const client = getPublicClient(args.chainId);
  return client.readContract({
    address: args.tokenAddress,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [args.walletAddress as `0x${string}`],
  });
}

export function formatTokenAmount(wei: bigint, decimals: number): string {
  const s = formatUnits(wei, decimals);
  const n = Number(s);
  if (!Number.isFinite(n)) return s;
  if (n >= 1000) return n.toFixed(2);
  if (n >= 1) return n.toFixed(4);
  return n.toFixed(6);
}

export function parseTokenAmount(amount: string, decimals: number): bigint {
  const trimmed = amount.trim();
  if (!trimmed) throw new Error("Amount is required.");
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`Invalid amount "${amount}".`);
  }
  return parseUnits(trimmed, decimals);
}

export async function estimateTokenTransferGas(args: {
  chainId: ChainId;
  from: `0x${string}`;
  tokenAddress: `0x${string}`;
  to: string;
  amountWei: bigint;
}): Promise<bigint> {
  const client = getPublicClient(args.chainId);
  const gas = await client.estimateContractGas({
    address: args.tokenAddress,
    abi: erc20Abi,
    functionName: "transfer",
    args: [args.to as `0x${string}`, args.amountWei],
    account: args.from,
  });
  const fees = await client.getGasPrice();
  return gas * fees;
}

export async function sendToken(args: {
  chainId: ChainId;
  privateKey: `0x${string}`;
  tokenAddress: `0x${string}`;
  to: string;
  amountWei: bigint;
}): Promise<`0x${string}`> {
  const chain = getViemChain(args.chainId);
  const account = privateKeyToAccount(args.privateKey);
  const client = getWalletClient(args.chainId, args.privateKey);
  const hash = await client.writeContract({
    account,
    chain,
    address: args.tokenAddress,
    abi: erc20Abi,
    functionName: "transfer",
    args: [args.to as `0x${string}`, args.amountWei],
  });
  return hash;
}
