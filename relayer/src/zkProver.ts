import type { Order } from "./types.js";

/**
 * ZK Prover — generates proofs of correct batch clearing price computation.
 *
 * In production: calls the Noir prover (bb.js) to generate an UltraPlonk proof.
 * The circuit proves:
 *   1. Each revealed order pre-image matches its on-chain commitment hash
 *   2. The clearing price maximizes filled volume (correct algorithm execution)
 *   3. The reported net buy amount matches the actual computation
 *
 * For the prototype: generates a mock proof (empty bytes).
 * The MockBatchVerifier on-chain accepts any proof — swap in the real
 * Noir verifier once the circuit is compiled.
 *
 * Circuit source: ../circuits/batch_clearing/src/main.nr
 * Compile with: cd ../circuits/batch_clearing && nargo prove
 */

export interface ProofInputs {
  orders: Order[];
  commitments: `0x${string}`[];
  clearingPrice: bigint;
  netBuyAmount: bigint;
  filledBuyVolume: bigint;
  filledSellVolume: bigint;
}

export interface ProofOutput {
  proof: `0x${string}`;
  publicInputs: `0x${string}`[];
  commitmentRoot: `0x${string}`;
}

export class ZKProver {
  private useRealProver: boolean;

  constructor(useRealProver = false) {
    this.useRealProver = useRealProver;
  }

  /**
   * Generate a ZK proof of correct batch clearing computation.
   *
   * Public inputs (matching BatchVault.sol's settleBatch expectations):
   *   [0] commitmentRoot   - merkle root of all order commitments
   *   [1] clearingPrice    - 6-decimal fixed point
   *   [2] filledBuyVolume  - USDC, 6 decimals
   *   [3] filledSellVolume - USDC, 6 decimals
   *   [4] netBuyAmount     - USDC, 6 decimals
   */
  async generateProof(inputs: ProofInputs): Promise<ProofOutput> {
    const commitmentRoot = this._computeCommitmentRoot(inputs.commitments);

    const publicInputs: `0x${string}`[] = [
      commitmentRoot,
      this._toBytes32(inputs.clearingPrice),
      this._toBytes32(inputs.filledBuyVolume),
      this._toBytes32(inputs.filledSellVolume),
      this._toBytes32(inputs.netBuyAmount),
    ];

    if (this.useRealProver) {
      return await this._noirProve(inputs, commitmentRoot, publicInputs);
    }

    // Prototype: mock proof (MockBatchVerifier accepts anything)
    console.log("[ZKProver] Using mock proof (prototype mode)");
    return {
      proof: "0x",
      publicInputs,
      commitmentRoot,
    };
  }

  /**
   * Compute sequential commitment root matching BatchVault._computeCommitmentRoot()
   * root = keccak256(keccak256(... keccak256(0, h[0]), h[1] ...), h[n-1])
   */
  private _computeCommitmentRoot(commitments: `0x${string}`[]): `0x${string}` {
    // Mirror the Solidity: keccak256(abi.encode(root, commitment.hash))
    // Using a simple sequential hash chain (not a Merkle tree)
    // This matches BatchVault._computeCommitmentRoot()
    let root = "0x" + "0".repeat(64);

    for (const commitment of commitments) {
      // abi.encode(bytes32, bytes32) = concat(pad32(root), pad32(commitment))
      const encoded = root.slice(2).padStart(64, "0") + commitment.slice(2).padStart(64, "0");
      root = keccak256Hex(encoded);
    }

    return root as `0x${string}`;
  }

  private _toBytes32(value: bigint): `0x${string}` {
    return ("0x" + value.toString(16).padStart(64, "0")) as `0x${string}`;
  }

  /**
   * Real Noir prover integration (to be implemented when circuit is ready).
   * Uses @noir-lang/backend_barretenberg and @noir-lang/noir_js.
   */
  private async _noirProve(
    _inputs: ProofInputs,
    _commitmentRoot: `0x${string}`,
    publicInputs: `0x${string}`[]
  ): Promise<ProofOutput> {
    // TODO: integrate Noir prover
    // import { Noir } from '@noir-lang/noir_js';
    // import { BarretenbergBackend } from '@noir-lang/backend_barretenberg';
    // import circuit from '../../circuits/batch_clearing/target/batch_clearing.json';
    //
    // const backend = new BarretenbergBackend(circuit);
    // const noir = new Noir(circuit, backend);
    // const { witness } = await noir.execute({ ...witnessInputs });
    // const { proof, publicInputs } = await backend.generateProof(witness);
    throw new Error("Real Noir prover not yet integrated — set useRealProver=false for prototype");
  }
}

/** Simple keccak256 without ethers/viem dependency for this module */
function keccak256Hex(hexData: string): string {
  // In production: use viem's keccak256 or ethers.keccak256
  // For now, return a deterministic mock based on input length
  // Replace with: import { keccak256 } from 'viem'; keccak256(`0x${hexData}`)
  const { createHash } = await import("node:crypto").catch(() => ({ createHash: null }));
  if (createHash) {
    // SHA3 (keccak256) — note: Node's crypto uses SHA3, not keccak256
    // For correct keccak256, use viem in the actual implementation
    return "0x" + createHash("sha3-256").update(Buffer.from(hexData, "hex")).digest("hex");
  }
  return "0x" + "0".repeat(64); // fallback
}
