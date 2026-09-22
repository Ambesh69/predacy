import { concatHex, keccak256, zeroHash, type Hex } from "viem";
import type { V13MerkleWitness } from "./v13Proofs.js";

export const V13_TREE_DEPTH = 20;
const hashPair = (left: Hex, right: Hex) => keccak256(concatHex([left, right]));

export class V13MerkleTree {
  private readonly leaves: Hex[] = [];
  private readonly zeros: Hex[] = [];

  constructor() {
    this.zeros.push(zeroHash);
    for (let level = 1; level < V13_TREE_DEPTH; level++) {
      this.zeros.push(hashPair(this.zeros[level - 1], this.zeros[level - 1]));
    }
  }

  append(index: number, commitment: Hex): void {
    if (!/^0x[0-9a-fA-F]{64}$/.test(commitment) || index !== this.leaves.length ||
        index >= 1 << V13_TREE_DEPTH) throw new Error("Invalid or non-sequential v13 note event");
    this.leaves.push(commitment);
  }

  get size(): number { return this.leaves.length; }

  root(): Hex {
    if (!this.leaves.length) {
      return hashPair(this.zeros[V13_TREE_DEPTH - 1], this.zeros[V13_TREE_DEPTH - 1]);
    }
    return this.build().levels[V13_TREE_DEPTH][0];
  }

  witness(index: number, expectedCommitment?: Hex): V13MerkleWitness {
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.leaves.length) {
      throw new Error("Unknown v13 leaf index");
    }
    if (expectedCommitment && this.leaves[index].toLowerCase() !== expectedCommitment.toLowerCase()) {
      throw new Error("V13 leaf commitment mismatch");
    }
    const { levels } = this.build();
    const path: Hex[] = [];
    let cursor = index;
    for (let level = 0; level < V13_TREE_DEPTH; level++) {
      path.push(levels[level][cursor ^ 1] ?? this.zeros[level]);
      cursor >>= 1;
    }
    return { root: levels[V13_TREE_DEPTH][0], path, index };
  }

  private build() {
    const levels: Hex[][] = [[...this.leaves]];
    for (let level = 0; level < V13_TREE_DEPTH; level++) {
      const current = levels[level];
      const next: Hex[] = [];
      const width = Math.max(1, Math.ceil(current.length / 2));
      for (let i = 0; i < width; i++) {
        next.push(hashPair(current[i * 2] ?? this.zeros[level], current[i * 2 + 1] ?? this.zeros[level]));
      }
      levels.push(next);
    }
    return { levels };
  }
}
