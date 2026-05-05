type Listener = () => void;

const roomsByAgent = new Map<string, Set<string>>();
const listeners = new Set<Listener>();

function notify(): void {
  for (const fn of listeners) fn();
}

export function setAgentRooms(name: string, rooms: string[]): void {
  roomsByAgent.set(name, new Set(rooms));
  notify();
}

export function addAgentRoom(name: string, roomId: string): void {
  const set = roomsByAgent.get(name) ?? new Set<string>();
  set.add(roomId);
  roomsByAgent.set(name, set);
  notify();
}

export function removeAgentRoom(name: string, roomId: string): void {
  const set = roomsByAgent.get(name);
  if (!set) return;
  set.delete(roomId);
  if (set.size === 0) {
    roomsByAgent.delete(name);
  }
  notify();
}

export function clearAgent(name: string): void {
  roomsByAgent.delete(name);
  notify();
}

export function getAgentRooms(name: string): string[] {
  const set = roomsByAgent.get(name);
  return set ? [...set].sort() : [];
}

export function isRunning(name: string): boolean {
  const set = roomsByAgent.get(name);
  return !!set && set.size > 0;
}

export function getAllRooms(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [name, set] of roomsByAgent) {
    out.set(name, [...set].sort());
  }
  return out;
}

export function subscribeRunsCache(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
