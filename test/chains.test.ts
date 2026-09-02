import { describe, it, expect } from "vitest";
import {
  validateChainNetworkPair,
  getEffectiveChain,
  ALL_CHAINS,
  CHAIN_NETWORK,
} from "../src/services/config.service.js";
import {
  chainProfile,
  resolveWalletDepositAsset,
  walletDepositAssets,
} from "../src/services/deposit-assets.js";

describe("validateChainNetworkPair", () => {
  it("accepts each chain with its own network", () => {
    expect(validateChainNetworkPair("mantle", "mainnet")).toBeNull();
    expect(validateChainNetworkPair("base", "mainnet")).toBeNull();
    expect(validateChainNetworkPair("mantle-sepolia", "testnet")).toBeNull();
    expect(validateChainNetworkPair("base-sepolia", "testnet")).toBeNull();
  });
  it("rejects mismatched chain/network", () => {
    expect(validateChainNetworkPair("base", "testnet")).toMatch(/mainnet/);
    expect(validateChainNetworkPair("base-sepolia", "mainnet")).toMatch(/testnet/);
    expect(validateChainNetworkPair("mantle", "testnet")).toMatch(/mainnet/);
  });
  it("every chain has a network pairing", () => {
    for (const c of ALL_CHAINS) {
      expect(CHAIN_NETWORK[c]).toMatch(/^(mainnet|testnet)$/);
    }
  });
});

describe("getEffectiveChain", () => {
  it("returns the configured chain when valid, else the default", () => {
    expect(getEffectiveChain({ nodeUrl: "x", chain: "base" })).toBe("base");
    expect(getEffectiveChain({ nodeUrl: "x", chain: "base-sepolia" })).toBe("base-sepolia");
    // @ts-expect-error — junk chain falls back to the default
    expect(getEffectiveChain({ nodeUrl: "x", chain: "solana" })).toBe("base");
    expect(getEffectiveChain({ nodeUrl: "x" })).toBe("base");
  });
});

describe("chain profiles", () => {
  it("Base funds with USDC + ETH gas", () => {
    const p = chainProfile("base");
    expect(p.nativeCoin).toBe("ETH");
    expect(p.stableCoin).toBe("USDC");
    expect(p.stableToken).toBe("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
    expect(p.bybitChain).toBe("BASE");
  });
  it("Mantle keeps MNT + USDT", () => {
    const p = chainProfile("mantle");
    expect(p.nativeCoin).toBe("MNT");
    expect(p.railCoin).toBe("MNT");
    expect(p.bybitRail).toBe(true);
  });
  it("only Mantle enables the Bybit CEX rail (Base is wallet/Avantis only)", () => {
    expect(chainProfile("mantle").bybitRail).toBe(true);
    expect(chainProfile("base").bybitRail).toBe(false);
    expect(chainProfile("base-sepolia").bybitRail).toBe(false);
    expect(chainProfile("mantle-sepolia").bybitRail).toBe(false);
  });
  it("resolves the native coin by default and the stable coin by name", () => {
    const nativeOnBase = resolveWalletDepositAsset(undefined, "base");
    expect("error" in nativeOnBase ? "" : nativeOnBase.coin).toBe("ETH");
    const usdc = resolveWalletDepositAsset("USDC", "base");
    expect("error" in usdc ? "" : usdc.kind).toBe("erc20");
  });
  it("rejects a coin the chain does not fund", () => {
    const bad = resolveWalletDepositAsset("USDT", "base");
    expect("error" in bad).toBe(true);
  });
  it("lists exactly the gas + stable coins per chain", () => {
    expect(walletDepositAssets("base").map((a) => a.coin)).toEqual(["ETH", "USDC"]);
    expect(walletDepositAssets("mantle").map((a) => a.coin)).toEqual(["MNT", "USDT"]);
  });
});
