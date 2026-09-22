import { describe, expect, it } from "vitest";
import { parseV11OrderManifest } from "./v11OrderManifest.js";

const manifest = {
  batchId: "12", marketId: `0x${"11".repeat(32)}`, commitment: `0x${"22".repeat(32)}`,
  side: "NO_BUY", deposit: "500000", limitPrice: "600000", salt: `0x${"33".repeat(32)}`,
  tokenId: "123", priceTick: "10000", depositWallet: "0x00000000000000000000000000000000000000aa",
};

describe("v11 operator manifest", () => {
  it("parses exact string-encoded base units", () => {
    expect(parseV11OrderManifest(JSON.stringify(manifest), "12")).toMatchObject({
      batchId: "12", side: "NO_BUY", deposit: 500_000n, tokenId: 123n,
    });
  });

  it("rejects a different batch before any action", () => {
    expect(() => parseV11OrderManifest(JSON.stringify(manifest), "13")).toThrow(/differs/);
  });

  it("rejects floating-point or non-string amounts", () => {
    expect(() => parseV11OrderManifest(JSON.stringify({ ...manifest, deposit: 0.5 }), "12"))
      .toThrow(/deposit/);
  });
});
