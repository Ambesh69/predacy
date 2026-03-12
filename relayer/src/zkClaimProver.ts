import { keccak256, encodeAbiParameters } from "viem";
import { BatchProcessor } from "./batchProcessor.js";
import { OrderSide } from "./types.js";

/**
 * ZK Claim Prover — generates proofs of order membership for private claims.
 *
 * The claim circuit proves (without revealing which leaf):
 *   1. The order preimage (marketId, side, amount, limitPrice, salt) hashes to a commitment
 *   2. That commitment is a leaf in the batch's Merkle tree (claimMerkleRoot)
 *   3. The nullifier is keccak256(commitment, batchId, salt) — prevents double-claim
 *   4. Fill calculation is correct given the clearing price and order side
 *
 * The relayer calls claimWithProof() on-chain with the proof + public inputs.
 * `msg.sender` = relayer (not the trader). Recipient = extracted from publicInputs[4] (field [6]).
 *
 * Mock mode (default): generates mock proof accepted by MockBatchVerifier.
 * Real mode: generates UltraHonk proof via Noir + Barretenberg (circuits/claim/).
 */

export interface ClaimProofParams {
  // On-chain batch context
  batchId:         bigint;
  claimMerkleRoot: `0x${string}`;
  clearingPrice:   bigint;

  // Order preimage (private — only the user knows the salt)
  marketId:    `0x${string}`;
  side:        OrderSide;  // YES_BUY=0, YES_SELL=1, NO_BUY=2, NO_SELL=3 (replaces isBuy)
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
   *   [8]  fillAmount           (USDC for BUY orders; token qty for SELL orders)
   *   [9]  refundAmount         (token qty refund for unfilled SELL; 0 otherwise)
   *   [10] side                 (uint8: 0=YES_BUY, 1=YES_SELL, 2=NO_BUY, 3=NO_SELL)
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
      side:            params.side,
    });

    if (this.useRealProver) {
      return await this._noirProve(params, commitment, merklePath, leafIndex, publicInputs);
    }

    // Mock proof — MockBatchVerifier (claimVerifier) accepts any proof bytes
    console.log("[ZKClaimProver] Using mock proof (prototype mode)");
    return { proof: "0x", publicInputs };
  }

  /** Mirror BatchVault v8 commitment hash: keccak256(marketId, uint8(side), amount, limitPrice, salt) */
  private _computeCommitment(params: ClaimProofParams): `0x${string}` {
    return keccak256(
      encodeAbiParameters(
        [
          { type: "bytes32" },
          { type: "uint8"   }, // OrderSide enum (v8: replaces bool isBuy from v7.3)
          { type: "uint256" },
          { type: "uint256" },
          { type: "bytes32" },
        ],
        [params.marketId, params.side, params.amount, params.limitPrice, params.salt],
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

  /**
   * Compute fill result for a 4-sided order at the batch clearing price.
   * Mirrors BatchVault._assignPositions() and _executePayout().
   *
   * fillAmount semantics:
   *   YES_BUY:  USDC amount filled (vault converts to YES tokens at claim time)
   *   NO_BUY:   USDC amount filled (vault converts to NO tokens at claim time)
   *   YES_SELL: YES token qty filled (vault pays USDC at clearing price at claim time)
   *   NO_SELL:  NO token qty filled (vault pays USDC at noPrice at claim time)
   */
  private _computeFill(params: ClaimProofParams): {
    fills:        boolean;
    fillAmount:   bigint;
    refundAmount: bigint;
  } {
    const { side, amount, limitPrice, clearingPrice } = params;
    const noPrice = 1_000_000n - clearingPrice;

    let fills: boolean;
    switch (side) {
      case OrderSide.YES_BUY:  fills = limitPrice >= clearingPrice; break;
      case OrderSide.YES_SELL: fills = limitPrice <= clearingPrice; break;
      case OrderSide.NO_BUY:   fills = limitPrice >= noPrice;       break;
      case OrderSide.NO_SELL:  fills = limitPrice <= noPrice;       break;
    }

    if (!fills) {
      // Unfilled:
      //   BUY  orders: EIP-3009 deferred — no USDC deposited → nothing to refund
      //   SELL orders: tokens pre-deposited → refund the token qty
      const isSell = side === OrderSide.YES_SELL || side === OrderSide.NO_SELL;
      return { fills: false, fillAmount: 0n, refundAmount: isSell ? amount : 0n };
    }

    // fillAmount = USDC amount for BUY orders, token qty for SELL orders
    // The actual token/USDC conversion happens in the contract's _executePayout()
    return { fills: true, fillAmount: amount, refundAmount: 0n };
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
    side:            OrderSide;
  }): `0x${string}`[] {
    const [rootHi, rootLo] = this._splitBytes32(params.claimMerkleRoot);
    const [nullHi, nullLo] = this._splitBytes32(params.nullifier);
    return [
      this._toBytes32(params.batchId),              // [0]  batch_id
      rootHi,                                        // [1]  commitment_root_hi
      rootLo,                                        // [2]  commitment_root_lo
      this._toBytes32(params.clearingPrice),         // [3]  clearing_price
      nullHi,                                        // [4]  nullifier_hi
      nullLo,                                        // [5]  nullifier_lo
      this._addressToBytes32(params.recipient),      // [6]  recipient (Field)
      this._toBytes32(params.fills ? 1n : 0n),      // [7]  fills
      this._toBytes32(params.fillAmount),            // [8]  fill_amount
      this._toBytes32(params.refundAmount),          // [9]  refund_amount
      this._toBytes32(BigInt(params.side)),          // [10] side (0-3, v8: replaces is_buy)
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
   *
   * NOTE: The Noir claim circuit needs to be updated for v8 (side: u8 instead of is_buy: bool).
   * The relayer's mock prover path works now; real ZK is pending circuit update.
   */
  private async _noirProve(
    params:      ClaimProofParams,
    commitment:  `0x${string}`,
    merklePath:  `0x${string}`[],
    leafIndex:   number,
    publicInputs: `0x${string}`[],
  ): Promise<ClaimProofOutput> {
    const { Noir }                   = await import("@noir-lang/noir_js");
    const { Barretenberg, UltraHonkBackend, BackendType } = await import("@aztec/bb.js");
    const { createRequire }          = await import("module");
    const _require                   = createRequire(import.meta.url);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const circuit                    = _require("../circuits/claim.json") as any;

    // Probe bundled bb binary — detect glibc mismatch before the socket backend tries it.
    // Falls back to WASM if the binary exits with code 1 (missing glibc symbols).
    let nativeBinOk = false;
    {
      const nodePath = await import("path");
      const nodeFs   = await import("fs");
      const nodeOs   = await import("os");
      const { execFileSync } = await import("child_process");
      const _req = createRequire(import.meta.url);
      const bbJsMain = _req.resolve("@aztec/bb.js");
      const pkgRoot  = nodePath.default.resolve(bbJsMain, "../../..");
      const archMap: Record<string, string> = {
        "x64-linux":    "amd64-linux",
        "arm64-linux":  "arm64-linux",
        "x64-darwin":   "amd64-macos",
        "arm64-darwin": "arm64-macos",
      };
      const platformKey = `${nodeOs.default.arch() === "x64" ? "x64" : nodeOs.default.arch()}-${nodeOs.default.platform()}`;
      const buildDir    = archMap[platformKey];
      const bbBin       = buildDir ? nodePath.default.join(pkgRoot, "build", buildDir, "bb") : null;
      console.log(`[ZKClaimProver] platform=${platformKey} bbBin=${bbBin ?? "N/A"}`);
      if (bbBin && nodeFs.default.existsSync(bbBin)) {
        try {
          const ver = execFileSync(bbBin, ["--version"], { encoding: "utf8", timeout: 5000 }).trim();
          console.log(`[ZKClaimProver] bb --version ok: ${ver} — using native backend`);
          nativeBinOk = true;
        } catch (e: any) {
          console.error(`[ZKClaimProver] bb --version FAILED (exit ${e.status}): ${(e.stderr ?? e.message ?? "").slice(0, 400)}`);
          console.warn("[ZKClaimProver] Native bb binary unusable — falling back to WASM backend");
        }
      } else {
        console.warn(`[ZKClaimProver] bundled bb binary not found — using WASM backend`);
      }
    }

    console.log(`[ZKClaimProver] Initialising Barretenberg (${nativeBinOk ? "native" : "WASM"})...`);
    const bbLogger = (msg: string) => console.log(`[bb-claim] ${msg}`);
    const api = await Barretenberg.new({
      ...(nativeBinOk ? {} : { backend: BackendType.Wasm }),
      logger: bbLogger,
    });
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
      side:         params.side,          // uint8 (v8: replaces is_buy bool)
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
      side_out:           params.side,    // uint8 (v8: replaces is_buy_out bool)
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
