import type { VoteWay } from "./llm.service.js";

export interface ClampedVote {
  way: VoteWay;
  sizeUsd: number;
  clamped: boolean;
  reason?: "cap_zero" | "cap_exceeded";
}

/** Match server-side clamp in node/src/services/vote-clamp.ts */
export function clampVote(
  way: VoteWay,
  sizeUsd: number,
  spendingCapUsd: number,
): ClampedVote {
  const cap =
    Number.isFinite(spendingCapUsd) && spendingCapUsd > 0 ? spendingCapUsd : 0;

  if (way !== "NOTR" && cap === 0) {
    return { way: "NOTR", sizeUsd: 0, clamped: true, reason: "cap_zero" };
  }

  if (sizeUsd > cap) {
    return { way, sizeUsd: cap, clamped: true, reason: "cap_exceeded" };
  }

  return { way, sizeUsd: Math.max(0, sizeUsd), clamped: false };
}
