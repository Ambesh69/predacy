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
   * Public inputs layout (must match BatchVault.claimWithProof + circuit):
   *   [0] batchId            (uint256 as bytes32)
   *   [1] claimMerkleRoot    (bytes32)
   *   [2] clearingPrice      (uint256 as bytes32)
   *   [3] nullifier          (bytes32)
   *   [4] recipient          (address as bytes32)
   *   [5] fills              (bool: 1 or 0)
   *   [6] fillAmount         (uint256 as bytes32)
   *   [7] refundAmount       (uint256 as bytes32)
   *   [8] isBuy              (bool: 1 or 0)
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
    return [
      this._toBytes32(params.batchId),
      params.claimMerkleRoot,
      this._toBytes32(params.clearingPrice),
      params.nullifier,
      this._addressToBytes32(params.recipient),
      this._toBytes32(params.fills ? 1n : 0n),
      this._toBytes32(params.fillAmount),
      this._toBytes32(params.refundAmount),
      this._toBytes32(params.isBuy ? 1n : 0n),
    ];
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
      batch_id:        params.batchId.toString(),
      commitment_root: this._hexToBytes(params.claimMerkleRoot, 32),
      clearing_price:  params.clearingPrice.toString(),
      nullifier:       this._hexToBytes(
        keccak256(encodeAbiParameters(
          [{ type: "bytes32" }, { type: "uint256" }, { type: "bytes32" }],
          [commitment, params.batchId, params.salt],
        )),
        32,
      ),
      recipient:       this._hexToBytes(params.recipient, 20),
      fills:           params.limitPrice >= params.clearingPrice,
      fill_amount:     params.amount.toString(),
      refund_amount:   "0",
      is_buy_out:      params.isBuy,
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
