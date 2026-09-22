import { describe, expect, it } from "vitest";
import { concatHex, keccak256, zeroHash, type Hex } from "viem";
import { v13MerkleRoot } from "./v13Proofs.js";
import { V13MerkleTree } from "./v13MerkleTree.js";

const word = (byte: string) => `0x${byte.repeat(64)}` as Hex;
const pair = (left: Hex, right: Hex) => keccak256(concatHex([left, right]));

describe("v13 event-derived Merkle tree", () => {
  it("matches the pool's empty and append-only roots", () => {
    const tree = new V13MerkleTree();
    let zero: Hex = zeroHash;
    for (let level = 0; level < 20; level++) zero = pair(zero, zero);
    expect(tree.root()).toBe(zero);
    tree.append(0, word("1"));
    tree.append(1, word("2"));
    tree.append(2, word("3"));
    for (let index = 0; index < tree.size; index++) {
      const witness = tree.witness(index);
      expect(v13MerkleRoot(word(String(index + 1)), witness)).toBe(tree.root());
    }
  });

  it("rejects gaps and mismatched commitments", () => {
    const tree = new V13MerkleTree();
    expect(() => tree.append(1, word("1"))).toThrow(/non-sequential/i);
    tree.append(0, word("1"));
    expect(() => tree.witness(0, word("2"))).toThrow(/mismatch/i);
  });
});
