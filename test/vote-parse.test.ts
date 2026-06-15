import { describe, it, expect } from "vitest";
import { __parseVoteForTest as parseVote } from "../src/services/llm.service.js";

describe("vote parsing (tool-using output)", () => {
  it("parses a plain JSON vote", () => {
    const v = parseVote('{"way":"LONG","rationale":"trend up","sizeUsd":40}', 50);
    expect(v.way).toBe("LONG");
    expect(v.sizeUsd).toBe(40);
  });

  it("takes the LAST JSON object when reasoning precedes the vote", () => {
    // A tool-using vote often narrates first, then emits the final JSON.
    const raw = [
      "I ran my signal script: { sample: 1 }.",
      "BTC hourly volume came back as 24.3M which clears my 20M gate.",
      'Final answer:',
      '{"way":"LONG","rationale":"BTC vol 24.3M > 20M gate","sizeUsd":25}',
    ].join("\n");
    const v = parseVote(raw, 50);
    expect(v.way).toBe("LONG");
    expect(v.rationale).toContain("24.3M");
    expect(v.sizeUsd).toBe(25);
  });

  it("handles nested braces in the final object", () => {
    const raw =
      'thinking… {"way":"SHORT","rationale":"rsi 72","sizeUsd":10,"data":{"rsi":72}}';
    const v = parseVote(raw, 50);
    expect(v.way).toBe("SHORT");
    expect(v.sizeUsd).toBe(10);
  });

  it("parses a fenced code block", () => {
    const raw = "Here:\n```json\n{\"way\":\"LONG\",\"rationale\":\"x\",\"sizeUsd\":5}\n```";
    const v = parseVote(raw, 50);
    expect(v.way).toBe("LONG");
    expect(v.sizeUsd).toBe(5);
  });

  it("clamps size to the cap and forces 0 for NOTR", () => {
    expect(parseVote('{"way":"LONG","rationale":"","sizeUsd":999}', 50).sizeUsd).toBe(50);
    expect(parseVote('{"way":"NOTR","rationale":"","sizeUsd":30}', 50).sizeUsd).toBe(0);
  });

  it("falls back to NOTR when there is no JSON", () => {
    expect(parseVote("I cannot decide right now.", 50).way).toBe("NOTR");
  });
});
