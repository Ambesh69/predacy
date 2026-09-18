import { describe, expect, it } from "vitest";
import { validateSettlementAccounting, type SettlementAccounting } from "./settlementAccounting.js";

const zeroExternal = {
  usdcSpent: 0n, usdcReceived: 0n,
  yesBought: 0n, yesSold: 0n,
  noBought: 0n, noSold: 0n,
};

describe("zero-subsidy settlement accounting", () => {
  it("conserves an internal buyer/seller match", () => {
    const batch: SettlementAccounting = {
      orders: [
        { side: "YES_BUY", deposit: 600_000n, limitPrice: 700_000n, filledShares: 1_000_000n, usdcPayout: 600_000n, refund: 0n },
        { side: "YES_SELL", deposit: 1_000_000n, limitPrice: 500_000n, filledShares: 1_000_000n, usdcPayout: 600_000n, refund: 0n },
      ],
      splitShares: 0n,
      mergedShares: 0n,
      external: zeroExternal,
    };
    expect(validateSettlementAccounting(batch)).toEqual({ usdc: 600_000n, yes: 1_000_000n, no: 0n });
  });

  it("accounts for a CLOB buy with fees inside the buyer's limit", () => {
    const batch: SettlementAccounting = {
      orders: [
        { side: "NO_BUY", deposit: 410_000n, limitPrice: 420_000n, filledShares: 1_000_000n, usdcPayout: 405_000n, refund: 5_000n },
      ],
      splitShares: 0n,
      mergedShares: 0n,
      external: { ...zeroExternal, usdcSpent: 405_000n, noBought: 1_000_000n },
    };
    expect(validateSettlementAccounting(batch)).toEqual({ usdc: 5_000n, yes: 0n, no: 1_000_000n });
  });

  it("accounts for a CLOB sell at actual net proceeds", () => {
    const batch: SettlementAccounting = {
      orders: [
        { side: "YES_SELL", deposit: 1_000_000n, limitPrice: 550_000n, filledShares: 1_000_000n, usdcPayout: 570_000n, refund: 0n },
      ],
      splitShares: 0n,
      mergedShares: 0n,
      external: { ...zeroExternal, yesSold: 1_000_000n, usdcReceived: 570_000n },
    };
    expect(validateSettlementAccounting(batch)).toEqual({ usdc: 570_000n, yes: 0n, no: 0n });
  });

  it("refunds an unfilled order without a subsidy", () => {
    const batch: SettlementAccounting = {
      orders: [
        { side: "NO_BUY", deposit: 400_000n, limitPrice: 400_000n, filledShares: 0n, usdcPayout: 0n, refund: 400_000n },
        { side: "NO_SELL", deposit: 1_000_000n, limitPrice: 500_000n, filledShares: 0n, usdcPayout: 0n, refund: 1_000_000n },
      ],
      splitShares: 0n,
      mergedShares: 0n,
      external: zeroExternal,
    };
    expect(validateSettlementAccounting(batch)).toEqual({ usdc: 400_000n, yes: 0n, no: 1_000_000n });
  });

  it("rejects a shortfall instead of silently spending relayer funds", () => {
    const batch: SettlementAccounting = {
      orders: [
        { side: "YES_BUY", deposit: 600_000n, limitPrice: 700_000n, filledShares: 1_000_000n, usdcPayout: 600_000n, refund: 0n },
      ],
      splitShares: 0n,
      mergedShares: 0n,
      external: { ...zeroExternal, usdcSpent: 610_000n, yesBought: 1_000_000n },
    };
    expect(() => validateSettlementAccounting(batch)).toThrow("batch has a usdc deficit");
  });

  it("rejects allocations outside the signed price limit", () => {
    const batch: SettlementAccounting = {
      orders: [
        { side: "NO_BUY", deposit: 450_000n, limitPrice: 400_000n, filledShares: 1_000_000n, usdcPayout: 450_000n, refund: 0n },
      ],
      splitShares: 0n,
      mergedShares: 0n,
      external: { ...zeroExternal, usdcSpent: 450_000n, noBought: 1_000_000n },
    };
    expect(() => validateSettlementAccounting(batch)).toThrow("buyer all-in execution price exceeds limit");
  });
});
