/**
 * One-time setup script for BatchVault v7.
 *
 * Grants BatchVault two approvals from the relayer wallet:
 *   1. CTF setApprovalForAll(vault, true)  — vault can pull YES tokens from relayer
 *   2. USDC approve(vault, MAX_UINT256)    — vault can pull USDC from relayer (sell-side batches)
 *
 * Run once after deploying v7:
 *   cd relayer && npx tsx scripts/setupRelayerApprovals.ts
 *
 * Required env vars: RELAYER_PRIVATE_KEY, VAULT_ADDRESS, USDC_ADDRESS, RPC_URL
 */

import "dotenv/config";
import { createWalletClient, createPublicClient, http, maxUint256 } from "viem";
import { polygon } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

const CTF_ADDRESS  = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045" as const;
const VAULT        = (process.env.VAULT_ADDRESS  ?? "") as `0x${string}`;
const USDC         = (process.env.USDC_ADDRESS   ?? "") as `0x${string}`;
const PK           = (process.env.RELAYER_PRIVATE_KEY ?? "") as `0x${string}`;
const RPC          = process.env.RPC_URL ?? "https://polygon-rpc.com/";

if (!VAULT || !USDC || !PK) {
  console.error("Missing VAULT_ADDRESS, USDC_ADDRESS, or RELAYER_PRIVATE_KEY");
  process.exit(1);
}

const account = privateKeyToAccount(PK);
const chain   = polygon;
const transport = http(RPC);

const publicClient = createPublicClient({ chain, transport });
const walletClient = createWalletClient({ account, chain, transport });

const CTF_ABI = [
  {
    name: "setApprovalForAll",
    type: "function",
    inputs: [{ name: "operator", type: "address" }, { name: "approved", type: "bool" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    name: "isApprovedForAll",
    type: "function",
    inputs: [{ name: "account", type: "address" }, { name: "operator", type: "address" }],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "view",
  },
] as const;

const ERC20_ABI = [
  {
    name: "approve",
    type: "function",
    inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "nonpayable",
  },
  {
    name: "allowance",
    type: "function",
    inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
] as const;

console.log(`Relayer wallet: ${account.address}`);
console.log(`Vault:          ${VAULT}`);
console.log(`CTF:            ${CTF_ADDRESS}`);
console.log(`USDC:           ${USDC}`);
console.log();

// 1. Check + set CTF approval
const alreadyApproved = await publicClient.readContract({
  address: CTF_ADDRESS,
  abi: CTF_ABI,
  functionName: "isApprovedForAll",
  args: [account.address, VAULT],
});

if (alreadyApproved) {
  console.log("✓ CTF setApprovalForAll already set — skipping");
} else {
  console.log("→ Sending CTF.setApprovalForAll(vault, true)...");
  const hash = await walletClient.writeContract({
    address: CTF_ADDRESS,
    abi: CTF_ABI,
    functionName: "setApprovalForAll",
    args: [VAULT, true],
    maxPriorityFeePerGas: 100_000_000_000n,
    maxFeePerGas: 2_000_000_000_000n,
  });
  await publicClient.waitForTransactionReceipt({ hash });
  console.log(`✓ CTF approval set (tx: ${hash})`);
}

// 2. Check + set USDC approval
const currentAllowance = await publicClient.readContract({
  address: USDC,
  abi: ERC20_ABI,
  functionName: "allowance",
  args: [account.address, VAULT],
});

if (currentAllowance >= maxUint256 / 2n) {
  console.log("✓ USDC allowance already max — skipping");
} else {
  console.log("→ Sending USDC.approve(vault, MAX_UINT256)...");
  const hash = await walletClient.writeContract({
    address: USDC,
    abi: ERC20_ABI,
    functionName: "approve",
    args: [VAULT, maxUint256],
    maxPriorityFeePerGas: 100_000_000_000n,
    maxFeePerGas: 2_000_000_000_000n,
  });
  await publicClient.waitForTransactionReceipt({ hash });
  console.log(`✓ USDC approval set (tx: ${hash})`);
}

console.log("\nSetup complete. Relayer wallet is ready for BatchVault v7.");
