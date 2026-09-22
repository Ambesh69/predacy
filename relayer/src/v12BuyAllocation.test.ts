import { describe, expect, it } from "vitest";
import type { V12PrivateBuyOrder } from "./v12BuyBatchProver.js";
import { aggregateV12BuyLimit, allocateV12BuyFill } from "./v12BuyAllocation.js";

const hex = (byte: string) => `0x${byte.repeat(64)}` as const;
const order = (deposit: bigint, limitPrice: bigint, byte: string): V12PrivateBuyOrder => ({
  inputNote: hex(byte), deposit, limitPrice, salt: hex("4"),
  refundPublicKey: hex("5"), positionPublicKey: hex("6"),
});

describe("v12 aggregate buy allocation", () => {
  it("allocates spend and shares proportionally with exact conservation", () => {
    const orders = [order(600_000n, 600_000n, "1"), order(400_000n, 550_000n, "2")];
    const fills = allocateV12BuyFill(orders, 550_000n, 1_000_000n);
    expect(fills).toEqual([
      { spent: 330_000n, shares: 600_000n },
      { spent: 220_000n, shares: 400_000n },
    ]);
    expect(fills.reduce((sum, fill) => sum + fill.spent, 0n)).toBe(550_000n);
    expect(fills.reduce((sum, fill) => sum + fill.shares, 0n)).toBe(1_000_000n);
    expect(aggregateV12BuyLimit(orders)).toBe(550_000n);
  });

  it("moves rounding shares between orders to preserve hidden limits", () => {
    const orders = [order(1n, 500_000n, "1"), order(2n, 900_000n, "2")];
    const fills = allocateV12BuyFill(orders, 3n, 5n);
    expect(fills.reduce((sum, fill) => sum + fill.spent, 0n)).toBe(3n);
    expect(fills.reduce((sum, fill) => sum + fill.shares, 0n)).toBe(5n);
    expect(fills[0].shares).toBeGreaterThanOrEqual(2n);
  });

  it("returns exact zero fills after rejection", () => {
    expect(allocateV12BuyFill([order(10n, 600_000n, "1")], 0n, 0n))
      .toEqual([{ spent: 0n, shares: 0n }]);
  });

  it("rejects an aggregate execution that cannot satisfy hidden limits", () => {
    expect(() => allocateV12BuyFill([
      order(1n, 500_000n, "1"), order(1n, 500_000n, "2"),
    ], 2n, 3n)).toThrow(/cannot satisfy/);
  });
});
