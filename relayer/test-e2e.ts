/**
 * End-to-end test for the ZK Claim Proof flow (Fix #2).
 * Runs against a local Anvil node with deployed contracts.
 *
 * Usage: npx tsx test-e2e.ts
 *
 * Requires:
 *   - anvil running at http://localhost:8545 (chain-id 80002)
 *   - relayer running at http://localhost:3001
 *   - contracts deployed (addresses hard-coded below after forge deploy)
 */

import { createPublicClient, createWalletClient, http, keccak256, encodeAbiParameters, parseAbiParameters } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygonAmoy } from "viem/chains";

// ── Addresses from forge deploy output ────────────────────────────────────────
const VAULT_ADDRESS = "0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9" as `0x${string}`;
const USDC_ADDRESS  = "0x5FbDB2315678afecb367f032d93F642f64180aa3" as `0x${string}`;
const RELAYER_URL   = "http://localhost:3001";
const RPC_URL       = "http://localhost:8545";

// ── Anvil default account ──────────────────────────────────────────────────────
const PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as `0x${string}`;
const account     = privateKeyToAccount(PRIVATE_KEY);

const localAmoy = { ...polygonAmoy, id: 80002 };
const publicClient = createPublicClient({ chain: localAmoy, transport: http(RPC_URL) });
const walletClient = createWalletClient({ account, chain: localAmoy, transport: http(RPC_URL) });

// ── Order parameters ──────────────────────────────────────────────────────────
const MARKET_ID   = ("0x" + "00".repeat(32)) as `0x${string}`; // bytes32(0) — matches deploy
const BATCH_ID    = 1n;
const IS_BUY      = true;
const AMOUNT      = 1_000_000n;  // 1 USDC (6 decimals)
const LIMIT_PRICE = 600_000n;    // 0.60 — will fill if clearingPrice ≤ 0.60

// Random salt — secret credential for the ZK claim proof
const saltBytes = new Uint8Array(32);
crypto.getRandomValues(saltBytes);
const SALT = ("0x" + Array.from(saltBytes).map((b) => b.toString(16).padStart(2, "0")).join("")) as `0x${string}`;

// Commitment hash: keccak256(marketId, isBuy, amount, limitPrice, salt) — NO trader
const COMMITMENT = keccak256(encodeAbiParameters(
  parseAbiParameters("bytes32, bool, uint256, uint256, bytes32"),
  [MARKET_ID, IS_BUY, AMOUNT, LIMIT_PRICE, SALT],
));

// ── ABIs ──────────────────────────────────────────────────────────────────────
const USDC_ABI = [
  { name: "mint",    type: "function", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [], stateMutability: "nonpayable" },
  { name: "balanceOf", type: "function", inputs: [{ name: "", type: "address" }], outputs: [{ name: "", type: "uint256" }], stateMutability: "view" },
] as const;

const VAULT_ABI = [
  { name: "nonces",  type: "function", inputs: [{ name: "", type: "address" }], outputs: [{ name: "", type: "uint256" }], stateMutability: "view" },
  { name: "getBatch", type: "function", inputs: [{ name: "batchId", type: "uint256" }], outputs: [
    { name: "batch", type: "tuple", components: [
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
    ]},
  ], stateMutability: "view" },
  { name: "usedNullifiers", type: "function", inputs: [{ name: "", type: "bytes32" }], outputs: [{ name: "", type: "bool" }], stateMutability: "view" },
] as const;

// ── Helpers ───────────────────────────────────────────────────────────────────
function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

async function waitForSettlement(maxWaitMs = 90_000): Promise<{ clearingPrice: bigint; claimMerkleRoot: `0x${string}` }> {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const batch = await publicClient.readContract({ address: VAULT_ADDRESS, abi: VAULT_ABI, functionName: "getBatch", args: [BATCH_ID] }) as any;
    const status = Number(batch.status);
    if (status === 2) { // SETTLED
      return { clearingPrice: batch.clearingPrice as bigint, claimMerkleRoot: batch.claimMerkleRoot as `0x${string}` };
    }
    process.stdout.write(`  Batch status=${status} (${Math.round((Date.now() - start) / 1000)}s)...\r`);
    await sleep(2000);
  }
  throw new Error("Batch did not settle within " + maxWaitMs / 1000 + "s");
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log("=== Predacy ZK Claim E2E Test ===");
  console.log(`Account  : ${account.address}`);
  console.log(`Vault    : ${VAULT_ADDRESS}`);
  console.log(`Salt     : ${SALT}`);
  console.log(`Commitment: ${COMMITMENT}`);

  // ── 1. Mint USDC ────────────────────────────────────────────────────────────
  console.log("\n[1] Minting 10 USDC...");
  const mintTx = await walletClient.writeContract({ address: USDC_ADDRESS, abi: USDC_ABI, functionName: "mint", args: [account.address, 10_000_000n] });
  await publicClient.waitForTransactionReceipt({ hash: mintTx });
  const bal = await publicClient.readContract({ address: USDC_ADDRESS, abi: USDC_ABI, functionName: "balanceOf", args: [account.address] });
  console.log(`  Balance: ${bal} (raw USDC units)`);

  // ── 2. Get nonce + deadline ──────────────────────────────────────────────────
  const nonce    = await publicClient.readContract({ address: VAULT_ADDRESS, abi: VAULT_ABI, functionName: "nonces", args: [account.address] }) as bigint;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 7200);
  console.log(`[2] Nonce: ${nonce}, Deadline: ${deadline}`);

  // ── 3. Sign CommitOrder EIP-712 ─────────────────────────────────────────────
  console.log("[3] Signing CommitOrder...");
  const signature = await walletClient.signTypedData({
    account,
    domain:      { name: "BatchVault", version: "1", chainId: 80002, verifyingContract: VAULT_ADDRESS },
    types:       { CommitOrder: [
      { name: "commitment", type: "bytes32" },
      { name: "amount",     type: "uint256" },
      { name: "batchId",    type: "uint256" },
      { name: "nonce",      type: "uint256" },
      { name: "deadline",   type: "uint256" },
    ]},
    primaryType: "CommitOrder",
    message:     { commitment: COMMITMENT, amount: AMOUNT, batchId: BATCH_ID, nonce, deadline },
  });

  // ── 4. Sign EIP-3009 TransferWithAuthorization ───────────────────────────────
  console.log("[4] Signing EIP-3009 TransferWithAuthorization...");
  const tnBytes = new Uint8Array(32);
  crypto.getRandomValues(tnBytes);
  const transferNonce  = ("0x" + Array.from(tnBytes).map((b) => b.toString(16).padStart(2, "0")).join("")) as `0x${string}`;
  const validAfter     = 0n;
  const validBefore    = BigInt(Math.floor(Date.now() / 1000) + 7200);

  const transferSig = await walletClient.signTypedData({
    account,
    domain: { name: "USD Coin (Test)", version: "1", chainId: 80002, verifyingContract: USDC_ADDRESS },
    types: { TransferWithAuthorization: [
      { name: "from",        type: "address" },
      { name: "to",          type: "address"  },
      { name: "value",       type: "uint256"  },
      { name: "validAfter",  type: "uint256"  },
      { name: "validBefore", type: "uint256"  },
      { name: "nonce",       type: "bytes32"  },
    ]},
    primaryType: "TransferWithAuthorization",
    message: { from: account.address, to: VAULT_ADDRESS, value: AMOUNT, validAfter, validBefore, nonce: transferNonce },
  });
  const r = transferSig.slice(0, 66) as `0x${string}`;
  const s = ("0x" + transferSig.slice(66, 130)) as `0x${string}`;
  const v = parseInt(transferSig.slice(130, 132), 16);

  // ── 5. POST /order ──────────────────────────────────────────────────────────
  console.log("[5] Submitting order to relayer...");
  const orderResp = await fetch(`${RELAYER_URL}/order`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({
      marketId:   MARKET_ID,
      batchId:    BATCH_ID.toString(),
      signer:     account.address,
      isBuy:      true,
      isSell:     false,
      amount:     AMOUNT.toString(),
      limitPrice: LIMIT_PRICE.toString(),
      salt:       SALT,
      commitment: COMMITMENT,
      signature,
      nonce:      nonce.toString(),
      deadline:   deadline.toString(),
      transferAuth: { from: account.address, validAfter: validAfter.toString(), validBefore: validBefore.toString(), nonce: transferNonce, v, r, s },
    }),
  });
  if (!orderResp.ok) {
    const err = await orderResp.text();
    throw new Error(`/order failed (${orderResp.status}): ${err}`);
  }
  console.log("  ✓ Order accepted by relayer");

  // ── 6. Wait for batch to settle ─────────────────────────────────────────────
  console.log("[6] Waiting for batch to settle...");
  const { clearingPrice, claimMerkleRoot } = await waitForSettlement();
  console.log(`\n  ✓ Settled! clearingPrice=${clearingPrice}, claimMerkleRoot=${claimMerkleRoot}`);

  // ── 7. POST /claim-proof ────────────────────────────────────────────────────
  console.log("[7] Requesting ZK claim proof from relayer...");
  const claimResp = await fetch(`${RELAYER_URL}/claim-proof`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({
      batchId:    BATCH_ID.toString(),
      marketId:   MARKET_ID,
      isBuy:      IS_BUY,
      amount:     AMOUNT.toString(),
      limitPrice: LIMIT_PRICE.toString(),
      salt:       SALT,
      recipient:  account.address,
    }),
  });
  const claimResult = await claimResp.json() as any;
  if (!claimResp.ok) throw new Error(`/claim-proof failed (${claimResp.status}): ${JSON.stringify(claimResult)}`);

  const txHash = claimResult.txHash as `0x${string}`;
  console.log(`  Relayer submitted tx: ${txHash}`);

  // ── 8. Wait for claim tx + verify ───────────────────────────────────────────
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  console.log(`  Receipt status: ${receipt.status}, gasUsed: ${receipt.gasUsed}`);

  // Verify nullifier is now marked used
  const nullifier = keccak256(encodeAbiParameters(parseAbiParameters("bytes32, uint256, bytes32"), [COMMITMENT, BATCH_ID, SALT]));
  const nullifierUsed = await publicClient.readContract({ address: VAULT_ADDRESS, abi: VAULT_ABI, functionName: "usedNullifiers", args: [nullifier] });

  console.log("\n=== RESULTS ===");
  console.log(`  Tx hash        : ${txHash}`);
  console.log(`  Status         : ${receipt.status}`);
  console.log(`  Nullifier used : ${nullifierUsed}`);
  console.log(`  Logs emitted   : ${receipt.logs.length}`);

  if (receipt.status === "success" && nullifierUsed) {
    console.log("\n✅ ZK Claim E2E test PASSED — claim submitted by relayer, nullifier marked used");
  } else {
    console.error("\n❌ Test FAILED");
    process.exit(1);
  }
}

main().catch((e) => { console.error("\nFATAL:", e.message); process.exit(1); });
