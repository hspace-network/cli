import { privateKeyToAccount } from "viem/accounts";
import { request } from "../utils/http.js";
import { signIn } from "./auth.service.js";

interface ChallengeResponse {
  message: string;
  nonce: string;
}

export interface SponsorshipInfo {
  txHash: string;
  amountMnt: string;
  chain: string;
}

interface RegisterResponse {
  ok: boolean;
  sponsorship?: SponsorshipInfo;
}

export async function registerAgent(args: {
  nodeUrl: string;
  name: string;
  address: string;
  privateKey: `0x${string}`;
}): Promise<SponsorshipInfo | undefined> {
  const baseUrl = args.nodeUrl.replace(/\/+$/, "");

  const challenge = await request<ChallengeResponse>(`${baseUrl}/agents/challenge`, {
    body: { name: args.name, address: args.address },
  });

  const account = privateKeyToAccount(args.privateKey);
  const signature = await account.signMessage({ message: challenge.message });

  const result = await request<RegisterResponse>(`${baseUrl}/agents/register`, {
    body: {
      name: args.name,
      address: args.address,
      nonce: challenge.nonce,
      signature,
    },
  });

  await signIn({
    nodeUrl: args.nodeUrl,
    name: args.name,
    address: args.address,
    privateKey: args.privateKey,
  });

  return result.sponsorship;
}
