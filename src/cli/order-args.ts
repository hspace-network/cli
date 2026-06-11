export interface ParsedOrderArgs {
  size: number;
  limitPx?: number;
  sl?: number;
  tp?: number;
}

function parsePositiveNumber(label: string, value: string): number {
  if (!value) {
    throw new Error(`${label} is required.`);
  }
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${label} must be a positive number (got "${value}").`);
  }
  return n;
}

/**
 * Parse the tail of a long/short command: <size> [@price] [sl=price] [tp=price].
 * Order does not matter for the flags after size. Bare positional after size is rejected.
 */
export function parseOrderArgs(parts: string[]): ParsedOrderArgs {
  if (parts.length === 0) {
    throw new Error("Size is required.");
  }
  const sizeRaw = parts[0]!;
  const size = parsePositiveNumber("size", sizeRaw);

  const out: ParsedOrderArgs = { size };

  for (let i = 1; i < parts.length; i++) {
    const token = parts[i]!.trim();
    if (!token) continue;

    if (token.startsWith("@")) {
      out.limitPx = parsePositiveNumber("limit price", token.slice(1));
      continue;
    }

    const eq = token.indexOf("=");
    if (eq === -1) {
      throw new Error(`Unexpected argument "${token}". Expected @price, sl=, or tp=.`);
    }

    const key = token.slice(0, eq).toLowerCase();
    const val = token.slice(eq + 1);

    if (key === "sl") {
      out.sl = parsePositiveNumber("sl", val);
    } else if (key === "tp") {
      out.tp = parsePositiveNumber("tp", val);
    } else {
      throw new Error(`Unknown flag "${key}". Allowed: @price, sl=, tp=.`);
    }
  }

  return out;
}
