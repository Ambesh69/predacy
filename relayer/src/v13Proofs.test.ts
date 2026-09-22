import { describe, expect, it } from "vitest";
import { concatHex, keccak256, zeroHash, type Hex } from "viem";
import {
  buildV13CancelInputs, buildV13OrderLockInputs, buildV13RouteInputs, buildV13SettlementInputs,
  proveV13Route, proveV13Settlement, v13MerkleRoot, v13NoteCommitment, v13OrderCommitment,
  type V13BatchWitness, type V13PrivateOrder,
} from "./v13Proofs.js";

const word = (byte: string) => `0x${byte.repeat(64)}` as Hex;
const hashPair = (left: Hex, right: Hex) => keccak256(concatHex([left, right]));

function pathFor(leaf: Hex, index = 0) {
  const path: Hex[] = [];
  let zero: Hex = zeroHash;
  for (let level = 0; level < 20; level++) {
    path.push(zero);
    zero = hashPair(zero, zero);
  }
  return { root: v13MerkleRoot(leaf, { path, index }), path, index };
}

function order(byte: string, positionAsset = word("2")): V13PrivateOrder {
  const base = { positionAsset, deposit: byte === "3" ? 600_000n : 400_000n, limitPrice: 600_000n,
    refundPublicKey: word(byte), positionPublicKey: word(byte === "3" ? "5" : "6"),
    orderSecret: word(byte === "3" ? "7" : "8") };
  const commitment = v13OrderCommitment(base);
  return { ...base, merkle: pathFor(commitment) };
}

function sharedBatch(): V13BatchWitness {
  const first = order("3");
  const secondBase = order("4");
  const firstCommitment = v13OrderCommitment(first);
  const secondCommitment = v13OrderCommitment(secondBase);
  const mutFirst = [...first.merkle.path];
  const mutSecond = [...secondBase.merkle.path];
  mutFirst[0] = secondCommitment;
  mutSecond[0] = firstCommitment;
  const root = v13MerkleRoot(firstCommitment, { path: mutFirst, index: 0 });
  return { collateralAsset: word("1"), positionAsset: word("2"), orders: [
    { ...first, merkle: { root, path: mutFirst, index: 0 } },
    { ...secondBase, merkle: { root, path: mutSecond, index: 1 } },
  ] };
}

describe("v13 proof input boundaries", () => {
  it("locks a generic order without publishing its position asset", () => {
    const noteSecret = word("a");
    const collateral = word("1");
    const note = v13NoteCommitment(collateral, 600_000n, keccak256(noteSecret));
    const privateOrder = order("3");
    const built = buildV13OrderLockInputs({ collateralAsset: collateral, noteSecret,
      positionAsset: privateOrder.positionAsset, deposit: privateOrder.deposit,
      limitPrice: privateOrder.limitPrice, refundPublicKey: privateOrder.refundPublicKey,
      positionPublicKey: privateOrder.positionPublicKey, orderSecret: privateOrder.orderSecret,
      merkle: pathFor(note) });
    expect(built.publicInputs).toHaveLength(8);
    expect(built.publicInputs).not.toContain(privateOrder.positionAsset);
  });

  it("routes two orders without exposing either source commitment", () => {
    const batch = sharedBatch();
    const built = buildV13RouteInputs(batch);
    expect(built.publicInputs).toHaveLength(17);
    expect(built.publicInputs).not.toContain(built.commitments[0]);
    expect(built.publicInputs).not.toContain(built.commitments[1]);
    expect(built.nullifiers[0]).not.toBe(built.nullifiers[1]);
  });

  it("binds settlement outputs to the routed batch", () => {
    const built = buildV13SettlementInputs(sharedBatch(), [
      { spent: 550_000n, shares: 1_000_000n }, { spent: 0n, shares: 0n },
    ]);
    expect(built.publicInputs).toHaveLength(17);
    expect(built.refundCommitments[1]).not.toBe(zeroHash);
    expect(built.positionCommitments[1]).toBe(zeroHash);
  });

  it("cancels without publishing the position asset", () => {
    const privateOrder = order("3");
    const built = buildV13CancelInputs(word("1"), privateOrder);
    expect(built.publicInputs).toHaveLength(9);
    expect(built.publicInputs).not.toContain(privateOrder.positionAsset);
  });

  it("rejects stale or forged Merkle paths", () => {
    const batch = sharedBatch();
    batch.orders[1].merkle.root = word("f");
    expect(() => buildV13RouteInputs(batch)).toThrow(/root mismatch/i);
  });

  it.skipIf(process.env.RUN_V13_NATIVE_PROOF !== "1")("generates route and settlement EVM proofs", async () => {
    const batch = sharedBatch();
    const route = await proveV13Route(batch);
    expect(route.publicInputs).toEqual(buildV13RouteInputs(batch).publicInputs);
    const fills = [{ spent: 550_000n, shares: 1_000_000n }, { spent: 0n, shares: 0n }] as const;
    const settlement = await proveV13Settlement(batch, [...fills]);
    expect(settlement.publicInputs).toEqual(buildV13SettlementInputs(batch, [...fills]).publicInputs);
  }, 180_000);
});
