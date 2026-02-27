import { polygon, polygonAmoy } from "viem/chains";

// ── Contract Addresses ────────────────────────────────────────────────────────

export const CONTRACTS = {
  // Polygon mainnet (live Polymarket) — BatchVault pending mainnet deploy
  [polygon.id]: {
    batchVault: "0x0000000000000000000000000000000000000000" as `0x${string}`, // TODO: mainnet deploy
    usdc: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174" as `0x${string}`,
    ctf:  "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045" as `0x${string}`,
  },
  // Polygon Amoy testnet — deployed 2026-02-27 (EIP-712 commitOrderFor)
  [polygonAmoy.id]: {
    batchVault: "0x90AA21aD6c786FD673e5AeBd033247d63f810A9a" as `0x${string}`,
    usdc:       "0xEF6B42C6db7Fde49B8Ca85Ee457Ef85C739B9Cd9" as `0x${string}`, // MockUSDC
    ctf:        "0xDfc28eA864e4F2781096B413Aa1043FB095d762c" as `0x${string}`, // MockCTF
  },
} as const;

/** Returns contract addresses for the given chainId. Throws if unsupported. */
export function getContracts(chainId: number) {
  const c = CONTRACTS[chainId as keyof typeof CONTRACTS];
  if (!c) throw new Error(`Predacy not deployed on chain ${chainId}`);
  return c;
}

// ── BatchVault ABI (subset needed by frontend) ────────────────────────────────

export const BATCH_VAULT_ABI = [
  {
    name: "commitOrder",
    type: "function",
    inputs: [
      { name: "commitment", type: "bytes32" },
      { name: "amount",     type: "uint256" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    name: "claimPosition",
    type: "function",
    inputs: [{ name: "batchId", type: "uint256" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    name: "getBatch",
    type: "function",
    inputs: [{ name: "batchId", type: "uint256" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "marketId",         type: "bytes32" },
          { name: "openedAt",         type: "uint256" },
          { name: "closedAt",         type: "uint256" },
          { name: "status",           type: "uint8"   },
          { name: "totalDeposited",   type: "uint256" },
          { name: "clearingPrice",    type: "uint256" },
          { name: "netBuyAmount",     type: "uint256" },
          { name: "yesTokensReceived",type: "uint256" },
          { name: "commitmentCount",  type: "uint256" },
          { name: "commitmentRoot",   type: "bytes32" },
        ],
      },
    ],
    stateMutability: "view",
  },
  {
    name: "getPosition",
    type: "function",
    inputs: [
      { name: "batchId", type: "uint256" },
      { name: "trader",  type: "address" },
    ],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "filledAmount", type: "uint256" },
          { name: "refundAmount", type: "uint256" },
          { name: "isBuy",        type: "bool"    },
          { name: "claimed",      type: "bool"    },
        ],
      },
    ],
    stateMutability: "view",
  },
  {
    name: "currentBatchId",
    type: "function",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    name: "BATCH_WINDOW",
    type: "function",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    name: "nonces",
    type: "function",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  // Events
  {
    name: "OrderCommitted",
    type: "event",
    inputs: [
      { name: "batchId",    type: "uint256", indexed: true  },
      { name: "trader",     type: "address", indexed: true  },
      { name: "commitment", type: "bytes32", indexed: false },
      { name: "amount",     type: "uint256", indexed: false },
    ],
  },
  {
    name: "BatchSettled",
    type: "event",
    inputs: [
      { name: "batchId",          type: "uint256", indexed: true  },
      { name: "clearingPrice",    type: "uint256", indexed: false },
      { name: "totalBuyVolume",   type: "uint256", indexed: false },
      { name: "totalSellVolume",  type: "uint256", indexed: false },
      { name: "netBuyAmount",     type: "uint256", indexed: false },
      { name: "yesTokensReceived",type: "uint256", indexed: false },
    ],
  },
] as const;

export const ERC20_ABI = [
  {
    name: "approve",
    type: "function",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount",  type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "nonpayable",
  },
  {
    name: "allowance",
    type: "function",
    inputs: [
      { name: "owner",   type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    name: "balanceOf",
    type: "function",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
] as const;

/** ABI for MockUSDC faucet (testnet only) */
export const MOCK_USDC_ABI = [
  ...ERC20_ABI,
  {
    name: "mint",
    type: "function",
    inputs: [
      { name: "to",     type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const;

// ── Batch status enum (mirrors Solidity) ─────────────────────────────────────

export enum BatchStatus {
  OPEN     = 0,
  SETTLING = 1,
  SETTLED  = 2,
}
