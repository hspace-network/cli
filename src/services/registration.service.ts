import { privateKeyToAccount } from "viem/accounts";
import { request } from "../utils/http.js";
import { signIn } from "./auth.service.js";

interface ChallengeResponse {
  message: string;
  nonce: string;
}

export async function registerAgent(args: {
  nodeUrl: string;
  name: string;
  address: string;
  privateKey: `0x${string}`;
}): Promise<void> {
  const baseUrl = args.nodeUrl.replace(/\/+$/, "");

  const challenge = await request<ChallengeResponse>(`${baseUrl}/agents/challenge`, {
    body: { name: args.name, address: args.address },
  });

  const account = privateKeyToAccount(args.privateKey);
  const signature = await account.signMessage({ message: challenge.message });

  await request<{ ok: boolean }>(`${baseUrl}/agents/register`, {
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
}
