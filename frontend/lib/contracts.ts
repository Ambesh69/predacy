import { polygon, polygonAmoy } from "viem/chains";

// ── Contract Addresses ────────────────────────────────────────────────────────

export const CONTRACTS = {
  // Polygon mainnet (live Polymarket) — BatchVault pending mainnet deploy
  [polygon.id]: {
    batchVault: "0x0000000000000000000000000000000000000000" as `0x${string}`, // TODO: mainnet deploy
    usdc: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174" as `0x${string}`,
    ctf:  "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045" as `0x${string}`,
  },
  // Polygon Amoy testnet
  [polygonAmoy.id]: {
    batchVault: "0xE51dEB3a32d19fB5b9F9B7f1683F51363fdde98B" as `0x${string}`, // v6: remove batchId from CommitOrder EIP-712 (enables auto-requeue of excluded orders)
    usdc:       "0x3a863f9483217Ec2A909580747c3b5a299462b7A" as `0x${string}`, // MockUSDC (EIP-3009)
    ctf:        "0xCa35b74F92432A4c8A51452AA36f6beE7d503D07" as `0x${string}`, // MockCTF
  },
} as const;

/** Returns contract addresses for the given chainId. Throws if unsupported. */
export function getContracts(chainId: number) {
  const c = CONTRACTS[chainId as keyof typeof CONTRACTS];
  if (!c) throw new Error(`Predacy not deployed on chain ${chainId}`);
  return c;
}

// ── CTF (ERC-1155 ConditionalTokens) ABI — subset needed by frontend ─────────

export const CTF_ABI = [
  {
    name: "balanceOf",
    type: "function",
    inputs: [
      { name: "account", type: "address" },
      { name: "id",      type: "uint256" },
    ],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    name: "isApprovedForAll",
    type: "function",
    inputs: [
      { name: "account",  type: "address" },
      { name: "operator", type: "address" },
    ],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "view",
  },
  {
    name: "setApprovalForAll",
    type: "function",
    inputs: [
      { name: "operator", type: "address" },
      { name: "approved", type: "bool"    },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    name: "getCollectionId",
    type: "function",
    inputs: [
      { name: "parentCollectionId", type: "bytes32" },
      { name: "conditionId",        type: "bytes32" },
      { name: "indexSet",           type: "uint256" },
    ],
    outputs: [{ name: "", type: "bytes32" }],
    stateMutability: "view",
  },
  {
    name: "getPositionId",
    type: "function",
    inputs: [
      { name: "collateralToken", type: "address" },
      { name: "collectionId",   type: "bytes32"  },
    ],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
] as const;

// ── BatchVault ABI (subset needed by frontend) ────────────────────────────────

export const BATCH_VAULT_ABI = [
  {
    name: "commitOrder",
    type: "function",
    inputs: [
      { name: "commitment", type: "bytes32" },
      { name: "amount",     type: "uint256" },
      { name: "marketId",   type: "bytes32" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    name: "commitSellOrderFor",
    type: "function",
    inputs: [
      { name: "commitment", type: "bytes32" },
      { name: "yesAmount",  type: "uint256" },
      { name: "signer",     type: "address" },
      { name: "nonce",      type: "uint256" },
      { name: "deadline",   type: "uint256" },
      { name: "signature",  type: "bytes"   },
      { name: "marketId",   type: "bytes32" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    name: "claimPosition",
    type: "function",
    inputs: [
      { name: "batchId",    type: "uint256" },
      { name: "isBuy",      type: "bool"    },
      { name: "amount",     type: "uint256" },
      { name: "limitPrice", type: "uint256" },
      { name: "salt",       type: "bytes32" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    // ZK claim: prove order membership in Merkle tree without revealing trader address.
    // Payout goes to recipient derived from publicInputs[4] (chosen by user at claim time).
    // Relayer submits this on-chain — msg.sender = relayer, not the user.
    name: "claimWithProof",
    type: "function",
    inputs: [
      { name: "batchId",      type: "uint256"   },
      { name: "proof",        type: "bytes"     },
      { name: "publicInputs", type: "bytes32[]" },
    ],
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
          { name: "marketId",          type: "bytes32" },
          { name: "openedAt",          type: "uint256" },
          { name: "closedAt",          type: "uint256" },
          { name: "status",            type: "uint8"   },
          { name: "totalDeposited",    type: "uint256" },
          { name: "totalSellYes",      type: "uint256" },
          { name: "clearingPrice",     type: "uint256" },
          { name: "netBuyAmount",      type: "uint256" },
          { name: "yesTokensReceived", type: "uint256" },
          { name: "filledSellYes",     type: "uint256" },
          { name: "totalFilledBuyVol", type: "uint256" },
          { name: "commitmentCount",   type: "uint256" },
          { name: "commitmentRoot",    type: "bytes32" },
          { name: "claimMerkleRoot",   type: "bytes32" },
        ],
      },
    ],
    stateMutability: "view",
  },
  {
    name: "getPosition",
    type: "function",
    inputs: [
      { name: "batchId",    type: "uint256" },
      { name: "commitment", type: "bytes32" },
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
    name: "getCurrentBatchId",
    type: "function",
    inputs: [{ name: "marketId", type: "bytes32" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    name: "usedNullifiers",
    type: "function",
    inputs: [{ name: "nullifier", type: "bytes32" }],
    outputs: [{ name: "", type: "bool" }],
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
  // Custom errors (needed for viem to decode revert reasons)
  { name: "AlreadyClaimed",      type: "error", inputs: [] },
  { name: "BatchNotSettled",     type: "error", inputs: [] },
  { name: "BatchNotOpen",        type: "error", inputs: [] },
  { name: "CommitmentMismatch",  type: "error", inputs: [] },
  { name: "ZKProofInvalid",      type: "error", inputs: [] },
  { name: "NothingToClaim",      type: "error", inputs: [] },
  { name: "ClaimVerifierNotSet", type: "error", inputs: [] },
  // Events
  {
    name: "OrderCommitted",
    type: "event",
    inputs: [
      { name: "batchId",    type: "uint256", indexed: true },
      { name: "commitment", type: "bytes32", indexed: true },
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
    name: "transfer",
    type: "function",
    inputs: [
      { name: "to",    type: "address" },
      { name: "value", type: "uint256" },
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
