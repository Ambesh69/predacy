import { describe, expect, it } from "vitest";
import { zeroHash } from "viem";
import { buildV12BuyBatchInputs, proveV12BuyBatch, type V12BuyBatchWitness } from "./v12BuyBatchProver.js";

const hex = (byte: string) => `0x${byte.repeat(64)}` as const;
const base: V12BuyBatchWitness = {
  collateralAsset: hex("1"),
  positionAsset: hex("2"),
  orders: [{
    inputNote: hex("3"), deposit: 600_000n, limitPrice: 600_000n, salt: hex("4"),
    refundPublicKey: hex("5"), positionPublicKey: hex("6"),
  }],
  fills: [{ spent: 550_000n, shares: 1_000_000n }],
};

describe("v12 private buy batch witness", () => {
  it("builds the exact padded 20-input contract layout", () => {
    const built = buildV12BuyBatchInputs(base);
    expect(built.publicInputs).toHaveLength(20);
    expect(built.totalDeposit).toBe(600_000n);
    expect(built.totalSpent).toBe(550_000n);
    expect(built.totalShares).toBe(1_000_000n);
    expect(built.orderCommitments[1]).toBe(zeroHash);
    expect(built.refundCommitments[1]).toBe(zeroHash);
    expect(built.positionCommitments[1]).toBe(zeroHash);
    expect(built.publicInputs[0]).toBe(`0x${"0".repeat(63)}1`);
  });

  it("builds a zero-fill route proof with a full private refund", () => {
    const route = buildV12BuyBatchInputs({ ...base, fills: [{ spent: 0n, shares: 0n }] });
    expect(route.totalSpent).toBe(0n);
    expect(route.totalShares).toBe(0n);
    expect(route.positionCommitments[0]).toBe(zeroHash);
    expect(route.refundCommitments[0]).not.toBe(zeroHash);
  });

  it("rejects a fill above its hidden limit", () => {
    expect(() => buildV12BuyBatchInputs({
      ...base,
      orders: [{ ...base.orders[0], limitPrice: 500_000n }],
      fills: [{ spent: 550_001n, shares: 1_000_000n }],
    })).toThrow(/Invalid V12/);
  });

  it.skipIf(process.env.RUN_V12_NATIVE_PROOF !== "1")("generates the EVM proof and checks its public inputs", async () => {
    const result = await proveV12BuyBatch(base);
    expect(result.publicInputs).toHaveLength(20);
    expect(result.proof.length).toBeGreaterThan(1000);
  });
});
