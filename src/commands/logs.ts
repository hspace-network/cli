import type { InteractiveResult } from "./index.js";

export async function logsCommand(): Promise<InteractiveResult> {
  return { lines: [], openLogs: true };
}
