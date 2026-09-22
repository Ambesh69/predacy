import { getAddress, isAddress, type Address } from "viem";

export interface PrivateContracts {
  pool: Address;
  deploymentBlock: bigint;
}

export function getPrivateContracts(): PrivateContracts | null {
  const pool = process.env.NEXT_PUBLIC_V13_POOL_ADDRESS?.trim();
  const block = process.env.NEXT_PUBLIC_V13_DEPLOYMENT_BLOCK?.trim();
  if (process.env.NEXT_PUBLIC_PRIVATE_TRADING_ENABLED !== "true" || !pool || !isAddress(pool) || !block || !/^\d+$/.test(block)) {
    return null;
  }
  return { pool: getAddress(pool), deploymentBlock: BigInt(block) };
}

export const SHIELDED_POOL_ABI = [
  {
    name: "paused", type: "function", stateMutability: "view", inputs: [],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    name: "collateralAssetId", type: "function", stateMutability: "view", inputs: [],
    outputs: [{ name: "", type: "bytes32" }],
  },
  {
    name: "positionAssetId", type: "function", stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }], outputs: [{ name: "", type: "bytes32" }],
  },
  {
    name: "deposit", type: "function", stateMutability: "nonpayable",
    inputs: [{ name: "amount", type: "uint256" }, { name: "notePublicKey", type: "bytes32" }],
    outputs: [{ name: "leafIndex", type: "uint256" }, { name: "commitment", type: "bytes32" }],
  },
  {
    name: "lockOrder", type: "function", stateMutability: "nonpayable",
    inputs: [
      { name: "proof", type: "bytes" }, { name: "root", type: "bytes32" },
      { name: "nullifier", type: "bytes32" }, { name: "orderCommitment", type: "bytes32" },
    ], outputs: [],
  },
  {
    name: "cancelOrder", type: "function", stateMutability: "nonpayable",
    inputs: [
      { name: "proof", type: "bytes" }, { name: "root", type: "bytes32" },
      { name: "orderNullifier", type: "bytes32" }, { name: "fullRefundCommitment", type: "bytes32" },
      { name: "totalDeposit", type: "uint256" },
    ], outputs: [],
  },
  {
    name: "withdraw", type: "function", stateMutability: "nonpayable",
    inputs: [
      { name: "proof", type: "bytes" }, { name: "root", type: "bytes32" },
      { name: "nullifier", type: "bytes32" }, { name: "amount", type: "uint256" },
      { name: "recipient", type: "address" },
    ], outputs: [],
  },
  {
    name: "withdrawPosition", type: "function", stateMutability: "nonpayable",
    inputs: [
      { name: "proof", type: "bytes" }, { name: "root", type: "bytes32" },
      { name: "nullifier", type: "bytes32" }, { name: "tokenId", type: "uint256" },
      { name: "amount", type: "uint256" }, { name: "recipient", type: "address" },
    ], outputs: [],
  },
  {
    name: "knownRoots", type: "function", stateMutability: "view",
    inputs: [{ name: "root", type: "bytes32" }], outputs: [{ name: "", type: "bool" }],
  },
  {
    name: "spentNullifiers", type: "function", stateMutability: "view",
    inputs: [{ name: "nullifier", type: "bytes32" }], outputs: [{ name: "", type: "bool" }],
  },
  {
    name: "NoteInserted", type: "event",
    inputs: [
      { name: "leafIndex", type: "uint256", indexed: true },
      { name: "commitment", type: "bytes32", indexed: true },
    ], anonymous: false,
  },
] as const;
