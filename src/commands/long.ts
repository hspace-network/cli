import { executeOpen } from "./_trade.js";

export async function longCommand(args: string[]): Promise<string[]> {
  return executeOpen("long", args);
}
