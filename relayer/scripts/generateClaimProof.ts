/**
 * generateClaimProof.ts — Generate a real UltraHonk proof for the claim circuit.
 *
 * Used by contracts/test/ClaimVerifierTest.t.sol via `vm.ffi` to validate the full
 * ZK claim pipeline (circuit execution + proof generation + on-chain verification)
 * without deploying to a live network.
 *
 * Scenario: 1 filled buy order in a single-order batch.
 *   - market_id    = 0x00..00
 *   - side         = 0 (YES_BUY)
 *   - amount       = 1_000_000 (1 USDC, 6 decimals)
 *   - limit_price  = 650_000  (0.65)
 *   - salt         = 0x01..01
 *   - batch_id     = 1
 *   - clearing_price = 650_000  →  buy fills (limit_price >= clearing_price)
 *   - recipient    = 0xAABBCC..  (arbitrary, unconstrained by circuit)
 *
 * Merkle tree: 512-leaf tree (DEPTH=9 in claim circuit), commitment at leaf 0,
 * all other leaves = bytes32(0). Matches BatchVault._buildMerkleRoot (n=512).
 *
 * Output: raw bytes (ABI-encoded `bytes proof, bytes32[] publicInputs`) written
 * to stdout so Forge vm.ffi() can decode them.
 * Status messages go to stderr only (won't corrupt the vm.ffi bytes channel).
 *
 * Prerequisites:
 *   - bb installed:   curl -L https://raw.githubusercontent.com/AztecProtocol/aztec-packages/master/barretenberg/cpp/installation/install | bash
 *   - circuit built:  cd circuits/claim && nargo compile
 *   - deps installed: cd relayer && npm install
 *
 * Standalone usage (from repo root):
 *   cd relayer && npx tsx scripts/generateClaimProof.ts
 *
 * vm.ffi usage (forge runs from contracts/ directory):
 *   args[0] = "../relayer/node_modules/.bin/tsx"
 *   args[1] = "../relayer/scripts/generateClaimProof.ts"
 */

import { Noir } from "@noir-lang/noir_js";
import { Barretenberg, UltraHonkBackend } from "@aztec/bb.js";
import { createRequire } from "module";
import { encodeAbiParameters, keccak256 } from "viem";
import { fileURLToPath } from "url";
import path from "path";

const _require  = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

/** Must match DEPTH in circuits/claim/src/main.nr and n=512 in BatchVault._buildMerkleRoot */
const CLAIM_DEPTH = 9;
const TREE_SIZE   = 1 << CLAIM_DEPTH; // 512

const ZERO_BYTES32 = ("0x" + "00".repeat(32)) as `0x${string}`;

/** Convert a hex string to a number[] of byte values for circuit inputs. */
function hexToByteArray(hex: string, len: number): number[] {
  const clean  = hex.startsWith("0x") ? hex.slice(2) : hex;
  const padded = clean.padStart(len * 2, "0");
  const out: number[] = [];
  for (let i = 0; i < len; i++) {
    out.push(parseInt(padded.slice(i * 2, i * 2 + 2), 16));
  }
  return out;
}

/**
 * Build a 512-leaf binary Merkle tree.
 * nodes[0] unused, nodes[1] = root, nodes[512..1023] = leaves.
 * Internal nodes: keccak256(abi.encode(left, right)).
 * Matches BatchVault._buildMerkleRoot (n=512) and batchProcessor.buildMerkleTree.
 */
function buildMerkleTree(leaves: `0x${string}`[]): `0x${string}`[] {
  const n = TREE_SIZE;
  const nodes: `0x${string}`[] = new Array(2 * n).fill(ZERO_BYTES32);
  for (let i = 0; i < leaves.length && i < n; i++) {
    nodes[n + i] = leaves[i];
  }
  for (let i = n - 1; i > 0; i--) {
    nodes[i] = keccak256(
      encodeAbiParameters(
        [{ type: "bytes32" }, { type: "bytes32" }],
        [nodes[2 * i], nodes[2 * i + 1]],
      ),
    ) as `0x${string}`;
  }
  return nodes;
}

/** Return the 9 sibling hashes for leaf at `leafIndex` in the tree. */
function getMerklePath(nodes: `0x${string}`[], leafIndex: number): `0x${string}`[] {
  const n = TREE_SIZE;
  const path: `0x${string}`[] = [];
  let pos = n + leafIndex;
  while (pos > 1) {
    const sibling = pos % 2 === 0 ? pos + 1 : pos - 1;
    path.push(nodes[sibling]);
    pos = Math.floor(pos / 2);
  }
  return path; // length = CLAIM_DEPTH = 9
}

/**
 * Commitment = keccak256(abi.encode(marketId, side, amount, limitPrice, salt))
 * Matches BatchVault._verifyCommitments and compute_commitment() in Noir circuit.
 */
function computeCommitment(
  marketId:   `0x${string}`,
  side:       number,
  amount:     bigint,
  limitPrice: bigint,
  salt:       `0x${string}`,
): `0x${string}` {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" }, // marketId
        { type: "uint8"   }, // side
        { type: "uint256" }, // amount
        { type: "uint256" }, // limitPrice
        { type: "bytes32" }, // salt
      ],
      [marketId, side, amount, limitPrice, salt],
    ),
  ) as `0x${string}`;
}

/**
 * Nullifier = keccak256(abi.encode(commitment, batchId, salt))
 * Matches BatchVault.usedNullifiers check and concat96/keccak in Noir circuit.
 */
function computeNullifier(
  commitment: `0x${string}`,
  batchId:    bigint,
  salt:       `0x${string}`,
): `0x${string}` {
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "uint256" }, { type: "bytes32" }],
      [commitment, batchId, salt],
    ),
  ) as `0x${string}`;
}

async function main(): Promise<void> {
  // Redirect console.log → stderr so vm.ffi stdout channel stays clean.
  // eslint-disable-next-line no-console
  console.log = (...args: unknown[]) =>
    process.stderr.write(args.map(String).join(" ") + "\n");

  // ── Test scenario ────────────────────────────────────────────────────────
  const marketId      = ZERO_BYTES32;
  const salt          = ("0x" + "01".repeat(32)) as `0x${string}`;
  const batchId       = 1n;
  const side          = 0;        // YES_BUY
  const amount        = 1_000_000n;   // 1 USDC (6 decimals)
  const limitPrice    = 650_000n;     // 0.65
  const clearingPrice = 650_000n;     // buy fills: limit_price >= clearing_price
  const recipient     = ("0x" + "aa".repeat(20)) as `0x${string}`;

  // Filled buy: fill_amount = amount, refund_amount = 0
  const fills       = true;
  const fillAmount  = amount;
  const refundAmount = 0n;

  // ── Commitment + Merkle tree ─────────────────────────────────────────────
  const commitment = computeCommitment(marketId, side, amount, limitPrice, salt);
  process.stderr.write(`[generateClaimProof] commitment = ${commitment}\n`);

  // 512-leaf tree with commitment at slot 0, all others = 0
  const leaves     = [commitment]; // rest are implicitly ZERO_BYTES32
  const nodes      = buildMerkleTree(leaves);
  const root       = nodes[1]; // Merkle root
  const merklePath = getMerklePath(nodes, 0);

  process.stderr.write(`[generateClaimProof] claimMerkleRoot = ${root}\n`);
  process.stderr.write(`[generateClaimProof] Merkle path depth = ${merklePath.length}\n`);

  if (merklePath.length !== CLAIM_DEPTH) {
    process.stderr.write(
      `[generateClaimProof] ERROR: path depth ${merklePath.length} != CLAIM_DEPTH ${CLAIM_DEPTH}\n`,
    );
    process.exit(1);
  }

  // ── Nullifier ────────────────────────────────────────────────────────────
  const nullifier = computeNullifier(commitment, batchId, salt);
  process.stderr.write(`[generateClaimProof] nullifier = ${nullifier}\n`);

  // ── Split bytes32 into u128 hi/lo pairs for circuit public inputs ────────
  const mask128   = (1n << 128n) - 1n;
  const rootVal   = BigInt(root);
  const nullVal   = BigInt(nullifier);

  // ── Load circuit ─────────────────────────────────────────────────────────
  const circuitPath = path.resolve(
    __dirname,
    "../../circuits/claim/target/claim.json",
  );

  let circuit: { bytecode: string };
  try {
    circuit = _require(circuitPath) as { bytecode: string };
  } catch {
    process.stderr.write(
      `[generateClaimProof] ERROR: Circuit not found at ${circuitPath}\n` +
      `  Run: cd circuits/claim && nargo compile\n`,
    );
    process.exit(1);
  }

  // ── Initialise Barretenberg ───────────────────────────────────────────────
  const bbPath = process.env.BB_PATH ?? `${process.env.HOME}/.bb/bb`;
  process.stderr.write(`[generateClaimProof] Loading Barretenberg (bbPath=${bbPath})...\n`);

  const api     = await Barretenberg.new({ bbPath });
  const backend = new UltraHonkBackend(circuit.bytecode, api);
  const noir    = new Noir(circuit);

  // ── Build witness ─────────────────────────────────────────────────────────
  const witnessInputs = {
    // Private inputs
    market_id:   hexToByteArray(marketId, 32),
    side,
    amount:      amount.toString(),
    limit_price: limitPrice.toString(),
    salt:        hexToByteArray(salt, 32),
    merkle_path: merklePath.map((h) => hexToByteArray(h, 32)),
    leaf_index:  "0",
    // Public outputs (circuit asserts these match computed values)
    batch_id:           batchId.toString(),
    commitment_root_hi: (rootVal >> 128n).toString(),
    commitment_root_lo: (rootVal & mask128).toString(),
    clearing_price:     clearingPrice.toString(),
    nullifier_hi:       (nullVal >> 128n).toString(),
    nullifier_lo:       (nullVal & mask128).toString(),
    recipient:          BigInt(recipient).toString(),
    fills,
    fill_amount:        fillAmount.toString(),
    refund_amount:      refundAmount.toString(),
    side_out:           side,
  };

  // ── Execute circuit ───────────────────────────────────────────────────────
  process.stderr.write("[generateClaimProof] Executing claim circuit...\n");
  let witness: Uint8Array;
  try {
    ({ witness } = await noir.execute(witnessInputs));
  } catch (err) {
    process.stderr.write(`[generateClaimProof] Circuit execution failed: ${err}\n`);
    await api.destroy();
    process.exit(1);
  }

  // ── Generate proof ────────────────────────────────────────────────────────
  process.stderr.write("[generateClaimProof] Generating UltraHonk claim proof (evm target)...\n");
  const proofData = await backend.generateProof(witness, { verifierTarget: "evm" });

  await api.destroy();

  const proofHex = ("0x" + Buffer.from(proofData.proof).toString("hex")) as `0x${string}`;
  const publicInputsHex = (proofData.publicInputs as string[]).map(
    (pi) => (pi.startsWith("0x") ? pi : "0x" + pi.padStart(64, "0")) as `0x${string}`,
  );

  process.stderr.write(
    `[generateClaimProof] Done.\n` +
    `  Proof size:          ${proofData.proof.length} bytes\n` +
    `  Public inputs count: ${publicInputsHex.length} (expected 11 = 27 - 16 pairing)\n`,
  );

  // ── Encode for vm.ffi ─────────────────────────────────────────────────────
  const encoded = encodeAbiParameters(
    [{ type: "bytes" }, { type: "bytes32[]" }],
    [proofHex, publicInputsHex],
  );
  process.stdout.write(encoded);
}

main().catch((err: unknown) => {
  process.stderr.write(`[generateClaimProof] Fatal error: ${err}\n`);
  process.exit(1);
});
