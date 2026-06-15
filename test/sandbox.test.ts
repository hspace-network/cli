import { describe, it, expect } from "vitest";
import {
  isAllowedPackage,
  PACKAGE_NAME_REGEX,
  PACKAGE_VERSION_REGEX,
  SCRIPT_NAME_REGEX,
  PACKAGE_ALLOWLIST,
} from "../src/services/sandbox.constants.js";
import {
  buildSandboxTools,
  toOpenAITools,
  toAnthropicTools,
  dispatchTool,
  type ToolSpec,
} from "../src/services/tools.service.js";
import {
  intervalToMs,
  formatSignalsBlock,
  isActionableSignal,
} from "../src/services/signals.service.js";

describe("sandbox allowlist", () => {
  it("accepts only allowlisted packages", () => {
    expect(isAllowedPackage("ccxt")).toBe(true);
    expect(isAllowedPackage("technicalindicators")).toBe(true);
    expect(isAllowedPackage("left-pad")).toBe(false);
    expect(isAllowedPackage("../evil")).toBe(false);
  });

  it("validates package names and versions strictly", () => {
    expect(PACKAGE_NAME_REGEX.test("technicalindicators")).toBe(true);
    expect(PACKAGE_NAME_REGEX.test("@scope/pkg")).toBe(true);
    expect(PACKAGE_NAME_REGEX.test("pkg; rm -rf /")).toBe(false);
    expect(PACKAGE_VERSION_REGEX.test("^4.4.0")).toBe(true);
    expect(PACKAGE_VERSION_REGEX.test("4.4.0 && echo")).toBe(false);
  });

  it("rejects unsafe script names", () => {
    expect(SCRIPT_NAME_REGEX.test("signal")).toBe(true);
    expect(SCRIPT_NAME_REGEX.test("rsi-14")).toBe(true);
    expect(SCRIPT_NAME_REGEX.test("../escape")).toBe(false);
    expect(SCRIPT_NAME_REGEX.test("a/b")).toBe(false);
  });
});

describe("sandbox tools", () => {
  const tools = buildSandboxTools({ agent: "alpha", market: "SOLUSDT", interval: "1h" });

  it("exposes the expected tool set", () => {
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "delete_script",
        "install_package",
        "list_packages",
        "list_scripts",
        "read_script",
        "run_code",
        "run_script",
        "save_script",
        "set_signal",
      ].sort(),
    );
  });

  it("documents allowlisted packages in install_package", () => {
    const install = tools.find((t) => t.name === "install_package")!;
    for (const pkg of PACKAGE_ALLOWLIST) {
      expect(install.description).toContain(pkg);
    }
  });

  it("captures structured signals via set_signal", async () => {
    let captured: unknown = null;
    const withSignal = buildSandboxTools({
      agent: "alpha",
      onSignal: (s) => (captured = s),
    });
    const setSignal = withSignal.find((t) => t.name === "set_signal")!;
    await setSignal.handler({ bias: "long", confidence: 1.4, notes: "strong" });
    expect(captured).toEqual({
      bias: "LONG",
      confidence: 1, // clamped to [0,1]
      notes: "strong",
      data: undefined,
    });
  });

  it("coerces unknown bias to NOTR", async () => {
    let captured: any = null;
    const t = buildSandboxTools({ agent: "alpha", onSignal: (s) => (captured = s) });
    await t.find((x) => x.name === "set_signal")!.handler({ bias: "maybe", confidence: 0.3 });
    expect(captured.bias).toBe("NOTR");
  });

  it("adapts specs to OpenAI and Anthropic shapes", () => {
    const oai = toOpenAITools(tools);
    expect(oai[0]).toMatchObject({ type: "function", function: { name: expect.any(String) } });
    const ant = toAnthropicTools(tools);
    expect(ant[0]).toHaveProperty("input_schema");
    expect(ant[0]).toHaveProperty("name");
  });

  it("returns a friendly error for unknown tools", async () => {
    const specs: ToolSpec[] = [];
    const res = (await dispatchTool(specs, "nope", {})) as { ok: boolean; error: string };
    expect(res.ok).toBe(false);
    expect(res.error).toContain("nope");
  });
});

describe("signals", () => {
  it("parses room intervals to milliseconds", () => {
    expect(intervalToMs("BTCUSDT:1m")).toBe(60_000);
    expect(intervalToMs("BTCUSDT:5m")).toBe(300_000);
    expect(intervalToMs("BTCUSDT:1h")).toBe(3_600_000);
    expect(intervalToMs("4h")).toBe(14_400_000);
    expect(intervalToMs("garbage")).toBe(3_600_000); // 1h default
  });

  it("formats a compact signal block", () => {
    const block = formatSignalsBlock({ bias: "LONG", confidence: 0.72, notes: "RSI rising" });
    expect(block).toContain("bias=LONG");
    expect(block).toContain("confidence=72%");
    expect(block).toContain("RSI rising");
  });

  it("only treats confident, directional signals as actionable", () => {
    // The fix for an always-LONG agent being flipped to NOTR by weak research:
    expect(isActionableSignal({ bias: "NOTR", confidence: 0.9 })).toBe(false);
    expect(isActionableSignal({ bias: "LONG", confidence: 0.3 })).toBe(false);
    expect(isActionableSignal({ bias: "LONG", confidence: 0.5 })).toBe(true);
    expect(isActionableSignal({ bias: "SHORT", confidence: 0.8 })).toBe(true);
  });
});
