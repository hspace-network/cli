type Listener = () => void;

let active: string | null = null;
const listeners = new Set<Listener>();

function notify(): void {
  for (const fn of listeners) fn();
}

export function getActiveAgent(): string | null {
  return active;
}

export function setActiveAgent(name: string | null): void {
  if (active === name) return;
  active = name;
  notify();
}

export function clearActiveAgent(): void {
  setActiveAgent(null);
}

export function subscribeActiveAgent(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
