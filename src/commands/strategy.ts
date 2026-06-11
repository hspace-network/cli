import type { InteractiveResult } from "./index.js";

export async function strategyCommand(): Promise<InteractiveResult> {
  return {
    lines: [],
    openStrategyScreen: true,
  };
}
