/**
 * testClaimProof.ts
 *
 * Quick smoke test: generates a ZK claim proof and verifies it locally
 * using the same bb.js backend that Railway uses.
 *
 * Run: BB_PATH=$HOME/.bb/bb tsx scripts/testClaimProof.ts
 *
 * If this passes, the proof generation + local verification works.
 * If this fails, the issue is in proof generation itself.
 */

import { keccak256, encodeAbiParameters } from "viem";
import { createRequire } from "module";

const _require = createRequire(import.meta.url);

// ── Test parameters ─────────────────────────────────────────────────────────
const MARKET_ID = "0x0f49db97f71c68b1e42a6d16e3de93d85dbf7d4148e3f018eb79e88554be9f75" as `0x${string}`;
const SIDE    = 0; // YES_BUY
const AMOUNT  = 2_000_000n;     // 2 USDC
const LIMIT   = 700_000n;       // $0.70 limit
const SALT    = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef" as `0x${string}`;
const BATCH_ID       = 2n;
const CLEARING_PRICE = 650_000n; // $0.65 clears YES_BUY @ $0.70 limit
const RECIPIENT = "0x5502e893b5E1D0182f87Cb8564d34B85dd56138b" as `0x${string}`;

const ZERO_BYTES32 = ("0x" + "0".repeat(64)) as `0x${string}`;
const CLAIM_CIRCUIT_DEPTH = 9;
const PRICE_DECIMALS = 1_000_000n;

function hexToBytes(hex: `0x${string}`, expectedLen: number): number[] {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const padded = clean.padStart(expectedLen * 2, "0");
  const bytes: number[] = [];
  for (let i = 0; i < expectedLen; i++) {
    bytes.push(parseInt(padded.slice(i * 2, i * 2 + 2), 16));
  }
  return bytes;
}

function computeCommitment(marketId: `0x${string}`, side: number, amount: bigint, limitPrice: bigint, salt: `0x${string}`): `0x${string}` {
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "uint8" }, { type: "uint256" }, { type: "uint256" }, { type: "bytes32" }],
      [marketId, side, amount, limitPrice, salt],
    ),
  );
}

function buildMerkleTree(leaves: `0x${string}`[]): `0x${string}`[] {
  const n = 512;
  const nodes: `0x${string}`[] = new Array(2 * n).fill(ZERO_BYTES32);
  for (let i = 0; i < leaves.length; i++) nodes[n + i] = leaves[i];
  for (let i = n - 1; i > 0; i--) {
    nodes[i] = keccak256(
      encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }], [nodes[2*i], nodes[2*i+1]]),
    );
  }
  return nodes;
}

function getMerklePath(leaves: `0x${string}`[], leafIndex: number): `0x${string}`[] {
  const nodes = buildMerkleTree(leaves);
  const n = nodes.length / 2;
  const path: `0x${string}`[] = [];
  let pos = n + leafIndex;
  while (pos > 1) {
    const siblingPos = pos % 2 === 0 ? pos + 1 : pos - 1;
    path.push(nodes[siblingPos]);
    pos = Math.floor(pos / 2);
  }
  return path;
}

async function main() {
  console.log("[Test] Starting claim proof test...");

  // 1. Compute commitment
  const commitment = computeCommitment(MARKET_ID, SIDE, AMOUNT, LIMIT, SALT);
  console.log(`[Test] Commitment: ${commitment}`);

  // 2. Build Merkle tree (single leaf for simplicity)
  const allCommitments = [commitment];
  const nodes = buildMerkleTree(allCommitments);
  const merkleRoot = nodes[1];
  console.log(`[Test] Merkle root: ${merkleRoot}`);

  const merklePath = getMerklePath(allCommitments, 0);
  const paddedPath = [...merklePath];
  while (paddedPath.length < CLAIM_CIRCUIT_DEPTH) paddedPath.push(ZERO_BYTES32);

  // 3. Compute nullifier: keccak256(commitment, batchId, salt)
  const nullifierHex = keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "uint256" }, { type: "bytes32" }],
      [commitment, BATCH_ID, SALT],
    ),
  );
  console.log(`[Test] Nullifier: ${nullifierHex}`);

  // 4. Fill computation for YES_BUY (fills = true since limit >= clearing)
  const fills = LIMIT >= CLEARING_PRICE; // true
  const fillAmount = AMOUNT; // YES_BUY: fill_amount = amount
  const refundAmount = 0n;
  console.log(`[Test] Fills: ${fills}, fillAmount: ${fillAmount}`);

  // 5. Split hi/lo
  const rootVal = BigInt(merkleRoot);
  const nullVal = BigInt(nullifierHex);
  const mask128 = (1n << 128n) - 1n;

  const rootHi = rootVal >> 128n;
  const rootLo = rootVal & mask128;
  const nullHi = nullVal >> 128n;
  const nullLo = nullVal & mask128;

  // 6. Build witness
  const witnessInputs = {
    market_id:    hexToBytes(MARKET_ID, 32),
    side:         SIDE,
    amount:       AMOUNT.toString(),
    limit_price:  LIMIT.toString(),
    salt:         hexToBytes(SALT, 32),
    merkle_path:  paddedPath.map((h) => hexToBytes(h as `0x${string}`, 32)),
    leaf_index:   "0",
    batch_id:           BATCH_ID.toString(),
    commitment_root_hi: rootHi.toString(),
    commitment_root_lo: rootLo.toString(),
    clearing_price:     CLEARING_PRICE.toString(),
    nullifier_hi:       nullHi.toString(),
    nullifier_lo:       nullLo.toString(),
    recipient:          BigInt(RECIPIENT).toString(),
    fills,
    fill_amount:        fillAmount.toString(),
    refund_amount:      refundAmount.toString(),
    side_out:           SIDE,
  };

  console.log("[Test] Witness inputs prepared.");

  // 7. Load circuit and generate proof
  const { Noir } = await import("@noir-lang/noir_js");
  const { Barretenberg, UltraHonkBackend } = await import("@aztec/bb.js");

  const circuit = _require("../circuits/claim.json") as any;
  const bbPath = process.env.BB_PATH ?? `${process.env.HOME}/.bb/bb`;
  console.log(`[Test] Using bb at: ${bbPath}`);

  const api = await Barretenberg.new({ bbPath });
  const backend = new UltraHonkBackend(circuit.bytecode, api);
  const noir = new Noir(circuit);

  console.log("[Test] Executing claim circuit...");
  const { witness } = await noir.execute(witnessInputs);
  console.log("[Test] Circuit execution succeeded!");

  console.log("[Test] Generating UltraHonk proof (evm target)...");
  const proofData = await backend.generateProof(witness, { verifierTarget: "evm" });
  console.log(`[Test] Proof generated! Size: ${proofData.proof.length} bytes, Public inputs: ${proofData.publicInputs.length}`);
  console.log("[Test] Public inputs from prover:");
  proofData.publicInputs.forEach((pi, i) => console.log(`  [${i}] ${pi}`));

  // 8. Local verification
  console.log("[Test] Verifying proof locally...");
  const verified = await backend.verifyProof(proofData, { verifierTarget: "evm" });
  console.log(`[Test] Local verification: ${verified ? "PASSED ✓" : "FAILED ✗"}`);

  if (verified) {
    console.log("\n[Test] SUCCESS: Proof generates and verifies locally.");
    console.log("[Test] If on-chain fails, the issue is in the deployed verifier or how proof is passed.");

    // Compare with manually built publicInputs
    const expectedPIs = [
      ("0x" + BATCH_ID.toString(16).padStart(64, "0")),
      ("0x" + "0".repeat(32) + rootHi.toString(16).padStart(32, "0")),
      ("0x" + "0".repeat(32) + rootLo.toString(16).padStart(32, "0")),
      ("0x" + CLEARING_PRICE.toString(16).padStart(64, "0")),
      ("0x" + "0".repeat(32) + nullHi.toString(16).padStart(32, "0")),
      ("0x" + "0".repeat(32) + nullLo.toString(16).padStart(32, "0")),
      ("0x" + BigInt(RECIPIENT).toString(16).padStart(64, "0")),
      ("0x" + (fills ? "1" : "0").padStart(64, "0")),
      ("0x" + fillAmount.toString(16).padStart(64, "0")),
      ("0x" + refundAmount.toString(16).padStart(64, "0")),
      ("0x" + SIDE.toString(16).padStart(64, "0")),
    ];

    console.log("\n[Test] Expected public inputs (from _buildPublicInputs logic):");
    expectedPIs.forEach((pi, i) => console.log(`  [${i}] ${pi}`));

    console.log("\n[Test] Matching check:");
    proofData.publicInputs.forEach((pi, i) => {
      const match = pi.toLowerCase() === expectedPIs[i].toLowerCase();
      console.log(`  [${i}] ${match ? "✓" : "✗ MISMATCH"} prover=${pi} expected=${expectedPIs[i]}`);
    });
  } else {
    console.log("\n[Test] FAILURE: Local proof verification failed!");
    console.log("[Test] This means the proof generation itself is broken.");
  }

  await api.destroy();
}

main().catch((e) => {
  console.error("[Test] ERROR:", e);
  process.exit(1);
});
