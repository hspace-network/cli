type Listener = (msg: string | null) => void;

let listener: Listener | null = null;

export function setBusyListener(l: Listener | null): void {
  listener = l;
}

export function setBusy(msg: string | null): void {
  listener?.(msg);
}
