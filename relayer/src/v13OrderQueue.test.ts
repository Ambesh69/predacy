import { describe, expect, it, vi } from "vitest";
import { keccak256, type Hex } from "viem";
vi.mock("pg", async () => {
  const { newDb } = await import("pg-mem");
  // pg-mem leaves CREATE IF NOT EXISTS unvisited on reconnect; real restarts run in the production rehearsal.
  return { Pool: newDb({ noAstCoverageCheck: true }).adapters.createPg().Pool };
});
import { PostgresV13OrderQueue, type V13QueuedOrder } from "./v13OrderQueue.js";
import { PostgresV13WitnessVault } from "./v13BatchJournal.js";
import { V13MerkleTree } from "./v13MerkleTree.js";
import { v13OrderCommitment } from "./v13Proofs.js";

const word = (byte: string) => `0x${byte.repeat(64)}` as Hex;

it("persists an encrypted batch with exactly two queue rows and authenticates its receipts", async () => {
  const tree = new V13MerkleTree();
  const make = (secret: string, index: number): V13QueuedOrder => ({
    marketId: word("9"), positionTokenId: 99n, priceTick: 10_000n,
    depositWallet: "0x0000000000000000000000000000000000000011",
    collateralAsset: word("1"), positionAsset: word("2"), receiptTokenHash: keccak256(word("a")),
    orderLeafIndex: index, order: { deposit: 500_000n, limitPrice: 600_000n,
      refundPublicKey: word("3"), positionPublicKey: word("4"), orderSecret: word(secret) },
  });
  const orders = [make("5", 0), make("6", 1), make("7", 2)];
  orders.forEach((order, index) => tree.append(index, v13OrderCommitment({ ...order.order, positionAsset: order.positionAsset })));
  const queue = await PostgresV13OrderQueue.connect("memory://v13-queue", word("f"),
    async (leaves) => leaves.map((leaf) => tree.witness(leaf.index, leaf.commitment)), { executionEpochMs: 0 });
  const vault = await PostgresV13WitnessVault.connect("memory://v13-queue", word("f"));
  try {
    const first = await queue.enqueue(orders[0]);
    expect(await queue.assemble(first.groupKey)).toBeNull();
    const second = await queue.enqueue(orders[1]);
    const batch = await queue.assemble(first.groupKey);
    expect(batch).not.toBeNull();
    expect(await vault.get(batch!.batchId)).toEqual(batch!.request);
    await queue.enqueue(orders[2]);
    expect(await queue.assemble(first.groupKey)).toBeNull();
    expect(await queue.pendingBatchIds()).toEqual([batch!.batchId]);
    await queue.recordReceipts(batch!.batchId, batch!.request,
      [{ spent: 250_000n, shares: 500_000n }, { spent: 250_000n, shares: 500_000n }]);
    expect(await queue.getReceipt(second.commitment, word("a"))).toEqual({ spent: 250_000n,
      shares: 500_000n, refund: 250_000n });
    await expect(queue.getReceipt(first.commitment, word("b"))).rejects.toThrow("receipt token");
    expect(await queue.pendingBatchIds()).toEqual([]);
  } finally { await Promise.all([queue.close(), vault.close()]); }
});
