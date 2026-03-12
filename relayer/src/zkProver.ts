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
  filledYesBuyVol:  bigint; // USDC from filled YES_BUY orders
  filledNoBuyVol:   bigint; // USDC from filled NO_BUY orders
  filledYesSellQty: bigint; // YES tokens from filled YES_SELL orders
  filledNoSellQty:  bigint; // NO tokens from filled NO_SELL orders
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
    // Public inputs match BatchVault v8 settleBatch() publicInputs[0..5]:
    //   [0] commitmentRoot, [1] clearingPrice, [2] filledYesBuyVol,
    //   [3] filledNoBuyVol, [4] filledYesSellQty, [5] filledNoSellQty
    console.log("[ZKProver] Using mock proof (prototype mode)");
    const publicInputs: `0x${string}`[] = [
      commitmentRoot,
      this._toBytes32(inputs.clearingPrice),
      this._toBytes32(inputs.filledYesBuyVol),
      this._toBytes32(inputs.filledNoBuyVol),
      this._toBytes32(inputs.filledYesSellQty),
      this._toBytes32(inputs.filledNoSellQty),
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

    // Probe the bundled bb binary before attempting a proof so we get a clear
    // error in the logs rather than a silent "exit code 1" from the socket backend.
    {
      const nodePath = await import("path");
      const nodeFs   = await import("fs");
      const nodeOs   = await import("os");
      const { execFileSync } = await import("child_process");
      const { createRequire } = await import("module");
      const _req = createRequire(import.meta.url);
      // Locate the @aztec/bb.js package root via its package.json
      const pkgJsonPath = _req.resolve("@aztec/bb.js/package.json");
      const pkgRoot     = nodePath.default.dirname(pkgJsonPath);
      const archMap: Record<string, string> = {
        "x64-linux":    "amd64-linux",
        "arm64-linux":  "arm64-linux",
        "x64-darwin":   "amd64-macos",
        "arm64-darwin": "arm64-macos",
      };
      const platformKey = `${nodeOs.default.arch() === "x64" ? "x64" : nodeOs.default.arch()}-${nodeOs.default.platform()}`;
      const buildDir    = archMap[platformKey];
      const bbBin       = buildDir ? nodePath.default.join(pkgRoot, "build", buildDir, "bb") : null;
      console.log(`[ZKProver] platform=${platformKey} buildDir=${buildDir ?? "UNKNOWN"} bbBin=${bbBin ?? "N/A"}`);
      if (bbBin && nodeFs.default.existsSync(bbBin)) {
        try {
          const ver = execFileSync(bbBin, ["--version"], { encoding: "utf8", timeout: 5000 }).trim();
          console.log(`[ZKProver] bb --version ok: ${ver}`);
        } catch (e: any) {
          console.error(`[ZKProver] bb --version FAILED (exit ${e.status}): ${(e.stderr ?? e.message ?? "").slice(0, 400)}`);
        }
      } else {
        console.warn(`[ZKProver] bundled bb binary not found — Barretenberg.new() will fall back to WASM`);
      }
    }

    console.log("[ZKProver] Initialising Barretenberg backend...");
    // Pass a logger so bb's stdout/stderr appears in Railway logs as [bb] lines.
    const bbLogger = (msg: string) => console.log(`[bb] ${msg}`);
    const api = await Barretenberg.new({ logger: bbLogger });

    const backend = new UltraHonkBackend(circuit.bytecode, api);
    const noir    = new Noir(circuit);

    // -- Build witness inputs ------------------------------------------------
    // NOTE: The Noir circuit (batch_clearing/src/main.nr) needs to be updated
    // for v8 4-sided orders (side: u8 instead of is_buy: bool).
    // For now, the real prover path uses `side` directly; update the circuit
    // when the ZK proving system is brought up to v8.
    const paddingOrder = {
      side:        0,    // OrderSide.YES_BUY = 0 (safe padding default)
      amount:      "0",
      limit_price: "0",
      salt:        Array(32).fill(0) as number[],
      is_padding:  true,
    };

    const orderCount = inputs.orders.length;

    // Pad orders array to MAX_ORDERS=8
    const circuitOrders: typeof paddingOrder[] = inputs.orders.map((o) => ({
      side:        o.side,           // uint8 OrderSide enum (v8)
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
      // Public inputs (must match circuit signature order — update circuit for v8)
      commitment_root:    this._hexToBytes(commitmentRoot, 32),
      clearing_price:     inputs.clearingPrice.toString(),
      filled_yes_buy_vol: inputs.filledYesBuyVol.toString(),
      filled_no_buy_vol:  inputs.filledNoBuyVol.toString(),
      filled_yes_sell_qty:inputs.filledYesSellQty.toString(),
      filled_no_sell_qty: inputs.filledNoSellQty.toString(),
      order_count:        orderCount.toString(),
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
