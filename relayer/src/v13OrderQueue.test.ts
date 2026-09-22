import { beforeEach, describe, expect, it, vi } from "vitest";
import { keccak256, toHex, type Hex } from "viem";
vi.mock("pg", async () => {
  const { newDb } = await import("pg-mem");
  // pg-mem leaves CREATE IF NOT EXISTS unvisited on reconnect; real restarts run in the production rehearsal.
  return { Pool: newDb({ noAstCoverageCheck: true }).adapters.createPg().Pool };
});
import { PostgresV13OrderQueue, type V13QueuedOrder } from "./v13OrderQueue.js";
import { PostgresV13WitnessVault } from "./v13BatchJournal.js";
import { V13MerkleTree } from "./v13MerkleTree.js";
import { v13Nullifier, v13OrderCommitment } from "./v13Proofs.js";
import { Pool } from "pg";

const word = (byte: string) => `0x${byte.repeat(64)}` as Hex;

beforeEach(async () => {
  const queue = await PostgresV13OrderQueue.connect("memory://v13-queue", word("f"), async () => []);
  const db = new Pool();
  try {
    await db.query("DELETE FROM v13_private_order_queue");
    await db.query("DELETE FROM v13_private_witnesses");
  } finally { await queue.close(); await db.end(); }
});

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
    async (leaves) => leaves.map((leaf) => ({ merkle: tree.witness(leaf.index, leaf.commitment), spent: false })),
    { executionEpochMs: 0 });
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

async function cancellationFixture(count = 3) {
  const tree = new V13MerkleTree();
  const spent = new Set<Hex>();
  const orders: V13QueuedOrder[] = Array.from({ length: count }, (_value, index) => ({
    marketId: word("9"), positionTokenId: 99n, priceTick: 10_000n,
    depositWallet: "0x0000000000000000000000000000000000000011",
    collateralAsset: word("1"), positionAsset: word("2"), receiptTokenHash: keccak256(word("a")),
    orderLeafIndex: index, order: { deposit: 500_000n, limitPrice: 600_000n,
      refundPublicKey: word("3"), positionPublicKey: word("4"), orderSecret: toHex(index + 1, { size: 32 }) },
  }));
  const commitments = orders.map((order) => v13OrderCommitment({ ...order.order, positionAsset: order.positionAsset }));
  const nullifiers = commitments.map((id, i) => v13Nullifier(id, orders[i].order.orderSecret, 6));
  commitments.forEach((id, i) => tree.append(i, id));
  const resolve = vi.fn(async (leaves: Array<{ index: number; commitment: Hex; nullifier: Hex }>) =>
    leaves.map((leaf) => ({ merkle: tree.witness(leaf.index, leaf.commitment), spent: spent.has(leaf.nullifier) })));
  const queue = await PostgresV13OrderQueue.connect("memory://v13-queue", word("f"), resolve, { executionEpochMs: 0 });
  const db = new Pool();
  return { queue, orders, commitments, nullifiers, resolve, spent, db,
    close: async () => { await queue.close(); await db.end(); } };
}

describe("v13 cancelled queue entries", () => {
  it("rejects an already cancelled or routed order before persisting its witness", async () => {
    const f = await cancellationFixture();
    try {
      f.spent.add(f.nullifiers[0]);
      await expect(f.queue.enqueue(f.orders[0])).rejects.toThrow("cancelled or routed");
      expect((await f.db.query("SELECT * FROM v13_private_order_queue")).rows).toHaveLength(0);
    } finally { await f.close(); }
  });

  it("skips an order cancelled after enqueue and batches the two surviving orders", async () => {
    const f = await cancellationFixture();
    try {
      let groupKey: Hex = word("0");
      for (const order of f.orders) groupKey = (await f.queue.enqueue(order)).groupKey;
      f.spent.add(f.nullifiers[0]);
      const batch = await f.queue.assemble(groupKey);
      expect(batch!.request.witness.orders.map(v13OrderCommitment).sort()).toEqual(f.commitments.slice(1).sort());
      const cancelled = await f.db.query("SELECT state,ciphertext FROM v13_private_order_queue WHERE order_commitment=$1",
        [f.commitments[0]]);
      expect(cancelled.rows[0].state).toBe("pending");
      expect(cancelled.rows[0].ciphertext).toBeTruthy();
      expect(await f.queue.getReceipt(f.commitments[0], word("a"))).toBeNull();
    } finally { await f.close(); }
  });

  it("leaves the survivor available and reconsiders a cancellation reversed by a reorg", async () => {
    const f = await cancellationFixture(2);
    try {
      const { groupKey } = await f.queue.enqueue(f.orders[0]);
      await f.queue.enqueue(f.orders[1]);
      f.spent.add(f.nullifiers[0]);
      expect(await f.queue.assemble(groupKey)).toBeNull();
      expect(await f.queue.pendingBatchIds()).toEqual([]);
      expect((await f.db.query("SELECT * FROM v13_private_witnesses")).rows).toHaveLength(0);
      f.spent.clear();
      expect(await f.queue.assemble(groupKey)).not.toBeNull();
    } finally { await f.close(); }
  });

  it("scans past a full page of spent orders instead of starving later live orders", async () => {
    const f = await cancellationFixture(36);
    try {
      let groupKey: Hex = word("0");
      for (const order of f.orders) groupKey = (await f.queue.enqueue(order)).groupKey;
      const sorted = (await f.db.query<{ order_commitment: Hex }>(
        "SELECT order_commitment FROM v13_private_order_queue ORDER BY created_at,order_commitment")).rows;
      for (const row of sorted.slice(0, 34)) f.spent.add(f.nullifiers[f.commitments.indexOf(row.order_commitment)]);
      f.resolve.mockClear();
      const batch = await f.queue.assemble(groupKey);
      expect(batch!.request.witness.orders.map(v13OrderCommitment).sort())
        .toEqual(sorted.slice(34).map((row) => row.order_commitment).sort());
      expect(f.resolve).toHaveBeenCalledTimes(2);
    } finally { await f.close(); }
  });

  it("does not claim a pair when spend status is missing or the RPC fails", async () => {
    const f = await cancellationFixture(2);
    try {
      const { groupKey } = await f.queue.enqueue(f.orders[0]);
      await f.queue.enqueue(f.orders[1]);
      f.resolve.mockResolvedValueOnce([]);
      await expect(f.queue.assemble(groupKey)).rejects.toThrow("spend status is unavailable");
      f.resolve.mockRejectedValueOnce(new Error("RPC timeout"));
      await expect(f.queue.assemble(groupKey)).rejects.toThrow("RPC timeout");
      expect(await f.queue.pendingBatchIds()).toEqual([]);
      expect(await f.queue.assemble(groupKey)).not.toBeNull();
    } finally { await f.close(); }
  });
});
