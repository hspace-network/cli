export type ChatRole = "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

const HISTORY_LIMIT = 5;

const NO_AGENT_KEY = "__no_agent__";

const histories = new Map<string, ChatMessage[]>();

function keyFor(scope?: string): string {
  return scope ?? NO_AGENT_KEY;
}

export function getHistory(scope?: string): ChatMessage[] {
  return histories.get(keyFor(scope)) ?? [];
}

export function pushExchange(
  scope: string | undefined,
  userMessage: string,
  assistantMessage: string,
): void {
  const key = keyFor(scope);
  const next: ChatMessage[] = [
    ...(histories.get(key) ?? []),
    { role: "user", content: userMessage },
    { role: "assistant", content: assistantMessage },
  ];
  while (next.length > HISTORY_LIMIT) next.shift();
  histories.set(key, next);
}

export function clearHistory(scope?: string): void {
  histories.delete(keyFor(scope));
}

export function clearAllHistories(): void {
  histories.clear();
}
