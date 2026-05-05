import { privateKeyToAccount } from "viem/accounts";
import { loadWallet } from "./wallet.service.js";
import { request, type RequestOptions } from "../utils/http.js";
import {
  ensureDir,
  fileExists,
  getAgentTokenPath,
  getWalletsDir,
  readJson,
  writeJson,
} from "../utils/fs.js";

interface ChallengeResponse {
  message: string;
  nonce: string;
}

interface VerifyResponse {
  token: string;
  expiresAt: number;
  agent: { name: string; address: string; score: number };
}

interface StoredToken {
  token: string;
  expiresAt: number;
  address: string;
}

const REFRESH_LEEWAY_MS = 60_000;

function trimUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

async function readToken(name: string): Promise<StoredToken | null> {
  const path = getAgentTokenPath(name);
  if (!(await fileExists(path))) return null;
  try {
    return await readJson<StoredToken>(path);
  } catch {
    return null;
  }
}

async function writeToken(name: string, token: StoredToken): Promise<void> {
  await ensureDir(getWalletsDir());
  await writeJson(getAgentTokenPath(name), token);
}

export async function signIn(args: {
  nodeUrl: string;
  name: string;
  address?: string;
  privateKey?: `0x${string}`;
}): Promise<StoredToken> {
  const base = trimUrl(args.nodeUrl);

  let address = args.address;
  let privateKey = args.privateKey;
  if (!address || !privateKey) {
    const wallet = await loadWallet(args.name);
    address = wallet.address;
    privateKey = wallet.privateKey as `0x${string}`;
  }

  const challenge = await request<ChallengeResponse>(`${base}/auth/challenge`, {
    body: { address },
  });

  const account = privateKeyToAccount(privateKey);
  const signature = await account.signMessage({ message: challenge.message });

  const verified = await request<VerifyResponse>(`${base}/auth/verify`, {
    body: {
      address,
      nonce: challenge.nonce,
      signature,
    },
  });

  const stored: StoredToken = {
    token: verified.token,
    expiresAt: verified.expiresAt,
    address: verified.agent.address,
  };
  await writeToken(args.name, stored);
  return stored;
}

export async function getAuthHeader(args: {
  nodeUrl: string;
  name: string;
}): Promise<{ Authorization: string }> {
  const existing = await readToken(args.name);
  if (existing && existing.expiresAt - Date.now() > REFRESH_LEEWAY_MS) {
    return { Authorization: `Bearer ${existing.token}` };
  }
  const fresh = await signIn({ nodeUrl: args.nodeUrl, name: args.name });
  return { Authorization: `Bearer ${fresh.token}` };
}

export async function authedFetch<T>(args: {
  nodeUrl: string;
  name: string;
  path: string;
  options?: RequestOptions;
}): Promise<T> {
  const base = trimUrl(args.nodeUrl);
  const headers = await getAuthHeader({ nodeUrl: args.nodeUrl, name: args.name });

  try {
    return await request<T>(`${base}${args.path}`, {
      ...args.options,
      headers: { ...(args.options?.headers ?? {}), ...headers },
    });
  } catch (err) {
    if ((err as { status?: number }).status === 401) {
      const fresh = await signIn({ nodeUrl: args.nodeUrl, name: args.name });
      return await request<T>(`${base}${args.path}`, {
        ...args.options,
        headers: {
          ...(args.options?.headers ?? {}),
          Authorization: `Bearer ${fresh.token}`,
        },
      });
    }
    throw err;
  }
}
