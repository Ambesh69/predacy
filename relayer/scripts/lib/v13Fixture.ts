import { keccak256, toHex, type Hex } from "viem";
import { V13MerkleTree } from "../../src/v13MerkleTree.js";
import { v13NoteCommitment, v13OrderCommitment, type V13BatchWitness } from "../../src/v13Proofs.js";
import type { V13BuyRequest } from "../../src/v13BuyRunner.js";

// Synthetic witnesses for read-only prover checks and database recovery exercises.
export function v13Fixture(seed: string): V13BuyRequest {
  const word = (label: string): Hex => keccak256(toHex(`${seed}:${label}`));
  const positionAsset = word("position");
  const orders = [0, 1].map((index) => ({ positionAsset, deposit: index === 0 ? 600_000n : 400_000n,
    limitPrice: 600_000n, refundPublicKey: word(`refund:${index}`),
    positionPublicKey: word(`shares:${index}`), orderSecret: word(`secret:${index}`) }));
  const tree = new V13MerkleTree();
  orders.forEach((order, index) => tree.append(index, v13OrderCommitment(order)));
  return { marketId: word("market"), positionTokenId: 99n, priceTick: 10_000n,
    depositWallet: "0x0000000000000000000000000000000000000011",
    witness: { collateralAsset: word("collateral"), positionAsset,
      orders: orders.map((order, index) => ({ ...order,
        merkle: tree.witness(index, v13OrderCommitment(order)) })) as V13BatchWitness["orders"] } };
}

export function v13LockFixture(request: V13BuyRequest) {
  const noteSecret = keccak256(toHex("v13 synthetic note secret"));
  const order = request.witness.orders[0];
  const tree = new V13MerkleTree();
  const note = v13NoteCommitment(request.witness.collateralAsset, order.deposit, keccak256(noteSecret));
  tree.append(0, note);
  return { ...order, collateralAsset: request.witness.collateralAsset,
    noteSecret, merkle: tree.witness(0, note) };
}
