import { describe, expect, it, vi } from "vitest";
import { encodeFunctionData, toHex, type Address } from "viem";
import { V13MerkleTree } from "./v13MerkleTree.js";
import { v13OrderStateResolver, v13RoutedNullifiers, V13_ROUTE_HISTORY_ABI,
  type V13OrderStateReader } from "./v13OrderState.js";

const word = (value: number) => toHex(value, { size: 32 });
function fixture() {
  const tree = new V13MerkleTree();
  tree.append(0, word(1));
  tree.append(1, word(2));
  const reader: V13OrderStateReader = {
    head: vi.fn(async () => 50_105n),
    blockHash: vi.fn(async () => word(99)),
    leaves: vi.fn(async (from) => from === 100n
      ? [{ index: 0, commitment: word(1) }, { index: 1, commitment: word(2) }] : []),
    root: vi.fn(async () => tree.root()),
    spentNullifiers: vi.fn(async (from) => from === 100n ? [word(20)] : []),
  };
  const leaves = [{ index: 0, commitment: word(1), nullifier: word(10) },
    { index: 1, commitment: word(2), nullifier: word(20) }];
  return { tree, reader, leaves, resolve: v13OrderStateResolver(reader, 100n) };
}

describe("v13 queue chain snapshots", () => {
  it("pages the tree and checks membership and spends at one pinned block", async () => {
    const { tree, reader, leaves, resolve } = fixture();
    expect(await resolve(leaves)).toEqual([
      { merkle: tree.witness(0, word(1)), spent: false },
      { merkle: tree.witness(1, word(2)), spent: true },
    ]);
    expect(vi.mocked(reader.leaves).mock.calls).toEqual([[100n, 25_099n], [25_100n, 50_099n], [50_100n, 50_105n]]);
    expect(reader.root).toHaveBeenCalledWith(50_105n);
    expect(vi.mocked(reader.spentNullifiers).mock.calls).toEqual([[100n, 25_099n], [25_100n, 50_099n], [50_100n, 50_105n]]);
    expect(vi.mocked(reader.blockHash).mock.calls).toEqual([[50_105n], [50_105n]]);
  });

  it("rejects incomplete RPC event history", async () => {
    const { reader, leaves, resolve } = fixture();
    vi.mocked(reader.root).mockResolvedValue(word(30));
    await expect(resolve(leaves)).rejects.toThrow("differs from the on-chain root");
  });

  it("rejects an intra-read reorg rather than mixing two forks", async () => {
    const { reader, leaves, resolve } = fixture();
    vi.mocked(reader.blockHash).mockResolvedValueOnce(word(99)).mockResolvedValueOnce(word(98));
    await expect(resolve(leaves)).rejects.toThrow("snapshot changed");
  });

  it("fails closed on missing blocks and unavailable spend checks", async () => {
    const { reader, leaves, resolve } = fixture();
    vi.mocked(reader.blockHash).mockResolvedValueOnce(null);
    await expect(resolve(leaves)).rejects.toThrow("block is unavailable");
    vi.mocked(reader.spentNullifiers).mockRejectedValueOnce(new Error("RPC timeout"));
    await expect(resolve(leaves)).rejects.toThrow("RPC timeout");
  });

  it("rejects a head before deployment and an invalid deployment block", async () => {
    const { reader, leaves, resolve } = fixture();
    vi.mocked(reader.head).mockResolvedValue(99n);
    await expect(resolve(leaves)).rejects.toThrow("has not been deployed");
    expect(() => v13OrderStateResolver(reader, -1n)).toThrow("Invalid v13 deployment block");
  });

  it("extracts routed nullifiers only from a direct transaction matching the public event", () => {
    const pool = "0x0000000000000000000000000000000000000011" as Address;
    const event = { batchBinding: word(30), positionTokenId: 99n, totalDeposit: 1_000_000n };
    const transaction = { to: pool, input: encodeFunctionData({ abi: V13_ROUTE_HISTORY_ABI,
      functionName: "startBuyBatch", args: ["0x", word(1), 99n, [word(10), word(20)],
        [word(11), word(21)], 1_000_000n, word(30)] }) };
    expect(v13RoutedNullifiers(pool, transaction, event)).toEqual([word(10), word(20)]);
    expect(() => v13RoutedNullifiers(pool, { ...transaction, to: null }, event)).toThrow("direct pool transaction");
    expect(() => v13RoutedNullifiers(pool, transaction, { ...event, totalDeposit: 2n })).toThrow("does not match");
    expect(() => v13RoutedNullifiers(pool, transaction, { ...event, batchBinding: word(31) })).toThrow("does not match");
  });
});
