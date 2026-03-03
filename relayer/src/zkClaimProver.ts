import { keccak256, encodeAbiParameters } from "viem";
import { BatchProcessor } from "./batchProcessor.js";

/**
 * ZK Claim Prover — generates proofs of order membership for private claims.
 *
 * The claim circuit proves (without revealing which leaf):
 *   1. The order preimage (marketId, isBuy, amount, limitPrice, salt) hashes to a commitment
 *   2. That commitment is a leaf in the batch's Merkle tree (claimMerkleRoot)
 *   3. The nullifier is keccak256(commitment, batchId, salt) — prevents double-claim
 *   4. Fill calculation is correct given the clearing price
 *
 * The relayer calls claimWithProof() on-chain with the proof + public inputs.
 * `msg.sender` = relayer (not the trader). Recipient = extracted from publicInputs[4].
 *
 * Mock mode (default): generates mock proof accepted by MockBatchVerifier.
 * Real mode: generates UltraHonk proof via Noir + Barretenberg (circuits/claim/).
 */

export interface ClaimProofParams {
  // On-chain batch context
  batchId:         bigint;
  claimMerkleRoot: `0x${string}`;
  clearingPrice:   bigint;
  totalFilledBuyVol: bigint;
  yesTokensReceived: bigint;
  filledSellYes:   bigint;

  // Order preimage (private — only the user knows the salt)
  marketId:    `0x${string}`;
  isBuy:       boolean;
  amount:      bigint;
  limitPrice:  bigint;
  salt:        `0x${string}`;

  // All commitment hashes in the batch (to build Merkle path)
  allCommitments: `0x${string}`[];

  // Recipient of the payout
  recipient: `0x${string}`;
}

export interface ClaimProofOutput {
  proof:        `0x${string}`;
  publicInputs: `0x${string}`[];
}

const ZERO_BYTES32 = ("0x" + "0".repeat(64)) as `0x${string}`;

// Must match `global DEPTH: u32 = 9` in circuits/claim/src/main.nr (supports 512 orders)
const CLAIM_CIRCUIT_DEPTH = 9;

export class ZKClaimProver {
  private useRealProver: boolean;

  constructor(useRealProver = false) {
    this.useRealProver = useRealProver;
  }

  /**
   * Generate a ZK claim proof for an order.
   *
   * Public inputs layout (must match BatchVault.claimWithProof + circuit, 11 field elements):
   *   [0]  batchId              (u64 as bytes32)
   *   [1]  commitment_root_hi   (high 128 bits of claimMerkleRoot)
   *   [2]  commitment_root_lo   (low  128 bits of claimMerkleRoot)
   *   [3]  clearingPrice        (u64 as bytes32)
   *   [4]  nullifier_hi         (high 128 bits of nullifier)
   *   [5]  nullifier_lo         (low  128 bits of nullifier)
   *   [6]  recipient            (address as bytes32, Field element)
   *   [7]  fills                (bool: 1 or 0)
   *   [8]  fillAmount           (u64 as bytes32)
   *   [9]  refundAmount         (u64 as bytes32)
   *   [10] isBuy                (bool: 1 or 0)
   *
   * bytes32 values (keccak256 hashes) are split into two u128 halves because
   * a full 256-bit value may exceed the BN254 scalar field (~254 bits).
   * Contract reconstructs: bytes32((uint256(hi) << 128) | uint256(lo))
   */
  async generateProof(params: ClaimProofParams): Promise<ClaimProofOutput> {
    // 1. Compute commitment from preimage
    const commitment = this._computeCommitment(params);

    // 2. Find leaf index in the batch's commitment array
    const leafIndex = params.allCommitments.findIndex(
      (c) => c.toLowerCase() === commitment.toLowerCase(),
    );
    if (leafIndex === -1) {
      throw new Error(
        `Commitment ${commitment} not found in batch commitments (${params.allCommitments.length} entries)`,
      );
    }

    // 3. Build Merkle path
    const merklePath = BatchProcessor.getMerklePath(params.allCommitments, leafIndex);

    // 4. Compute nullifier
    const nullifier = this._computeNullifier(commitment, params.batchId, params.salt);

    // 5. Compute fill result
    const { fills, fillAmount, refundAmount } = this._computeFill(params);

    // 6. Build public inputs array
    const publicInputs = this._buildPublicInputs({
      batchId:         params.batchId,
      claimMerkleRoot: params.claimMerkleRoot,
      clearingPrice:   params.clearingPrice,
      nullifier,
      recipient:       params.recipient,
      fills,
      fillAmount,
      refundAmount,
      isBuy:           params.isBuy,
    });

    if (this.useRealProver) {
      return await this._noirProve(params, commitment, merklePath, leafIndex, publicInputs);
    }

    // Mock proof — MockBatchVerifier (claimVerifier) accepts any proof bytes
    console.log("[ZKClaimProver] Using mock proof (prototype mode)");
    return { proof: "0x", publicInputs };
  }

  /** Mirror BatchVault commitment hash (no trader address) */
  private _computeCommitment(params: ClaimProofParams): `0x${string}` {
    return keccak256(
      encodeAbiParameters(
        [
          { type: "bytes32" },
          { type: "bool"    },
          { type: "uint256" },
          { type: "uint256" },
          { type: "bytes32" },
        ],
        [params.marketId, params.isBuy, params.amount, params.limitPrice, params.salt],
      ),
    );
  }

  /** Mirror BatchVault nullifier: keccak256(abi.encode(commitment, batchId, salt)) */
  private _computeNullifier(
    commitment: `0x${string}`,
    batchId: bigint,
    salt: `0x${string}`,
  ): `0x${string}` {
    return keccak256(
      encodeAbiParameters(
        [{ type: "bytes32" }, { type: "uint256" }, { type: "bytes32" }],
        [commitment, batchId, salt],
      ),
    );
  }

  /** Compute fill result for this order at the batch clearing price */
  private _computeFill(params: ClaimProofParams): {
    fills:        boolean;
    fillAmount:   bigint;
    refundAmount: bigint;
  } {
    const { isBuy, amount, limitPrice, clearingPrice } = params;

    const fills = isBuy
      ? limitPrice >= clearingPrice
      : limitPrice <= clearingPrice;

    if (!fills) {
      // Unfilled: buy orders had no USDC deposited (EIP-3009 deferred model — nothing to refund)
      //           sell orders get YES tokens returned
      return {
        fills:        false,
        fillAmount:   0n,
        refundAmount: isBuy ? 0n : amount,  // sell: refund YES tokens
      };
    }

    if (isBuy) {
      // Filled buy: user gets proportional YES tokens
      // fillAmount = USDC amount committed (used to compute yesShares in contract)
      return { fills: true, fillAmount: amount, refundAmount: 0n };
    } else {
      // Filled sell: user gets USDC = amount * clearingPrice / 1_000_000
      const usdcPayout = (amount * clearingPrice) / 1_000_000n;
      return { fills: true, fillAmount: usdcPayout, refundAmount: 0n };
    }
  }

  private _buildPublicInputs(params: {
    batchId:         bigint;
    claimMerkleRoot: `0x${string}`;
    clearingPrice:   bigint;
    nullifier:       `0x${string}`;
    recipient:       `0x${string}`;
    fills:           boolean;
    fillAmount:      bigint;
    refundAmount:    bigint;
    isBuy:           boolean;
  }): `0x${string}`[] {
    const [rootHi, rootLo] = this._splitBytes32(params.claimMerkleRoot);
    const [nullHi, nullLo] = this._splitBytes32(params.nullifier);
    return [
      this._toBytes32(params.batchId),       // [0]  batch_id
      rootHi,                                // [1]  commitment_root_hi
      rootLo,                                // [2]  commitment_root_lo
      this._toBytes32(params.clearingPrice), // [3]  clearing_price
      nullHi,                                // [4]  nullifier_hi
      nullLo,                                // [5]  nullifier_lo
      this._addressToBytes32(params.recipient), // [6]  recipient (Field)
      this._toBytes32(params.fills ? 1n : 0n),  // [7]  fills
      this._toBytes32(params.fillAmount),    // [8]  fill_amount
      this._toBytes32(params.refundAmount),  // [9]  refund_amount
      this._toBytes32(params.isBuy ? 1n : 0n),  // [10] is_buy_out
    ];
  }

  /** Split a bytes32 hex string into [hi, lo] u128 parts (each right-aligned in bytes32). */
  private _splitBytes32(hex: `0x${string}`): [`0x${string}`, `0x${string}`] {
    const clean = (hex.startsWith("0x") ? hex.slice(2) : hex).padStart(64, "0");
    const hi = ("0x" + "0".repeat(32) + clean.slice(0, 32)) as `0x${string}`;
    const lo = ("0x" + "0".repeat(32) + clean.slice(32, 64)) as `0x${string}`;
    return [hi, lo];
  }

  private _toBytes32(value: bigint): `0x${string}` {
    return ("0x" + value.toString(16).padStart(64, "0")) as `0x${string}`;
  }

  private _addressToBytes32(addr: `0x${string}`): `0x${string}` {
    const clean = addr.startsWith("0x") ? addr.slice(2) : addr;
    return ("0x" + clean.padStart(64, "0")) as `0x${string}`;
  }

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
   * Real Noir prover integration — UltraHonk via @aztec/bb.js + @noir-lang/noir_js.
   *
   * Circuit: circuits/claim/src/main.nr
   * Compiled: circuits/claim/target/claim.json
   */
  private async _noirProve(
    params:      ClaimProofParams,
    commitment:  `0x${string}`,
    merklePath:  `0x${string}`[],
    leafIndex:   number,
    publicInputs: `0x${string}`[],
  ): Promise<ClaimProofOutput> {
    const { Noir }                   = await import("@noir-lang/noir_js");
    const { Barretenberg, UltraHonkBackend } = await import("@aztec/bb.js");
    const { createRequire }          = await import("module");
    const _require                   = createRequire(import.meta.url);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const circuit                    = _require("../../circuits/claim/target/claim.json") as any;

    const bbPath = process.env.BB_PATH ?? `${process.env.HOME}/.bb/bb`;
    const api    = await Barretenberg.new({ bbPath });
    const backend = new UltraHonkBackend(circuit.bytecode, api);
    const noir    = new Noir(circuit);

    // Pad Merkle path to CLAIM_CIRCUIT_DEPTH siblings
    const paddedPath = [...merklePath];
    while (paddedPath.length < CLAIM_CIRCUIT_DEPTH) {
      paddedPath.push(ZERO_BYTES32);
    }

    const { fills, fillAmount, refundAmount } = this._computeFill(params);

    const nullifierHex = keccak256(encodeAbiParameters(
      [{ type: "bytes32" }, { type: "uint256" }, { type: "bytes32" }],
      [commitment, params.batchId, params.salt],
    ));

    // Split bytes32 values into u128 hi/lo pairs for circuit public inputs
    const rootVal   = BigInt(params.claimMerkleRoot);
    const nullVal   = BigInt(nullifierHex);
    const mask128   = (1n << 128n) - 1n;

    const witnessInputs = {
      // Private inputs
      market_id:    this._hexToBytes(params.marketId, 32),
      is_buy:       params.isBuy,
      amount:       params.amount.toString(),
      limit_price:  params.limitPrice.toString(),
      salt:         this._hexToBytes(params.salt, 32),
      merkle_path:  paddedPath.map((h) => this._hexToBytes(h as `0x${string}`, 32)),
      leaf_index:   leafIndex.toString(),
      // Public outputs (circuit asserts these match computed values)
      batch_id:           params.batchId.toString(),
      commitment_root_hi: (rootVal >> 128n).toString(),
      commitment_root_lo: (rootVal & mask128).toString(),
      clearing_price:     params.clearingPrice.toString(),
      nullifier_hi:       (nullVal >> 128n).toString(),
      nullifier_lo:       (nullVal & mask128).toString(),
      recipient:          BigInt(params.recipient).toString(),
      fills,
      fill_amount:        fillAmount.toString(),
      refund_amount:      refundAmount.toString(),
      is_buy_out:         params.isBuy,
    };

    console.log("[ZKClaimProver] Executing claim circuit...");
    const { witness } = await noir.execute(witnessInputs);

    console.log("[ZKClaimProver] Generating UltraHonk claim proof (evm target)...");
    const proofData = await backend.generateProof(witness, { verifierTarget: "evm" });

    await api.destroy();

    const proofHex = ("0x" + Buffer.from(proofData.proof).toString("hex")) as `0x${string}`;
    const publicInputsHex = proofData.publicInputs.map(
      (pi) => (pi.startsWith("0x") ? pi : "0x" + pi.padStart(64, "0")) as `0x${string}`,
    );

    console.log(`[ZKClaimProver] Claim proof generated. Size: ${proofData.proof.length} bytes`);
    return { proof: proofHex, publicInputs: publicInputsHex };
  }
}
