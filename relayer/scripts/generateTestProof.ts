/**
 * generateTestProof.ts — Generate a real UltraHonk proof for the batch_clearing circuit.
 *
 * Used by contracts/test/HonkVerifierTest.t.sol via `vm.ffi` to validate the full ZK
 * pipeline (circuit execution + proof generation + on-chain verification) without
 * deploying to a live network.
 *
 * Produces a deterministic single-order proof:
 *   - 1 YES buy order: amount=1 USDC, limit_price=0.65, salt=0x01..01
 *   - clearing_price = 0.65  →  buy fills, no sell side
 *   - filled_yes_buy_vol = 1_000_000; all other side volumes are zero
 *
 * Output: raw bytes (ABI-encoded `bytes proof, bytes32[] publicInputs`) written to
 * stdout so Forge's vm.ffi() can decode them with `abi.decode(result, (bytes, bytes32[]))`.
 * Status messages go to stderr only (won't corrupt the vm.ffi bytes channel).
 *
 * Prerequisites:
 *   - bb installed:   curl -L https://raw.githubusercontent.com/AztecProtocol/aztec-packages/master/barretenberg/cpp/installation/install | bash
 *   - circuit built:  cd circuits/batch_clearing && nargo build
 *   - deps installed: cd relayer && npm install
 *
 * Standalone usage (from repo root):
 *   cd relayer && npx tsx scripts/generateTestProof.ts
 *
 * vm.ffi usage (forge runs from contracts/ directory):
 *   args[0] = "../relayer/node_modules/.bin/tsx"
 *   args[1] = "../relayer/scripts/generateTestProof.ts"
 */

import { Noir } from "@noir-lang/noir_js";
import { Barretenberg, UltraHonkBackend } from "@aztec/bb.js";
import { createRequire } from "module";
import {
  encodeAbiParameters,
  keccak256,
} from "viem";
import { fileURLToPath } from "url";
import path from "path";

const _require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

/** Must match MAX_ORDERS in circuits/batch_clearing/src/main.nr */
const CIRCUIT_MAX_ORDERS = 8;

/** Convert a hex string to a number[] of byte values (for circuit inputs). */
function hexToByteArray(hex: string, expectedLen: number): number[] {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const padded = clean.padStart(expectedLen * 2, "0");
  const bytes: number[] = [];
  for (let i = 0; i < expectedLen; i++) {
    bytes.push(parseInt(padded.slice(i * 2, i * 2 + 2), 16));
  }
  return bytes;
}

/**
 * Compute an order commitment matching BatchVault._makeCommitment() in Solidity:
 *   keccak256(abi.encode(marketId, side, amount, limitPrice, salt))
 * No trader address — matches the privacy-preserving commitment scheme.
 */
function computeCommitment(
  marketId: `0x${string}`,
  side: number,
  amount: bigint,
  limitPrice: bigint,
  salt: `0x${string}`,
): `0x${string}` {
  const encoded = encodeAbiParameters(
    [
      { type: "bytes32" }, // marketId
      { type: "uint8"   }, // side
      { type: "uint256" }, // amount
      { type: "uint256" }, // limitPrice
      { type: "bytes32" }, // salt
    ],
    [marketId, side, amount, limitPrice, salt],
  );
  return keccak256(encoded);
}

/**
 * Compute sequential commitment root matching BatchVault._computeCommitmentRoot():
 *   root = keccak256(abi.encode(... keccak256(abi.encode(0, h[0])), h[1] ...), h[n-1])
 */
function computeCommitmentRoot(commitments: `0x${string}`[]): `0x${string}` {
  let root = ("0x" + "00".repeat(32)) as `0x${string}`;
  for (const c of commitments) {
    root = keccak256(
      encodeAbiParameters(
        [{ type: "bytes32" }, { type: "bytes32" }],
        [root, c],
      ),
    );
  }
  return root;
}

async function main(): Promise<void> {
  // Redirect console.log → stderr so any library console.log calls (e.g. bb.js
  // "Generated proof for circuit…") don't pollute stdout.  Forge's vm.ffi()
  // reads ALL of stdout and requires it to start with "0x" for hex-decoding.
  // eslint-disable-next-line no-console
  console.log = (...args: unknown[]) =>
    process.stderr.write(args.map(String).join(" ") + "\n");

  // Locate the compiled circuit JSON (relative to this script file)
  const circuitPath = path.resolve(
    __dirname,
    "../../circuits/batch_clearing/target/batch_clearing.json",
  );

  let circuit: { bytecode: string };
  try {
    circuit = _require(circuitPath) as { bytecode: string };
  } catch {
    process.stderr.write(
      `[generateTestProof] ERROR: Circuit not found at ${circuitPath}\n` +
      `  Run: cd circuits/batch_clearing && nargo build\n`,
    );
    process.exit(1);
  }

  // ── Build a deterministic single-order batch witness ──────────────────────
  // Test values (hardcoded for reproducibility):
  //   1 buy order: 1 USDC at 65c clearing price.
  //   buy fills (limit_price 650000 >= clearing_price 650000), no sell side.
  const marketId      = ("0x" + "00".repeat(32)) as `0x${string}`;
  const salt          = ("0x" + "01".repeat(32)) as `0x${string}`;
  const amount        = BigInt(1_000_000);  // 1.000000 USDC (6 decimals)
  const limitPrice    = BigInt(650_000);    // 0.650000 (65c)
  const clearingPrice = BigInt(650_000);    // buy fills: limit_price >= clearing_price

  // Commitment for the one real order (matches compute_commitment() in Noir circuit)
  // No trader address — privacy-preserving commitment scheme.
  const commitment = computeCommitment(
    marketId, 0, amount, limitPrice, salt,
  );

  // Commitment root with 1 real order
  const commitmentRoot = computeCommitmentRoot([commitment]);

  process.stderr.write(
    `[generateTestProof] Test order:\n` +
    `  amount=${amount}, limit_price=${limitPrice}\n` +
    `  commitment=${commitment}\n` +
    `  commitment_root=${commitmentRoot}\n`,
  );

  // Build circuit order arrays (1 real + 7 padding, MAX_ORDERS=8)
  const realOrder = {
    side:        0,
    amount:      amount.toString(),
    limit_price: limitPrice.toString(),
    salt:        hexToByteArray(salt, 32),
    is_padding:  false,
  };
  const paddingOrder = {
    side:        0,
    amount:      "0",
    limit_price: "0",
    salt:        Array(32).fill(0) as number[],
    is_padding:  true,
  };

  const orders = [realOrder, ...Array(CIRCUIT_MAX_ORDERS - 1).fill(paddingOrder)] as typeof realOrder[];

  // Commitment slots: first slot has the real commitment, rest are zero
  const commitmentSlots = [
    hexToByteArray(commitment, 32),
    ...Array(CIRCUIT_MAX_ORDERS - 1).fill(Array(32).fill(0)),
  ];

  const witnessInputs = {
    // Public inputs (must match BatchVault.settleBatch() expectations)
    commitment_root: hexToByteArray(commitmentRoot, 32),
    clearing_price:  clearingPrice.toString(),
    filled_yes_buy_vol:  amount.toString(),
    filled_no_buy_vol:   "0",
    filled_yes_sell_qty: "0",
    filled_no_sell_qty:  "0",
    order_count:     "1",
    // Private inputs
    market_id:   hexToByteArray(marketId, 32),
    orders,
    commitments: commitmentSlots,
  };

  // ── Initialise Barretenberg ────────────────────────────────────────────────
  const bbPath = process.env.BB_PATH ?? `${process.env.HOME}/.bb/bb`;
  process.stderr.write(`[generateTestProof] Loading Barretenberg (bbPath=${bbPath})...\n`);

  const api = await Barretenberg.new({ bbPath });
  const backend = new UltraHonkBackend(circuit.bytecode, api);
  const noir    = new Noir(circuit);

  // ── Execute circuit ────────────────────────────────────────────────────────
  process.stderr.write("[generateTestProof] Executing circuit (witness generation)...\n");
  let witness: Uint8Array;
  try {
    ({ witness } = await noir.execute(witnessInputs));
  } catch (err) {
    process.stderr.write(`[generateTestProof] Circuit execution failed: ${err}\n`);
    process.stderr.write("  Check that all witness inputs are consistent with circuit constraints.\n");
    await api.destroy();
    process.exit(1);
  }

  // ── Generate UltraHonk proof ───────────────────────────────────────────────
  // verifierTarget "evm" must match the flags used when generating BatchVerifier.sol:
  //   bb write_vk  -b target/batch_clearing.json -o target/vk  -t evm
  //   bb write_solidity_verifier -k target/vk/vk -o target/Verifier.sol -t evm
  process.stderr.write("[generateTestProof] Generating UltraHonk proof (evm target, may take 1-5 min)...\n");
  const proofData = await backend.generateProof(witness, { verifierTarget: "evm" });

  await api.destroy();

  const proofHex = ("0x" +
    Buffer.from(proofData.proof).toString("hex")) as `0x${string}`;

  // proofData.publicInputs: string[] — each is a hex-encoded Fr field element
  const publicInputsHex = (proofData.publicInputs as string[]).map(
    (pi) =>
      (pi.startsWith("0x") ? pi : "0x" + pi.padStart(64, "0")) as `0x${string}`,
  );

  process.stderr.write(
    `[generateTestProof] Done. Proof: ${proofData.proof.length} bytes, ` +
    `Public inputs: ${publicInputsHex.length}\n`,
  );

  // ── Encode for vm.ffi ──────────────────────────────────────────────────────
  // ABI-encode as (bytes proof, bytes32[] publicInputs).
  // Forge vm.ffi() reads stdout as raw bytes; abi.decode() in the test unpacks them.
  const encoded = encodeAbiParameters(
    [{ type: "bytes" }, { type: "bytes32[]" }],
    [proofHex, publicInputsHex],
  );

  // Write hex string to stdout.
  // Forge's vm.ffi() reads stdout as UTF-8: if prefixed with "0x" it hex-decodes the result
  // to bytes, which abi.decode() in the test then unpacks as (bytes proof, bytes32[] publicInputs).
  process.stdout.write(encoded);
}

main().catch((err: unknown) => {
  process.stderr.write(`[generateTestProof] Fatal error: ${err}\n`);
  process.exit(1);
});
