import { describe, it, expect } from "vitest";
import { clampLeverage, collateralForNotional } from "../src/services/venue.js";

describe("clampLeverage", () => {
  it("clamps into the pair bounds", () => {
    expect(clampLeverage(10, 1, 50)).toBe(10);
    expect(clampLeverage(100, 1, 50)).toBe(50);
    expect(clampLeverage(0.5, 1, 50)).toBe(1);
  });
  it("falls back to min for junk input", () => {
    expect(clampLeverage(NaN, 2, 50)).toBe(2);
    expect(clampLeverage(-5, 2, 50)).toBe(2);
  });
});

describe("collateralForNotional", () => {
  it("divides notional by leverage, rounded to cents", () => {
    expect(collateralForNotional(150, 3)).toBe(50);
    expect(collateralForNotional(100, 3)).toBe(33.33);
    expect(collateralForNotional(1000, 10)).toBe(100);
  });
});
