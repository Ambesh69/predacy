import { encodeAbiParameters, concatHex, keccak256, zeroHash, type Hex } from "viem";
import {
  proveV13Cancel, proveV13OrderLock, proveV13Route, proveV13Settlement,
  v13MerkleRoot, v13NoteCommitment, v13OrderCommitment,
  type V13BatchWitness, type V13PrivateOrder,
} from "../src/v13Proofs.js";

const word = (byte: string) => `0x${byte.repeat(64)}` as Hex;
const hashPair = (left: Hex, right: Hex) => keccak256(concatHex([left, right]));

function emptyPath(leaf: Hex, index = 0) {
  const path: Hex[] = [];
  let zero: Hex = zeroHash;
  for (let level = 0; level < 20; level++) { path.push(zero); zero = hashPair(zero, zero); }
  return { root: v13MerkleRoot(leaf, { path, index }), path, index };
}

function order(byte: string): V13PrivateOrder {
  const base = { positionAsset: word("2"), deposit: byte === "3" ? 600_000n : 400_000n,
    limitPrice: 600_000n, refundPublicKey: word(byte),
    positionPublicKey: word(byte === "3" ? "5" : "6"), orderSecret: word(byte === "3" ? "7" : "8") };
  return { ...base, merkle: emptyPath(v13OrderCommitment(base)) };
}

function batch(): V13BatchWitness {
  const first = order("3"); const second = order("4");
  const firstCommitment = v13OrderCommitment(first); const secondCommitment = v13OrderCommitment(second);
  const firstPath = [...first.merkle.path]; const secondPath = [...second.merkle.path];
  firstPath[0] = secondCommitment; secondPath[0] = firstCommitment;
  const root = v13MerkleRoot(firstCommitment, { path: firstPath, index: 0 });
  return { collateralAsset: word("1"), positionAsset: word("2"), orders: [
    { ...first, merkle: { root, path: firstPath, index: 0 } },
    { ...second, merkle: { root, path: secondPath, index: 1 } },
  ] };
}

const kind = process.argv[2];
const originalLog = console.log;
console.log = () => {};
let result: { proof: Hex; publicInputs: Hex[] };
if (kind === "order") {
  const collateralAsset = word("1"); const noteSecret = word("a");
  const note = v13NoteCommitment(collateralAsset, 600_000n, keccak256(noteSecret));
  const privateOrder = order("3");
  result = await proveV13OrderLock({ collateralAsset, noteSecret, positionAsset: privateOrder.positionAsset,
    deposit: privateOrder.deposit, limitPrice: privateOrder.limitPrice,
    refundPublicKey: privateOrder.refundPublicKey, positionPublicKey: privateOrder.positionPublicKey,
    orderSecret: privateOrder.orderSecret, merkle: emptyPath(note) });
} else if (kind === "route") {
  result = await proveV13Route(batch());
} else if (kind === "settlement") {
  result = await proveV13Settlement(batch(), [
    { spent: 550_000n, shares: 1_000_000n }, { spent: 0n, shares: 0n },
  ]);
} else if (kind === "cancel") {
  result = await proveV13Cancel(word("1"), order("3"));
} else {
  throw new Error("Expected v13 proof kind: order, route, settlement, or cancel");
}
console.log = originalLog;
process.stdout.write(encodeAbiParameters(
  [{ type: "bytes" }, { type: "bytes32[]" }], [result.proof, result.publicInputs],
));
