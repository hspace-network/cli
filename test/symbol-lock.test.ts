import { describe, it, expect } from "vitest";
import { withSymbolLock } from "../src/services/discussion.client.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("withSymbolLock", () => {
  it("serializes critical sections for the same symbol", async () => {
    // If the mutex leaks, both sections run concurrently and the log interleaves
    // as A1,B1,... . Correct serialization yields A fully before B: A1,A2,B1,B2.
    const log: string[] = [];
    const section = (tag: string) =>
      withSymbolLock("BTCUSDT", async () => {
        log.push(`${tag}1`);
        await sleep(20);
        log.push(`${tag}2`);
      });

    await Promise.all([section("A"), section("B")]);

    // Each section is contiguous (its two marks are adjacent), in FIFO order.
    expect(log).toEqual(["A1", "A2", "B1", "B2"]);
  });

  it("runs different symbols concurrently", async () => {
    const order: string[] = [];
    const a = withSymbolLock("BTCUSDT", async () => {
      await sleep(30);
      order.push("A");
    });
    const b = withSymbolLock("ETHUSDT", async () => {
      await sleep(5);
      order.push("B");
    });
    await Promise.all([a, b]);
    // Different symbols do not block each other, so the shorter one finishes first.
    expect(order).toEqual(["B", "A"]);
  });

  it("releases the lock even when fn throws", async () => {
    await expect(
      withSymbolLock("SOLUSDT", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    // A later section on the same symbol must still acquire the lock.
    const ran = await withSymbolLock("SOLUSDT", async () => "ok");
    expect(ran).toBe("ok");
  });
});
