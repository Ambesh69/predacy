import { keccak256, encodeAbiParameters } from "viem";
import type { Order } from "./types.js";

/**
 * ZK Prover — generates proofs of correct batch clearing price computation.
 *
 * Production: calls the Noir prover (bb.js) to generate an UltraPlonk proof.
 * The circuit proves:
 *   1. Each revealed order pre-image matches its on-chain commitment hash
 *   2. The clearing price maximizes filled volume (correct algorithm execution)
 *   3. The reported net buy amount matches the actual computation
 *
 * Prototype: generates a mock proof (empty bytes).
 * MockBatchVerifier on-chain accepts any proof — swap in the real Noir verifier
 * once the circuit is compiled (cd circuits/batch_clearing && nargo build).
 */

export interface ProofInputs {
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

export class ZKProver {
  private useRealProver: boolean;

  constructor(useRealProver = false) {
    this.useRealProver = useRealProver;
  }

  /**
   * Generate a ZK proof of correct batch clearing computation.
   *
   * Public inputs (matching BatchVault.sol's settleBatch expectations):
   *   [0] commitmentRoot   - sequential hash chain of all commitments
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
   * Real Noir prover integration (implement when circuit is compiled).
   * Uses @noir-lang/backend_barretenberg and @noir-lang/noir_js.
   */
  private async _noirProve(
    _inputs: ProofInputs,
    _commitmentRoot: `0x${string}`,
    _publicInputs: `0x${string}`[],
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
