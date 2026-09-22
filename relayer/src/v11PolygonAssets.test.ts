import { describe, expect, it } from "vitest";
import { assertV11PolygonAssets } from "./v11PolygonAssets.js";

const assets = {
  usdce: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
  pusd: "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB",
  ctf: "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045",
  onramp: "0x93070a847efEf7F70739046A929D47a521F5B8ee",
  offramp: "0x2957922Eb93258b93368531d39fAcCA3B4dC5854",
} as const;

describe("v11 Polygon asset identity", () => {
  it("accepts the supported USDC.e, pUSD, CTF, and bridge contracts", () => {
    expect(() => assertV11PolygonAssets(assets)).not.toThrow();
  });

  it("refuses an incompatible collateral onramp", () => {
    expect(() => assertV11PolygonAssets({ ...assets, onramp: assets.offramp }))
      .toThrow(/onramp differs/);
  });
});
