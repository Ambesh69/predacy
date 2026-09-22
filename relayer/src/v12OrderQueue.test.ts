import { describe, expect, it, vi } from "vitest";
import { keccak256, type Hex } from "viem";

vi.mock("pg", async () => {
  const { newDb } = await import("pg-mem");
  return { Pool: newDb().adapters.createPg().Pool };
});

import { parseV12QueuedBuyOrder, PostgresV12OrderQueue, type V12QueuedBuyOrder } from "./v12OrderQueue.js";

const hex = (byte: string) => `0x${byte.repeat(64)}` as Hex;
const key = hex("f");

function order(input: string, salt: string): V12QueuedBuyOrder {
  return {
    marketId: hex("b"),
    positionTokenId: 123n,
    priceTick: 10_000n,
    depositWallet: "0x00000000000000000000000000000000000000aa",
    collateralAsset: hex("1"),
    positionAsset: hex("2"),
    receiptTokenHash: keccak256(hex("e")),
    order: {
      inputNote: hex(input), deposit: 600_000n, limitPrice: 550_000n, salt: hex(salt),
      refundPublicKey: hex("5"), positionPublicKey: hex("6"),
    },
  };
}

describe("v12 encrypted order queue", () => {
  it("parses only canonical string-encoded private orders", () => {
    const encoded = JSON.parse(JSON.stringify(order("3", "4"), (_key, value) =>
      typeof value === "bigint" ? value.toString() : value));
    expect(parseV12QueuedBuyOrder(encoded)).toEqual({
      ...order("3", "4"), depositWallet: "0x00000000000000000000000000000000000000AA",
    });
    encoded.order.deposit = 600_000;
    expect(() => parseV12QueuedBuyOrder(encoded)).toThrow(/decimal string/);
  });

  it("waits for two compatible orders, persists one batch, and separates outcomes", async () => {
    const queue = await PostgresV12OrderQueue.connect("memory://v12-order-queue", key);
    try {
      const first = await queue.enqueue(order("3", "4"));
      expect(await queue.assemble(first.groupKey)).toBeNull();
      const second = await queue.enqueue(order("7", "8"));
      expect(second.groupKey).toBe(first.groupKey);
      const batch = await queue.assemble(first.groupKey);
      expect(batch?.request.witness.orders).toHaveLength(2);
      expect(batch?.request.witness.orders[0].inputNote).toBe(hex("3"));
      expect(await queue.assemble(first.groupKey)).toBeNull();

      const third = order("9", "a");
      third.positionTokenId = 456n;
      const thirdQueued = await queue.enqueue(third);
      const other = order("c", "d");
      other.positionTokenId = 456n;
      const fourthQueued = await queue.enqueue(other);
      expect(thirdQueued.groupKey).not.toBe(first.groupKey);
      expect(fourthQueued.groupKey).toBe(thirdQueued.groupKey);
      const otherBatch = await queue.assemble(thirdQueued.groupKey);
      expect(otherBatch?.request.positionTokenId).toBe(456n);
      expect(otherBatch?.request.witness.orders).toHaveLength(2);
      await queue.recordReceipts(otherBatch!.batchId, otherBatch!.request, [
        { spent: 500_000n, shares: 900_000n }, { spent: 300_000n, shares: 500_000n },
      ]);
      await expect(queue.getReceipt(thirdQueued.commitment, hex("0"))).rejects.toThrow(/receipt token/);
      expect(await queue.getReceipt(thirdQueued.commitment, hex("e"))).toEqual({
        spent: 500_000n, shares: 900_000n, refund: 100_000n,
      });
    } finally {
      await queue.close();
    }
  });
});
