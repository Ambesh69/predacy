import { decodeFunctionData, getAddress, parseAbi, type Address, type Hex } from "viem";
import { V13MerkleTree } from "./v13MerkleTree.js";
import type { V13WitnessResolver } from "./v13OrderQueue.js";

export interface V13OrderStateReader {
  head(): Promise<bigint>;
  blockHash(block: bigint): Promise<Hex | null>;
  leaves(from: bigint, to: bigint): Promise<Array<{ index: number; commitment: Hex }>>;
  root(block: bigint): Promise<Hex>;
  spentNullifiers(from: bigint, to: bigint): Promise<Hex[]>;
}

export const V13_ROUTE_HISTORY_ABI = parseAbi([
  "function startBuyBatch(bytes,bytes32,uint256,bytes32[2],bytes32[2],uint256,bytes32)",
]);

export function v13RoutedNullifiers(pool: Address, transaction: { to: Address | null; input: Hex },
  event: { batchBinding: Hex; positionTokenId: bigint; totalDeposit: bigint }): readonly [Hex, Hex] {
  if (!transaction.to || getAddress(transaction.to) !== getAddress(pool)) {
    throw new Error("V13 route history requires a direct pool transaction");
  }
  const decoded = decodeFunctionData({ abi: V13_ROUTE_HISTORY_ABI, data: transaction.input });
  if (decoded.args[2] !== event.positionTokenId || decoded.args[5] !== event.totalDeposit ||
      decoded.args[6].toLowerCase() !== event.batchBinding.toLowerCase()) {
    throw new Error("V13 route transaction does not match its event");
  }
  return decoded.args[3];
}

// Membership and cancellation must refer to the same chain snapshot.
export function v13OrderStateResolver(reader: V13OrderStateReader, deploymentBlock: bigint): V13WitnessResolver {
  if (deploymentBlock < 0n) throw new Error("Invalid v13 deployment block");
  return async (leaves) => {
    const block = await reader.head();
    if (block < deploymentBlock) throw new Error("V13 pool has not been deployed at the RPC head");
    const hash = await reader.blockHash(block);
    if (!hash) throw new Error("V13 queue snapshot block is unavailable");
    const tree = new V13MerkleTree();
    const spent = new Set<string>();
    for (let from = deploymentBlock; from <= block; from += 25_000n) {
      const to = from + 24_999n < block ? from + 24_999n : block;
      for (const leaf of await reader.leaves(from, to)) tree.append(leaf.index, leaf.commitment);
      for (const nullifier of await reader.spentNullifiers(from, to)) spent.add(nullifier.toLowerCase());
    }
    if (tree.root().toLowerCase() !== (await reader.root(block)).toLowerCase()) {
      throw new Error("V13 queue event tree differs from the on-chain root");
    }
    const states = leaves.map((leaf) => ({ merkle: tree.witness(leaf.index, leaf.commitment),
      spent: spent.has(leaf.nullifier.toLowerCase()) }));
    if ((await reader.blockHash(block))?.toLowerCase() !== hash.toLowerCase()) {
      throw new Error("V13 queue snapshot changed during resolution; retry");
    }
    return states;
  };
}
