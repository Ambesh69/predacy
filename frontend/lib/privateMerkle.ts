import { encodePacked, keccak256, parseAbiItem, zeroHash, type Address, type Hex, type PublicClient } from "viem";
import type { PrivateMerkleWitness } from "./privateProver";

const TREE_DEPTH = 20;
const NOTE_INSERTED = parseAbiItem("event NoteInserted(uint256 indexed leafIndex, bytes32 indexed commitment)");

function pair(left: Hex, right: Hex): Hex {
  return keccak256(encodePacked(["bytes32", "bytes32"], [left, right]));
}

function zeroes(): Hex[] {
  const values: Hex[] = [zeroHash];
  for (let level = 1; level < TREE_DEPTH; level += 1) values.push(pair(values[level - 1], values[level - 1]));
  return values;
}

export function buildPrivateMerkleWitness(leaves: Hex[], index: number): PrivateMerkleWitness {
  if (!Number.isInteger(index) || index < 0 || index >= leaves.length || leaves.length > 1 << TREE_DEPTH) {
    throw new Error("Private note leaf index is outside the current tree");
  }
  const empty = zeroes();
  const path: Hex[] = [];
  let cursor = index;
  let levelNodes = leaves.slice();
  for (let level = 0; level < TREE_DEPTH; level += 1) {
    const sibling = cursor ^ 1;
    path.push(levelNodes[sibling] ?? empty[level]);
    const parentCount = Math.max(1, Math.ceil(levelNodes.length / 2));
    const parents: Hex[] = [];
    for (let parent = 0; parent < parentCount; parent += 1) {
      parents.push(pair(levelNodes[parent * 2] ?? empty[level], levelNodes[parent * 2 + 1] ?? empty[level]));
    }
    levelNodes = parents;
    cursor >>= 1;
  }
  return { root: levelNodes[0], path, index };
}

export async function loadPrivateTree(
  client: PublicClient,
  pool: Address,
  deploymentBlock: bigint,
): Promise<Hex[]> {
  const latest = await client.getBlockNumber();
  const leaves: Hex[] = [];
  const chunk = 25_000n;
  for (let fromBlock = deploymentBlock; fromBlock <= latest; fromBlock += chunk) {
    const toBlock = fromBlock + chunk - 1n > latest ? latest : fromBlock + chunk - 1n;
    const logs = await client.getLogs({ address: pool, event: NOTE_INSERTED, fromBlock, toBlock });
    for (const log of logs) {
      const index = Number(log.args.leafIndex);
      const commitment = log.args.commitment;
      if (!Number.isSafeInteger(index) || index !== leaves.length || !commitment) {
        throw new Error("Private pool note history is incomplete or out of order");
      }
      leaves.push(commitment);
    }
  }
  return leaves;
}

export async function loadPrivateMerkleWitness(
  client: PublicClient,
  pool: Address,
  deploymentBlock: bigint,
  commitment: Hex,
): Promise<PrivateMerkleWitness> {
  const leaves = await loadPrivateTree(client, pool, deploymentBlock);
  const index = leaves.findIndex((leaf) => leaf.toLowerCase() === commitment.toLowerCase());
  if (index < 0) throw new Error("Private note commitment was not found in the pool tree");
  return buildPrivateMerkleWitness(leaves, index);
}
