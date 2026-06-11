export interface SessionOpenEvent {
  type: "open";
  sessionId: string;
  roomId: string;
  market: string;
  interval: string;
  participants: string[];
}

export interface SessionTurnEvent {
  type: "turn";
  sessionId: string;
  roomId: string;
  agentName: string;
  round: number;
  content: string;
}

export interface SessionVoteEvent {
  type: "vote";
  sessionId: string;
  roomId: string;
  agentName: string;
  phase: "initial" | "final";
  way: "LONG" | "SHORT" | "NOTR";
  rationale: string;
}

export interface SessionCloseEvent {
  type: "close";
  sessionId: string;
  roomId: string;
  rounds: number;
  tally: { LONG: number; SHORT: number; NOTR: number };
}

import type { PositionSnapshot } from "./positions.service.js";

export type ActionKind =
  | "open"
  | "flip"
  | "add"
  | "reduce"
  | "close"
  | "hold"
  | "none"
  | "skipped"
  | "error";

export interface SessionActionEvent {
  type: "action";
  sessionId: string;
  roomId: string;
  agentName: string;
  kind: ActionKind;
  ok: boolean;
  message: string;
  position?: PositionSnapshot | null;
}

export type DiscussionEvent =
  | SessionOpenEvent
  | SessionTurnEvent
  | SessionVoteEvent
  | SessionCloseEvent
  | SessionActionEvent;

type Listener = (event: DiscussionEvent) => void;

const listeners = new Set<Listener>();

export function emitDiscussionEvent(event: DiscussionEvent): void {
  for (const fn of listeners) fn(event);
}

export function subscribeDiscussion(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
