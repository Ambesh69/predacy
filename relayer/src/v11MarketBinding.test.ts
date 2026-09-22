import { describe, expect, it } from "vitest";
import { assertV11MarketBinding } from "./v11MarketBinding.js";

const binding = {
  yesTokenId: 123n, noTokenId: 456n, tokenId: 456n, priceTick: 10_000n,
  exchange: "0xE111180000d2663C0091e4f400237545B87B996B" as const,
};
const market = { feeInfo: { rate: 0.07, exponent: 1 }, negRisk: false, tickSize: 0.01,
  tokens: [{ tokenId: "123", outcome: "Yes" }, { tokenId: "456", outcome: "No" }] };

describe("v11 market binding", () => {
  it("accepts the exact CLOB token pair, tick, and exchange", () => {
    expect(() => assertV11MarketBinding(market, binding)).not.toThrow();
  });

  it("rejects stale token IDs before funds are routed", () => {
    expect(() => assertV11MarketBinding({ ...market, tokens: [{ tokenId: "123", outcome: "Yes" },
      { tokenId: "789", outcome: "No" }] },
      binding)).toThrow(/tokens differ/);
  });

  it("rejects a reversed YES/NO token pair", () => {
    expect(() => assertV11MarketBinding({ ...market, tokens: [{ tokenId: "123", outcome: "No" },
      { tokenId: "456", outcome: "Yes" }] }, binding)).toThrow(/reversed/);
  });

  it("rejects changed price ticks", () => {
    expect(() => assertV11MarketBinding({ ...market, tickSize: 0.001 }, binding)).toThrow(/tick differs/);
  });

  it("rejects a negative-risk exchange mismatch", () => {
    expect(() => assertV11MarketBinding({ ...market, negRisk: true }, binding)).toThrow(/exchange differs/);
  });

  it("rejects a fee schedule beyond the signed envelope", () => {
    expect(() => assertV11MarketBinding({ ...market, feeInfo: { rate: 0.08, exponent: 1 } },
      binding)).toThrow(/fee exceeds/);
  });
});
