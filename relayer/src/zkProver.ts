import { keccak256, encodeAbiParameters } from "viem";
import type { Order } from "./types.js";

/**
 * ZK Prover — generates proofs of correct batch clearing price computation.
 *
 * Production: calls the Noir prover (bb.js) to generate an UltraHonk proof.
 * The circuit proves:
 *   1. Each revealed order pre-image matches its on-chain commitment hash
 *   2. The clearing price maximizes filled volume (correct algorithm execution)
 *   3. The reported net buy amount matches the actual computation
 *
 * Prototype: generates a mock proof (empty bytes).
 * MockBatchVerifier on-chain accepts any proof — set USE_REAL_ZK=true in .env
 * to enable real proof generation with the HonkVerifier.
 */

export interface ProofInputs {
  marketId:         `0x${string}`;   // 32-byte market condition ID
  orders:           Order[];
  commitments:      `0x${string}`[];
  clearingPrice:    bigint;
  netBuyAmount:     bigint;
  filledBuyVolume:  bigint;
  filledSellVolume: bigint;
}

export interface ProofOutput {
  proof:        `0x${string}`;
  publicInputs: `0x${string}`[];
  commitmentRoot: `0x${string}`;
}

// Must match global MAX_ORDERS in circuits/batch_clearing/src/main.nr
const CIRCUIT_MAX_ORDERS = 8;

export class ZKProver {
  private useRealProver: boolean;

  constructor(useRealProver = false) {
    this.useRealProver = useRealProver;
  }

  /**
   * Generate a ZK proof of correct batch clearing computation.
   *
   * Public inputs (matching BatchVault.sol's settleBatch expectations):
   *   [0..31] commitmentRoot bytes  - sequential hash chain of all commitments
   *   [32]    clearingPrice         - 6-decimal fixed point
   *   [33]    filledBuyVolume       - USDC, 6 decimals
   *   [34]    filledSellVolume      - USDC, 6 decimals
   *   [35]    netBuyAmount          - USDC, 6 decimals
   *   [36]    order_count
   *   [37..52] pairing points       - appended by UltraHonk EVM verifier
   */
  async generateProof(inputs: ProofInputs): Promise<ProofOutput> {
    const commitmentRoot = this._computeCommitmentRoot(inputs.commitments);

    if (this.useRealProver) {
      return await this._noirProve(inputs, commitmentRoot);
    }

    // Prototype: mock proof (MockBatchVerifier accepts anything)
    console.log("[ZKProver] Using mock proof (prototype mode)");
    const publicInputs: `0x${string}`[] = [
      commitmentRoot,
      this._toBytes32(inputs.clearingPrice),
      this._toBytes32(inputs.filledBuyVolume),
      this._toBytes32(inputs.filledSellVolume),
      this._toBytes32(inputs.netBuyAmount),
    ];
    return {
      proof: "0x",
      publicInputs,
      commitmentRoot,
    };
  }

  /**
   * Compute sequential commitment root matching BatchVault._computeCommitmentRoot():
   *   root = keccak256(abi.encode(... keccak256(abi.encode(0, h[0])), h[1] ...), h[n-1])
   */
  private _computeCommitmentRoot(commitments: `0x${string}`[]): `0x${string}` {
    let root = ("0x" + "0".repeat(64)) as `0x${string}`;

    for (const commitment of commitments) {
      // Mirror Solidity: keccak256(abi.encode(bytes32 root, bytes32 commitment))
      root = keccak256(
        encodeAbiParameters(
          [{ type: "bytes32" }, { type: "bytes32" }],
          [root, commitment],
        ),
      );
    }

    return root;
  }

  private _toBytes32(value: bigint): `0x${string}` {
    return ("0x" + value.toString(16).padStart(64, "0")) as `0x${string}`;
  }

  /**
   * Convert a 0x-prefixed hex string to an array of byte values (numbers 0-255).
   * Handles both 20-byte addresses and 32-byte hashes.
   */
  private _hexToBytes(hex: `0x${string}`, expectedLen: number): number[] {
    const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
    const padded = clean.padStart(expectedLen * 2, "0");
    const bytes: number[] = [];
    for (let i = 0; i < expectedLen; i++) {
      bytes.push(parseInt(padded.slice(i * 2, i * 2 + 2), 16));
    }
    return bytes;
  }

  /**
   * Real Noir prover integration -- UltraHonk via @aztec/bb.js + @noir-lang/noir_js.
   *
   * Circuit: circuits/batch_clearing/src/main.nr
   * Compiled: circuits/batch_clearing/target/batch_clearing.json
   * Verifier: contracts/src/BatchVerifier.sol (HonkVerifier)
   *
   * Proof generation is compute-heavy (~10-60s depending on hardware).
   * Runs in the relayer process after the batch window closes.
   */
  private async _noirProve(
    inputs: ProofInputs,
    commitmentRoot: `0x${string}`,
  ): Promise<ProofOutput> {
    // Dynamic imports to avoid loading large WASM modules unless needed
    const { Noir } = await import("@noir-lang/noir_js");
    const { Barretenberg, UltraHonkBackend } = await import("@aztec/bb.js");

    // Load compiled circuit JSON (ESM-compatible require)
    const { createRequire } = await import("module");
    const _require = createRequire(import.meta.url);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    // Path is relative to relayer/src/ — circuit JSON lives in relayer/circuits/
    // so it's accessible on Railway (which only mounts the relayer/ root dir).
    const circuit = _require("../circuits/batch_clearing.json") as any;

    console.log("[ZKProver] Initialising Barretenberg backend...");
    // Use the native bb binary when available (much faster than WASM fallback)
    const bbPath = process.env.BB_PATH ?? `${process.env.HOME}/.bb/bb`;
    const api = await Barretenberg.new({ bbPath });

    const backend = new UltraHonkBackend(circuit.bytecode, api);
    const noir    = new Noir(circuit);

    // -- Build witness inputs ------------------------------------------------
    const paddingOrder = {
      trader:      Array(20).fill(0) as number[],
      is_buy:      false,
      amount:      "0",
      limit_price: "0",
      salt:        Array(32).fill(0) as number[],
      is_padding:  true,
    };

    const orderCount = inputs.orders.length;

    // Pad orders array to MAX_ORDERS=64
    const circuitOrders: typeof paddingOrder[] = inputs.orders.map((o) => ({
      trader:      this._hexToBytes(o.trader as `0x${string}`, 20),
      is_buy:      o.isBuy,
      amount:      o.amount.toString(),
      limit_price: o.limitPrice.toString(),
      salt:        this._hexToBytes(o.salt as `0x${string}`, 32),
      is_padding:  false,
    }));
    while (circuitOrders.length < CIRCUIT_MAX_ORDERS) {
      circuitOrders.push({ ...paddingOrder });
    }

    // Pad commitments array to MAX_ORDERS=64 with zero hashes
    const circuitCommitments: number[][] = inputs.commitments.map((c) =>
      this._hexToBytes(c, 32),
    );
    while (circuitCommitments.length < CIRCUIT_MAX_ORDERS) {
      circuitCommitments.push(Array(32).fill(0));
    }

    const witnessInputs = {
      // Public inputs (must match circuit signature order)
      commitment_root: this._hexToBytes(commitmentRoot, 32),
      clearing_price:  inputs.clearingPrice.toString(),
      total_buy_vol:   inputs.filledBuyVolume.toString(),
      total_sell_vol:  inputs.filledSellVolume.toString(),
      net_buy_amount:  inputs.netBuyAmount.toString(),
      order_count:     orderCount.toString(),
      // Private inputs (witness -- never revealed on-chain)
      market_id:   this._hexToBytes(inputs.marketId, 32),
      orders:      circuitOrders,
      commitments: circuitCommitments,
    };

    // -- Execute circuit (generates witness) ----------------------------------
    console.log(`[ZKProver] Executing circuit for ${orderCount} orders...`);
    const { witness } = await noir.execute(witnessInputs);

    // -- Generate UltraHonk proof ---------------------------------------------
    // verifierTarget 'evm' must match the flags used for bb write_vk and
    // bb write_solidity_verifier when generating contracts/src/BatchVerifier.sol.
    console.log("[ZKProver] Generating UltraHonk proof (evm target)...");
    const proofData = await backend.generateProof(witness, {
      verifierTarget: "evm",
    });

    await api.destroy();

    // -- Format outputs for on-chain HonkVerifier.verify() -------------------
    // proofData.proof        = raw proof bytes (Uint8Array)
    // proofData.publicInputs = 53 hex strings (37 circuit inputs + 16 pairing points)
    const proofHex = ("0x" +
      Buffer.from(proofData.proof).toString("hex")) as `0x${string}`;

    const publicInputsHex = proofData.publicInputs.map(
      (pi) =>
        (pi.startsWith("0x")
          ? pi
          : "0x" + pi.padStart(64, "0")) as `0x${string}`,
    );

    console.log(
      `[ZKProver] Proof generated. Size: ${proofData.proof.length} bytes, ` +
      `Public inputs: ${publicInputsHex.length}`,
    );

    return {
      proof: proofHex,
      publicInputs: publicInputsHex,
      commitmentRoot,
    };
  }
}
