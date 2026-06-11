import { executeOpen } from "./_trade.js";

export async function shortCommand(args: string[]): Promise<string[]> {
  return executeOpen("short", args);
}
