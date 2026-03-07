import { createPublicClient, createWalletClient, http, encodeAbiParameters, keccak256 } from "viem";
import { polygon, polygonAmoy } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { computeClearingPrice, computeFillsAtPrice } from "./clearingPrice.js";
import { ZKProver } from "./zkProver.js";
import { PolymarketClient, type ClobOrderForChain } from "./polymarketClient.js";
export type { ClobOrderForChain };
import { createOrderStore, type OrderStore } from "./orderStore.js";
import { OrderSide, BatchStatus } from "./types.js";
import type { Order, Commitment, BatchInfo, TransferAuth, RequeueAuth } from "./types.js";

/** Result for one excluded order from requeueExcludedOrders(). */
export interface RequeueResult {
  commitment:      `0x${string}`;
  /** 'requeued'  — successfully committed to toBatchId */
  /** 'no_auths'  — no pre-signed requeue sigs left; permanently dropped */
  /** 'error'     — on-chain tx failed; may retry next batch if auths remain */
  status:          "requeued" | "no_auths" | "error";
  fromBatchId:     bigint;
  toBatchId?:      bigint;
  remainingAuths:  number;
  errorMessage?:   string;
}

// Gas params per chain. Mainnet base fee can spike to 700+ gwei so we leave
// generous maxFeePerGas headroom; Amoy base fee is ~30 gwei so 35 gwei cap is fine.
function chainGas(chainId: number) {
  if (chainId === polygon.id) {
    return {
      maxPriorityFeePerGas: 100_000_000_000n,  // 100 gwei
      maxFeePerGas:         2_000_000_000_000n, // 2000 gwei — handles mainnet spikes
    };
  }
  return {
    maxPriorityFeePerGas: 30_000_000_000n, // 30 gwei
    maxFeePerGas:         35_000_000_000n, // 35 gwei — Amoy
  };
}

// Zero TransferAuth — passed for sell orders and unfilled buy orders in settleBatch.
// The contract only calls transferWithAuthorization when isBuy && orderFills, so
// zero auths for other orders are safely ignored.
const ZERO_BYTES32 = ("0x" + "0".repeat(64)) as `0x${string}`;
const ZERO_ADDRESS  = ("0x" + "0".repeat(40)) as `0x${string}`;
const ZERO_TRANSFER_AUTH: TransferAuth = {
  from:        ZERO_ADDRESS,
  validAfter:  0n,
  validBefore: 0n,
  nonce:       ZERO_BYTES32,
  v:           0,
  r:           ZERO_BYTES32,
  s:           ZERO_BYTES32,
};

// BatchVault ABI — full subset needed by the relayer (exported for index.ts event watching)
export const BATCH_VAULT_ABI = [
  {
    name: "openBatch",
    type: "function",
    inputs: [{ name: "marketId", type: "bytes32" }],
    outputs: [{ name: "batchId", type: "uint256" }],
    stateMutability: "nonpayable",
  },
  {
    name: "closeBatch",
    type: "function",
    inputs: [{ name: "marketId", type: "bytes32" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    name: "commitOrderFor",
    type: "function",
    inputs: [
      { name: "commitment", type: "bytes32" },
      { name: "amount",     type: "uint256" },
      { name: "signer",     type: "address" },
      { name: "nonce",      type: "uint256" },
      { name: "deadline",   type: "uint256" },
      { name: "signature",  type: "bytes"   },
      { name: "marketId",   type: "bytes32" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    name: "commitSellOrderFor",
    type: "function",
    inputs: [
      { name: "commitment", type: "bytes32" },
      { name: "yesAmount",  type: "uint256" },
      { name: "signer",     type: "address" },
      { name: "nonce",      type: "uint256" },
      { name: "deadline",   type: "uint256" },
      { name: "signature",  type: "bytes"   },
      { name: "marketId",   type: "bytes32" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    name: "commitBuyNoOrderFor",
    type: "function",
    inputs: [
      { name: "commitment", type: "bytes32" },
      { name: "amount",     type: "uint256" },
      { name: "signer",     type: "address" },
      { name: "nonce",      type: "uint256" },
      { name: "deadline",   type: "uint256" },
      { name: "signature",  type: "bytes"   },
      { name: "marketId",   type: "bytes32" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    name: "commitSellNoOrderFor",
    type: "function",
    inputs: [
      { name: "commitment", type: "bytes32" },
      { name: "noAmount",   type: "uint256" },
      { name: "signer",     type: "address" },
      { name: "nonce",      type: "uint256" },
      { name: "deadline",   type: "uint256" },
      { name: "signature",  type: "bytes"   },
      { name: "marketId",   type: "bytes32" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    name: "nonces",
    type: "function",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  // ── v9 two-phase settlement ─────────────────────────────────────────────────
  {
    // Phase 1: pull user USDC via EIP-3009, split/merge via CTF, send gap USDC +
    // excess tokens to relayer.  Sets status = LOCKED.
    name: "lockFunds",
    type: "function",
    inputs: [
      { name: "batchId", type: "uint256" },
      {
        name: "orders",
        type: "tuple[]",
        // RevealedOrder struct: side (uint8), amount, limitPrice, salt
        components: [
          { name: "side",       type: "uint8"   }, // 0=YES_BUY, 1=YES_SELL, 2=NO_BUY, 3=NO_SELL
          { name: "amount",     type: "uint256" },
          { name: "limitPrice", type: "uint256" },
          { name: "salt",       type: "bytes32" },
        ],
      },
      // EIP-3009 transfer authorizations — one per order (same index as orders[]).
      // For SELL orders and unfilled BUY orders, pass zero-value struct (ignored).
      // `from` = ephemeral wallet address (source of USDC pull for filled BUY orders).
      {
        name: "auths",
        type: "tuple[]",
        components: [
          { name: "from",        type: "address" },
          { name: "validAfter",  type: "uint256" },
          { name: "validBefore", type: "uint256" },
          { name: "nonce",       type: "bytes32" },
          { name: "v",           type: "uint8"   },
          { name: "r",           type: "bytes32" },
          { name: "s",           type: "bytes32" },
        ],
      },
      { name: "clearingPrice",    type: "uint256" },
      { name: "filledYesBuyVol",  type: "uint256" }, // USDC from filled YES_BUY orders
      { name: "filledNoBuyVol",   type: "uint256" }, // USDC from filled NO_BUY orders
      { name: "filledYesSellQty", type: "uint256" }, // YES tokens from filled YES_SELL orders
      { name: "filledNoSellQty",  type: "uint256" }, // NO tokens from filled NO_SELL orders
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    // Phase 2: verify ZK proof, pull gap tokens + excess USDC from relayer, finalize.
    // Requires: ctf.isApprovedForAll(relayer, vault) && usdc.allowance(relayer, vault) >= excess USDC.
    name: "settleBatch",
    type: "function",
    inputs: [
      { name: "batchId", type: "uint256" },
      { name: "proof",   type: "bytes"   },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    name: "getBatch",
    type: "function",
    inputs: [{ name: "batchId", type: "uint256" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        // Matches BatchVault v9 Batch struct exactly
        components: [
          { name: "marketId",         type: "bytes32" },
          { name: "openedAt",         type: "uint256" },
          { name: "closedAt",         type: "uint256" },
          { name: "status",           type: "uint8"   }, // 0=OPEN,1=SETTLING,2=LOCKED,3=SETTLED
          { name: "totalDeposited",   type: "uint256" }, // USDC authorized by YES buyers
          { name: "totalDepositedNo", type: "uint256" }, // USDC authorized by NO buyers
          { name: "totalSellYes",     type: "uint256" }, // YES tokens from YES sellers
          { name: "totalSellNo",      type: "uint256" }, // NO tokens from NO sellers
          { name: "clearingPrice",    type: "uint256" },
          { name: "commitmentCount",  type: "uint256" },
          { name: "commitmentRoot",   type: "bytes32" },
          { name: "claimMerkleRoot",  type: "bytes32" },
          // v9 two-phase settlement state (set by lockFunds, consumed by settleBatch)
          { name: "filledYesBuyVol",  type: "uint256" },
          { name: "filledNoBuyVol",   type: "uint256" },
          { name: "filledYesSellQty", type: "uint256" },
          { name: "filledNoSellQty",  type: "uint256" },
          { name: "yesGap",           type: "uint256" }, // YES tokens relayer must deliver
          { name: "noGap",            type: "uint256" }, // NO tokens relayer must deliver
          { name: "finalExcessYes",   type: "uint256" }, // YES sent to relayer; relayer returns USDC
          { name: "finalExcessNo",    type: "uint256" }, // NO sent to relayer; relayer returns USDC
        ],
      },
    ],
    stateMutability: "view",
  },
  {
    name: "getCommitment",
    type: "function",
    inputs: [
      { name: "batchId", type: "uint256" },
      { name: "index",   type: "uint256" },
    ],
    outputs: [
      {
        name: "",
        type: "tuple",
        // Commitment struct: { hash, amount, claimed } — no trader address field
        components: [
          { name: "hash",    type: "bytes32" },
          { name: "amount",  type: "uint256" },
          { name: "claimed", type: "bool"    },
        ],
      },
    ],
    stateMutability: "view",
  },
  {
    name: "getCurrentBatchId",
    type: "function",
    inputs: [{ name: "marketId", type: "bytes32" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    // ZK claim: prove order membership in Merkle tree without revealing which leaf.
    // Payout goes to recipient derived from publicInputs[4].
    name: "claimWithProof",
    type: "function",
    inputs: [
      { name: "batchId",      type: "uint256" },
      { name: "proof",        type: "bytes"   },
      { name: "publicInputs", type: "bytes32[]" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    name: "usedNullifiers",
    type: "function",
    inputs: [{ name: "nullifier", type: "bytes32" }],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "view",
  },
  // Note: events are not listed here — index.ts uses parseAbiItem() for getLogs
  // which avoids inflating the ABI union type (viem TypeScript inference degrades
  // beyond ~10 entries, causing spurious "chain missing" errors on writeContract).
] as const;

// PublicInputAdapter ABI — minimal subset for the relayer
// Adapter sits between BatchVault (6 public inputs) and HonkVerifier (37 public inputs).
// Relayer must call setPendingOrderCount(n) before each real-ZK settleBatch call.
const ADAPTER_ABI = [
  {
    name: "setPendingOrderCount",
    type: "function",
    inputs: [{ name: "n", type: "uint256" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const;

// ConditionalTokens ERC-1155 ABI — minimal subset for relayer approval setup
const CTF_ABI = [
  {
    name: "setApprovalForAll",
    type: "function",
    inputs:  [{ name: "operator", type: "address" }, { name: "approved", type: "bool" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    name: "isApprovedForAll",
    type: "function",
    inputs:  [{ name: "account", type: "address" }, { name: "operator", type: "address" }],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "view",
  },
] as const;

// ERC-20 ABI — minimal subset for USDC approval + allowance check
const ERC20_ABI = [
  {
    name: "approve",
    type: "function",
    inputs:  [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "nonpayable",
  },
  {
    name: "allowance",
    type: "function",
    inputs:  [{ name: "owner", type: "address" }, { name: "spender", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
] as const;

export interface RelayerConfig {
  rpcUrl: string;
  chainId: number;          // 137 = Polygon mainnet, 80002 = Polygon Amoy
  vaultAddress: `0x${string}`;
  relayerPrivateKey: `0x${string}`;
  marketId: `0x${string}`;  // Polymarket condition ID this processor manages
  redisUrl?: string;        // Optional — falls back to in-memory if not set
  useRealZk?: boolean;      // true = generate real UltraHonk proofs via bb; default false (mock)
  adapterAddress?: `0x${string}`; // PublicInputAdapter address (required when useRealZk=true)
  usdcAddress?:   `0x${string}`;  // USDC contract address
  ctfAddress?:    `0x${string}`;  // ConditionalTokens (ERC-1155) contract address
  polymarket: {
    apiKey:          string;
    apiSecret:       string;
    apiPassphrase:   string;
    signerPrivateKey?: `0x${string}`; // EIP-712 order signing key (maker address must match API key owner)
    proxyWallet?:    string;          // Polymarket proxy wallet shown in Builder Codes → Address
    builderKey?:        string;       // Builder API key (UUID) from polymarket.com/settings?tab=builder
    builderSecret?:     string;       // Builder API secret for HMAC signing
    builderPassphrase?: string;       // Builder API passphrase
  };
  batchWindowMs: number;
}

/**
 * BatchProcessor: off-chain relayer that drives the batch lifecycle.
 *
 *  1. Open batches on request (called from index.ts on startup + after each settlement)
 *  2. Accept order details via receiveOrder() (called from HTTP /order endpoint)
 *  3. Close batches after BATCH_WINDOW elapses
 *  4. Compute clearing price from revealed orders
 *  5. Generate ZK proof (mock for prototype — MockBatchVerifier accepts anything)
 *  6. Execute net position on Polymarket (if API keys configured)
 *  7. Call settleBatch() on-chain — submits EIP-3009 auths for filled buy orders
 */
export class BatchProcessor {
  private publicClient: ReturnType<typeof createPublicClient>;
  private walletClient: ReturnType<typeof createWalletClient>;
  private config: RelayerConfig;
  private zkProver: ZKProver;
  private polymarket: PolymarketClient;
  private store: OrderStore;

  /**
   * viem's writeContract TypeScript overload resolution breaks when the ABI
   * union is large (>~8 entries). Work around by calling through a typed helper
   * that casts to `any` internally. Runtime behaviour is unchanged.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _write(params: Record<string, unknown>): Promise<`0x${string}`> {
    return (this.walletClient.writeContract as (p: any) => Promise<`0x${string}`>)(params);
  }

  constructor(config: RelayerConfig) {
    this.config = config;
    const account = privateKeyToAccount(config.relayerPrivateKey);
    const chain = config.chainId === polygon.id ? polygon : polygonAmoy;

    this.publicClient = createPublicClient({
      chain,
      transport: http(config.rpcUrl),
    });

    this.walletClient = createWalletClient({
      chain,
      transport: http(config.rpcUrl),
      account,
    });

    this.zkProver = new ZKProver(config.useRealZk ?? false);
    this.polymarket = new PolymarketClient(
      config.polymarket.apiKey,
      config.polymarket.apiSecret,
      config.polymarket.apiPassphrase,
      config.polymarket.signerPrivateKey,
      config.polymarket.proxyWallet,
      config.rpcUrl,
      config.polymarket.builderKey,
      config.polymarket.builderSecret,
      config.polymarket.builderPassphrase,
    );
    this.store = createOrderStore(config.redisUrl);
  }

  // ─── Approval setup (v7.3 relayer-intermediary) ────────────────────────────

  /**
   * One-time setup: grant vault approval to pull gap tokens (ERC-1155) and
   * USDC excess proceeds (ERC-20) from the relayer wallet in settleBatch() (Phase 2).
   *
   * Called once at startup (or lazily before first settlement on mainnet).
   *
   * Gap tokens: vault.safeTransferFrom(relayer → vault, gapQty) in settleBatch
   *   → requires ctf.isApprovedForAll(relayer, vault) == true
   *   Gap tokens were bought from CLOB by the relayer using vault-provided USDC
   *   (sent by lockFunds). Zero relayer capital.
   *
   * Excess USDC: vault.transferFrom(relayer → vault, usdcProceeds) in settleBatch
   *   → requires usdc.allowance(relayer, vault) >= excess USDC
   *   Excess USDC = proceeds from selling vault-provided excess tokens on CLOB.
   *   Set max allowance once; covers all batches.
   */
  async ensureApprovals(): Promise<void> {
    if (!this.config.ctfAddress || !this.config.usdcAddress) {
      console.log("[BatchProcessor] ensureApprovals: ctfAddress or usdcAddress not configured — skipping");
      return;
    }

    const relayerAddress = this.walletClient.account!.address;

    // ── CTF: setApprovalForAll(vault, true) ─────────────────────────────────
    const isCtfApproved = await this.publicClient.readContract({
      address:      this.config.ctfAddress,
      abi:          CTF_ABI,
      functionName: "isApprovedForAll",
      args:         [relayerAddress, this.config.vaultAddress],
    }) as boolean;

    if (!isCtfApproved) {
      console.log("[BatchProcessor] ensureApprovals: setting CTF setApprovalForAll(vault, true)");
      const hash = await this._write({
        address:      this.config.ctfAddress,
        abi:          CTF_ABI,
        functionName: "setApprovalForAll",
        args:         [this.config.vaultAddress, true],
        ...chainGas(this.config.chainId),
      });
      await this.publicClient.waitForTransactionReceipt({ hash });
      console.log(`[BatchProcessor] CTF approval set (tx: ${hash})`);
    } else {
      console.log("[BatchProcessor] ensureApprovals: CTF already approved ✓");
    }

    // ── USDC: approve(vault, max) — vault pulls USDC from relayer in settleBatch ──
    const HALF_MAX = (2n ** 256n - 1n) / 2n;
    const MAX_UINT = 2n ** 256n - 1n;

    const vaultAllowance = await this.publicClient.readContract({
      address:      this.config.usdcAddress,
      abi:          ERC20_ABI,
      functionName: "allowance",
      args:         [relayerAddress, this.config.vaultAddress],
    }) as bigint;

    if (vaultAllowance < HALF_MAX) {
      console.log("[BatchProcessor] ensureApprovals: setting USDC approve(vault, max)");
      const hash = await this._write({
        address:      this.config.usdcAddress,
        abi:          ERC20_ABI,
        functionName: "approve",
        args:         [this.config.vaultAddress, MAX_UINT],
        ...chainGas(this.config.chainId),
      });
      await this.publicClient.waitForTransactionReceipt({ hash });
      console.log(`[BatchProcessor] USDC max approval set for vault (tx: ${hash})`);
    } else {
      console.log("[BatchProcessor] ensureApprovals: USDC allowance already sufficient ✓");
    }

    // ── USDC: approve(CTFExchange + NegRiskExchange + NegRiskAdapter, max) ──
    // When the relayer places a CLOB BUY order (to acquire gap YES/NO tokens),
    // Polymarket's exchange contracts pull USDC from the relayer's wallet.
    // NegRisk markets route through NegRiskAdapter AND NegRiskExchange — both need approval.
    const EXCHANGE_APPROVALS = [
      ["0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E", "CTFExchange"     ],
      ["0xC5d563A36AE78145C45a50134d48A1215220f80a", "NegRiskExchange"  ],
      ["0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296", "NegRiskAdapter"   ],
    ] as const satisfies readonly (readonly [`0x${string}`, string])[];

    for (const [exchange, label] of EXCHANGE_APPROVALS) {
      const exchAllowance = await this.publicClient.readContract({
        address:      this.config.usdcAddress,
        abi:          ERC20_ABI,
        functionName: "allowance",
        args:         [relayerAddress, exchange],
      }) as bigint;

      if (exchAllowance < HALF_MAX) {
        console.log(`[BatchProcessor] ensureApprovals: setting USDC approve(${label}, max)`);
        const hash = await this._write({
          address:      this.config.usdcAddress,
          abi:          ERC20_ABI,
          functionName: "approve",
          args:         [exchange, MAX_UINT],
          ...chainGas(this.config.chainId),
        });
        await this.publicClient.waitForTransactionReceipt({ hash });
        console.log(`[BatchProcessor] USDC max approval set for ${label} (tx: ${hash})`);
      } else {
        console.log(`[BatchProcessor] ensureApprovals: USDC allowance for ${label} already sufficient ✓`);
      }
    }
  }

  // ─── Order intake (called from HTTP /order endpoint) ──────────────────────

  /**
   * Privacy path for BUY orders (YES_BUY or NO_BUY): the trader signed an EIP-712
   * CommitOrder AND an EIP-3009 TransferWithAuthorization off-chain.
   *
   * The relayer calls commitOrderFor() (YES_BUY) or commitBuyNoOrderFor() (NO_BUY)
   * on-chain — only the relayer address is visible. The EIP-3009 TransferAuth is
   * stored and submitted at settlement to pull USDC from the user's wallet.
   *
   * @param order.side   Must be YES_BUY or NO_BUY
   * @param transferAuth EIP-3009 authorization — required for BUY orders
   */
  async submitCommitmentFor(
    batchId: bigint,
    order: Order,
    commitment: `0x${string}`,
    signer: `0x${string}`,
    nonce: bigint,
    deadline: bigint,
    signature: `0x${string}`,
    transferAuth?: TransferAuth,
  ): Promise<void> {
    if (order.side !== OrderSide.YES_BUY && order.side !== OrderSide.NO_BUY) {
      throw new Error(`submitCommitmentFor: expected BUY order, got side=${order.side}`);
    }

    // Verify commitment hash BEFORE going on-chain.
    // If the frontend computed the hash with the wrong marketId (or any other wrong param),
    // we catch it here and reject — preventing USDC from getting stuck in the ephemeral
    // wallet if this batch later can't be settled.
    const expected = this._computeCommitmentHash(this.config.marketId, order);
    if (expected.toLowerCase() !== commitment.toLowerCase()) {
      throw new Error(
        `Commitment hash mismatch — order rejected to prevent stuck funds. ` +
        `Expected: ${expected}, received: ${commitment}. ` +
        `Ensure the frontend uses the Polymarket conditionId (not bytes32(0)) as marketId.`,
      );
    }

    const isYesBuy = order.side === OrderSide.YES_BUY;
    const fnName   = isYesBuy ? "commitOrderFor" : "commitBuyNoOrderFor";
    console.log(`[BatchProcessor] Submitting ${fnName} on behalf of ${signer} (side=${order.side})`);

    const hash = await this._write({
      address: this.config.vaultAddress,
      abi: BATCH_VAULT_ABI,
      functionName: fnName,
      args: [commitment, order.amount, signer, nonce, deadline, signature, this.config.marketId],
      ...chainGas(this.config.chainId),
    });

    await this.publicClient.waitForTransactionReceipt({ hash });
    console.log(`[BatchProcessor] ${fnName} tx: ${hash} (trader=${signer} hidden)`);

    // Store order keyed by commitment hash — used for matching at settlement.
    const orderWithAuth: Order = { ...order, trader: signer, transferAuth };
    await this.store.save(batchId.toString(), commitment.toLowerCase(), orderWithAuth);
    console.log(`[BatchProcessor] Stored ${isYesBuy ? "YES_BUY" : "NO_BUY"} order for commitment ${commitment} (batch ${batchId})`);
  }

  /**
   * Privacy path for SELL orders (YES_SELL or NO_SELL): trader signed an EIP-712
   * CommitOrder off-chain. The relayer calls commitSellOrderFor() (YES_SELL) or
   * commitSellNoOrderFor() (NO_SELL) on-chain — tokens are pulled from the signer
   * via safeTransferFrom (requires ctf.setApprovalForAll(vault, true)).
   *
   * Sell orders don't need a TransferAuth — tokens are deposited upfront, not USDC.
   *
   * @param order.side   Must be YES_SELL or NO_SELL
   */
  async submitSellCommitmentFor(
    batchId: bigint,
    order: Order,
    commitment: `0x${string}`,
    signer: `0x${string}`,
    nonce: bigint,
    deadline: bigint,
    signature: `0x${string}`,
  ): Promise<void> {
    if (order.side !== OrderSide.YES_SELL && order.side !== OrderSide.NO_SELL) {
      throw new Error(`submitSellCommitmentFor: expected SELL order, got side=${order.side}`);
    }

    // Same hash verification as buy orders — prevent irrecoverable commitment mismatches.
    const expected = this._computeCommitmentHash(this.config.marketId, order);
    if (expected.toLowerCase() !== commitment.toLowerCase()) {
      throw new Error(
        `Commitment hash mismatch (sell) — order rejected. ` +
        `Expected: ${expected}, received: ${commitment}.`,
      );
    }

    const isYesSell = order.side === OrderSide.YES_SELL;
    const fnName    = isYesSell ? "commitSellOrderFor" : "commitSellNoOrderFor";
    console.log(`[BatchProcessor] Submitting ${fnName} on behalf of ${signer} (side=${order.side})`);

    const hash = await this._write({
      address: this.config.vaultAddress,
      abi: BATCH_VAULT_ABI,
      functionName: fnName,
      args: [commitment, order.amount, signer, nonce, deadline, signature, this.config.marketId],
      ...chainGas(this.config.chainId),
    });

    await this.publicClient.waitForTransactionReceipt({ hash });
    console.log(`[BatchProcessor] ${fnName} tx: ${hash} (seller=${signer})`);

    // Sell orders: no TransferAuth (tokens deposited, not USDC)
    const orderWithTrader: Order = { ...order, trader: signer };
    await this.store.save(batchId.toString(), commitment.toLowerCase(), orderWithTrader);
    console.log(`[BatchProcessor] Stored ${isYesSell ? "YES_SELL" : "NO_SELL"} order for commitment ${commitment} (batch ${batchId})`);
  }

  /**
   * Legacy path: trader already called commitOrder() directly (address visible on-chain).
   * Just store the off-chain order details for settlement.
   * NOTE: Legacy direct-path buy orders have no TransferAuth — they will fail at settlement.
   *       This path is only valid for sell orders or testing.
   */
  async receiveOrder(batchId: bigint, order: Order): Promise<void> {
    // For legacy path, key by trader address (no commitment hash available)
    await this.store.save(batchId.toString(), order.trader.toLowerCase(), order);
    console.log(`[BatchProcessor] Stored legacy order from ${order.trader} for batch ${batchId}`);
  }

  /** Returns how many off-chain orders are stored for a batch */
  async orderCount(batchId: bigint): Promise<number> {
    return this.store.count(batchId.toString());
  }

  // ─── Batch lifecycle ───────────────────────────────────────────────────────

  /** Open a new batch for a given Polymarket market (relayer-only on-chain call) */
  async openBatch(marketId: `0x${string}`): Promise<bigint> {
    console.log(`[BatchProcessor] Opening batch for market ${marketId}`);

    const hash = await this._write({
      address: this.config.vaultAddress,
      abi: BATCH_VAULT_ABI,
      functionName: "openBatch",
      args: [marketId],
      ...chainGas(this.config.chainId),
    });

    await this.publicClient.waitForTransactionReceipt({ hash });

    const batchId = await this.publicClient.readContract({
      address: this.config.vaultAddress,
      abi: BATCH_VAULT_ABI,
      functionName: "getCurrentBatchId",
      args: [marketId],
    }) as bigint;

    console.log(`[BatchProcessor] Batch ${batchId} opened (tx: ${hash})`);
    return batchId;
  }

  /** Close the current batch for this processor's market (anyone can call after BATCH_WINDOW expires) */
  async closeBatch(): Promise<void> {
    const hash = await this._write({
      address: this.config.vaultAddress,
      abi: BATCH_VAULT_ABI,
      functionName: "closeBatch",
      args: [this.config.marketId],
      ...chainGas(this.config.chainId),
    });
    await this.publicClient.waitForTransactionReceipt({ hash });
    console.log(`[BatchProcessor] closeBatch tx: ${hash} (market: ${this.config.marketId})`);
  }

  /**
   * Process a closed batch — two-phase zero-capital settlement (v9):
   *
   *   Phase 1 — lockFunds():
   *     fetch commitments → match orders → compute clearing price → generate ZK proof
   *     → call lockFunds() on-chain (pulls user USDC via EIP-3009, splits/merges via CTF,
   *       sends gap USDC + excess tokens to relayer wallet)
   *
   *   Between phases (off-chain CLOB):
   *     → buy gap YES/NO tokens from CLOB (using vault-provided USDC in relayer wallet)
   *     → sell excess YES/NO tokens on CLOB (relayer holds USDC proceeds)
   *
   *   Phase 2 — settleBatch():
   *     → call settleBatch(batchId, proof) on-chain
   *       (verifies ZK proof; pulls gap tokens + USDC from relayer; finalizes)
   *
   *   Net result: relayer never uses its own USDC capital.
   *   All USDC for gap fills comes from user deposits routed through the vault.
   */
  async processBatch(batchId: bigint): Promise<{ excludedOrders: Array<{ order: Order; commitment: `0x${string}` }> }> {
    console.log(`[BatchProcessor] Processing batch ${batchId}`);

    // 1. Fetch on-chain batch info + commitments
    const batchRaw = await this.publicClient.readContract({
      address: this.config.vaultAddress,
      abi: BATCH_VAULT_ABI,
      functionName: "getBatch",
      args: [batchId],
    });
    const batchInfo: BatchInfo = { ...(batchRaw as unknown as Omit<BatchInfo, "batchId">), batchId };

    const commitments = await this._fetchCommitments(batchId, Number(batchInfo.commitmentCount));
    console.log(`[BatchProcessor] ${commitments.length} on-chain commitments`);

    // 2. Match to off-chain order details (verifies commitment hashes)
    const orders = await this._matchOrdersToCommitments(batchId, commitments, batchInfo.marketId);
    console.log(`[BatchProcessor] ${orders.length}/${commitments.length} orders matched`);

    // ── Completeness check ────────────────────────────────────────────────────
    // The contract enforces orders.length == batch.commitmentCount at settlement.
    // If any commitment is unmatched (order never sent to relayer, Redis data lost,
    // or hash computed with wrong marketId), we CANNOT settle this batch.
    if (orders.length !== commitments.length) {
      const unmatched = commitments.length - orders.length;
      throw new Error(
        `UNRESOLVABLE: ${unmatched} of ${commitments.length} commitment(s) have no ` +
        `matching off-chain order (order not received by relayer, Redis data lost, ` +
        `or commitment hash uses wrong marketId). Cannot call settleBatch — contract ` +
        `requires all ${commitments.length} commitment(s) to be revealed.`,
      );
    }

    if (commitments.length === 0) {
      console.log(`[BatchProcessor] Empty batch — settling to advance lifecycle`);
    }

    // Build commitment-hash → order map for excluded-order tracking below.
    // (orders[] and commitments[] are aligned when completeness check passes.)
    const orderByCommitmentHash = new Map<string, Order>();
    for (const order of orders) {
      const hash = this._computeCommitmentHash(batchInfo.marketId, order);
      orderByCommitmentHash.set(hash.toLowerCase(), order);
    }

    // 3. Compute internal batch clearing price
    const clearing = computeClearingPrice(orders);
    console.log(
      `[BatchProcessor] Internal clearing: price=${clearing.clearingPrice}, ` +
      `yesBuyVol=${clearing.filledYesBuyVol}, noBuyVol=${clearing.filledNoBuyVol}, ` +
      `yesSellQty=${clearing.filledYesSellQty}, noSellQty=${clearing.filledNoSellQty}`,
    );

    // 4. Fetch Polymarket data + execute net position (only when API keys are set)
    let effectiveClearingPrice = clearing.clearingPrice;
    let cachedYesToken: string | undefined;
    let cachedNoToken:  string | undefined;

    // ─── 4a. Price discovery ──────────────────────────────────────────────────
    if (this.config.polymarket.apiKey) {
      try {
        const market = await this.polymarket.getMarket(batchInfo.marketId);
        cachedYesToken =
          market.tokens.find((t) => t.outcome?.toLowerCase() === "yes")?.token_id ??
          market.clobTokenIds?.[0];
        cachedNoToken =
          market.tokens.find((t) => t.outcome?.toLowerCase() === "no")?.token_id ??
          market.clobTokenIds?.[1];
        if (!cachedYesToken) throw new Error("YES token not found for market");

        if (effectiveClearingPrice === 0n) {
          // Prefer bestBid/bestAsk from the /events endpoint (correct for neg-risk
          // group markets where /midpoint returns 0.5 sentinel or 404).
          if (market.bestBid && market.bestAsk && market.bestBid > 0 && market.bestAsk > 0) {
            const mid = (market.bestBid + market.bestAsk) / 2;
            effectiveClearingPrice = BigInt(Math.round(mid * 1_000_000));
            console.log(
              `[BatchProcessor] No internal crossing — anchoring to Gamma bestBid/bestAsk: ` +
              `(${market.bestBid}+${market.bestAsk})/2=${mid} → ${effectiveClearingPrice}`,
            );
          } else if (market.lastTradePrice && market.lastTradePrice > 0) {
            effectiveClearingPrice = BigInt(Math.round(market.lastTradePrice * 1_000_000));
            console.log(
              `[BatchProcessor] No internal crossing — anchoring to Gamma lastTradePrice: ` +
              `${market.lastTradePrice} → ${effectiveClearingPrice}`,
            );
          } else {
            // Gamma market data has no price — fall back to CLOB /midpoint (+ /last-trade-price).
            const mid = await this.polymarket.getMidPrice(cachedYesToken);
            effectiveClearingPrice = BigInt(Math.round(mid * 1_000_000));
            console.log(
              `[BatchProcessor] No internal crossing — anchoring to CLOB mid: ` +
              `${mid} → ${effectiveClearingPrice}`,
            );
          }
        }
      } catch (err) {
        console.warn(`[BatchProcessor] Polymarket price-discovery step failed (non-fatal):`, err);
      }
    }

    if (effectiveClearingPrice === 0n) {
      // Try Gamma API (public, no auth required) to get actual YES market price.
      // This avoids the 65¢ hardcode killing buy orders on low-probability markets.
      // If Gamma outcomePrices is also 0 (mirrors CLOB data for illiquid markets),
      // fall back to CLOB /last-trade-price via getMidPrice.
      try {
        const market = await this.polymarket.getMarket(batchInfo.marketId);
        const yesToken =
          cachedYesToken ??
          market.tokens.find((t) => t.outcome?.toLowerCase() === "yes")?.token_id ??
          market.clobTokenIds?.[0];
        const yesPrice = parseFloat(market.outcomePrices?.[0] ?? "0");
        if (yesPrice > 0 && yesPrice < 1) {
          effectiveClearingPrice = BigInt(Math.round(yesPrice * 1_000_000));
          console.log(
            `[BatchProcessor] Gamma public price: ${yesPrice} → effectiveClearingPrice=${effectiveClearingPrice}`,
          );
        } else if (yesToken) {
          // Gamma outcomePrices reflects CLOB mid — also 0 when no active orderbook.
          // getMidPrice() now internally falls back to /last-trade-price on 404.
          try {
            const lastPrice = await this.polymarket.getMidPrice(yesToken);
            if (lastPrice > 0) {
              effectiveClearingPrice = BigInt(Math.round(lastPrice * 1_000_000));
              console.log(
                `[BatchProcessor] CLOB last-trade-price: ${lastPrice} → effectiveClearingPrice=${effectiveClearingPrice}`,
              );
            }
          } catch (priceErr) {
            console.warn(`[BatchProcessor] CLOB last-trade-price also failed (non-fatal):`, priceErr);
          }
        }
      } catch (err) {
        console.warn(`[BatchProcessor] Gamma price lookup failed (non-fatal):`, err);
      }
    }

    if (effectiveClearingPrice === 0n) {
      effectiveClearingPrice = 650_000n; // last-resort fallback
      console.log(`[BatchProcessor] All price sources failed — using hardcoded fallback: ${effectiveClearingPrice}`);
    }

    console.log(`[BatchProcessor] Effective clearing price: ${effectiveClearingPrice}`);

    // 5. Re-compute fills at the effective clearing price.
    let fills = computeFillsAtPrice(orders, effectiveClearingPrice);
    console.log(
      `[BatchProcessor] Fills at effective price: yesBuyVol=${fills.filledYesBuyVol}, ` +
      `noBuyVol=${fills.filledNoBuyVol}, yesSellQty=${fills.filledYesSellQty}, noSellQty=${fills.filledNoSellQty}`,
    );

    // ─── 4b. Geometry preview (mirrors on-chain lockFunds logic) ─────────────
    //
    // In v9 the vault handles all capital flows:
    //   - CTF.splitPosition: balanced YES+NO demand → YES/NO tokens at zero relayer capital
    //   - CTF.mergePositions: balanced excess YES+NO supply → USDC returned to vault
    //   - yesGap/noGap: unbalanced remainder → vault sends USDC to relayer; relayer buys CLOB
    //   - finalExcessYes/No: unbalanced excess → vault sends tokens to relayer; relayer sells CLOB
    //
    // Relayer wallet receives vault-provided USDC for gap buys and vault-provided tokens
    // for excess sells.  No relayer capital required in the common (balanced) case.
    const PRICE_DEC = 1_000_000n;
    const noPrice   = PRICE_DEC - effectiveClearingPrice;
    const yesBuyersNeedTokens = effectiveClearingPrice > 0n
      ? (fills.filledYesBuyVol * PRICE_DEC) / effectiveClearingPrice : 0n;
    const noBuyersNeedTokens  = noPrice > 0n
      ? (fills.filledNoBuyVol * PRICE_DEC) / noPrice : 0n;
    const directYesMatch = yesBuyersNeedTokens < fills.filledYesSellQty ? yesBuyersNeedTokens : fills.filledYesSellQty;
    const directNoMatch  = noBuyersNeedTokens  < fills.filledNoSellQty  ? noBuyersNeedTokens  : fills.filledNoSellQty;
    const remYesDemand   = yesBuyersNeedTokens - directYesMatch;
    const remNoDemand    = noBuyersNeedTokens  - directNoMatch;
    const splitQty       = remYesDemand < remNoDemand ? remYesDemand : remNoDemand;
    let yesGap         = remYesDemand - splitQty;  // YES tokens relayer must acquire via CLOB
    let noGap          = remNoDemand  - splitQty;  // NO tokens relayer must acquire via CLOB
    const excessYes      = fills.filledYesSellQty - directYesMatch;
    const excessNo       = fills.filledNoSellQty  - directNoMatch;
    const mergeQty       = excessYes < excessNo ? excessYes : excessNo;
    let finalExcessYes = excessYes - mergeQty;  // YES vault sends to relayer; relayer sells on CLOB
    let finalExcessNo  = excessNo  - mergeQty;  // NO vault sends to relayer; relayer sells on CLOB

    console.log(
      `[BatchProcessor] Settlement geometry: split=${splitQty}, merge=${mergeQty}, ` +
      `yesGap=${yesGap}, noGap=${noGap}, finalExcessYes=${finalExcessYes}, finalExcessNo=${finalExcessNo}`,
    );

    // ── LOCKED-batch resume ────────────────────────────────────────────────────
    // If the batch is already LOCKED (a previous processBatch run succeeded at Phase 1
    // but failed at CLOB buy / settleBatch), override locally-computed values with the
    // on-chain state so the regenerated ZK proof is consistent with what lockFunds stored.
    const alreadyLocked = batchInfo.status === BatchStatus.LOCKED;
    if (alreadyLocked) {
      console.log(
        `[BatchProcessor] Batch ${batchId} already LOCKED — resuming CLOB + settleBatch ` +
        `(on-chain: clearingPrice=${batchInfo.clearingPrice}, yesGap=${batchInfo.yesGap}, noGap=${batchInfo.noGap})`,
      );
      effectiveClearingPrice  = batchInfo.clearingPrice;
      fills.filledYesBuyVol   = batchInfo.filledYesBuyVol;
      fills.filledNoBuyVol    = batchInfo.filledNoBuyVol;
      fills.filledYesSellQty  = batchInfo.filledYesSellQty;
      fills.filledNoSellQty   = batchInfo.filledNoSellQty;
      yesGap         = batchInfo.yesGap;
      noGap          = batchInfo.noGap;
      finalExcessYes = batchInfo.finalExcessYes;
      finalExcessNo  = batchInfo.finalExcessNo;
    }

    // 5. Generate ZK proof (can be done before lockFunds — inputs are already known)
    const { proof } = await this.zkProver.generateProof({
      marketId:          batchInfo.marketId,
      orders,
      commitments:       commitments.map((c) => c.hash),
      clearingPrice:     effectiveClearingPrice,
      filledYesBuyVol:   fills.filledYesBuyVol,
      filledNoBuyVol:    fills.filledNoBuyVol,
      filledYesSellQty:  fills.filledYesSellQty,
      filledNoSellQty:   fills.filledNoSellQty,
    });

    // 5b. PublicInputAdapter (real ZK only — must be set before settleBatch)
    if (this.config.useRealZk && this.config.adapterAddress) {
      console.log(`[BatchProcessor] Setting pendingOrderCount=${orders.length} on PublicInputAdapter`);
      const adapterHash = await this._write({
        address: this.config.adapterAddress,
        abi: ADAPTER_ABI,
        functionName: "setPendingOrderCount",
        args: [BigInt(orders.length)],
        ...chainGas(this.config.chainId),
      });
      await this.publicClient.waitForTransactionReceipt({ hash: adapterHash });
      console.log(`[BatchProcessor] PublicInputAdapter ready (tx: ${adapterHash})`);
    }

    // 6. Build EIP-3009 TransferAuth[] — one per order (parallel to orders[]).
    //    For filled BUY orders (YES_BUY and NO_BUY): use stored TransferAuth (pulls USDC).
    //    For SELL orders / unfilled BUY orders: zero struct (contract skips these).
    //    Track excluded buy orders that have pre-signed requeue sigs for auto-requeue.
    const excludedOrders: Array<{ order: Order; commitment: `0x${string}` }> = [];
    const noPrice_auths = PRICE_DEC - effectiveClearingPrice;

    const auths = orders.map((order, i) => {
      const isBuy = order.side === OrderSide.YES_BUY || order.side === OrderSide.NO_BUY;
      let isFilled: boolean;
      if (order.side === OrderSide.YES_BUY)       isFilled = order.limitPrice >= effectiveClearingPrice;
      else if (order.side === OrderSide.NO_BUY)   isFilled = order.limitPrice >= noPrice_auths;
      else if (order.side === OrderSide.YES_SELL)  isFilled = order.limitPrice <= effectiveClearingPrice;
      else                                          isFilled = order.limitPrice <= noPrice_auths; // NO_SELL

      // Track excluded BUY orders for auto-requeue to the next batch
      if (!isFilled && isBuy && order.requeueAuths && order.requeueAuths.length > 0) {
        excludedOrders.push({ order, commitment: commitments[i].hash });
      }

      if (isBuy && isFilled && order.transferAuth) {
        console.log(`[BatchProcessor] Including TransferAuth for filled ${OrderSide[order.side]} order (ephemeral=${order.trader})`);
        // Ensure `from` = ephemeral wallet address (stored as order.trader)
        return { ...order.transferAuth, from: order.trader };
      }

      if (isBuy && isFilled && !order.transferAuth) {
        console.warn(`[BatchProcessor] Filled ${OrderSide[order.side]} order for ${order.trader} has no TransferAuth — settlement will fail for this order`);
      }

      return ZERO_TRANSFER_AUTH;
    });

    // ─── Phase 1: lockFunds ──────────────────────────────────────────────────
    // Pull user USDC via EIP-3009; split/merge via CTF; send gap USDC + excess
    // tokens to relayer wallet.  After this tx the batch status = LOCKED.
    // Skipped if the batch is already LOCKED (CLOB retry path).
    if (!alreadyLocked) {
      console.log(`[BatchProcessor] Phase 1: calling lockFunds for batch ${batchId}`);
      const lockHash = await this._write({
        address: this.config.vaultAddress,
        abi: BATCH_VAULT_ABI,
        functionName: "lockFunds",
        args: [
          batchId,
          orders.map((o) => ({
            side:       o.side,       // uint8 OrderSide enum
            amount:     o.amount,
            limitPrice: o.limitPrice,
            salt:       o.salt,
          })),
          auths.map((a) => ({
            from:        a.from,
            validAfter:  a.validAfter,
            validBefore: a.validBefore,
            nonce:       a.nonce,
            v:           a.v,
            r:           a.r,
            s:           a.s,
          })),
          effectiveClearingPrice,
          fills.filledYesBuyVol,
          fills.filledNoBuyVol,
          fills.filledYesSellQty,
          fills.filledNoSellQty,
        ],
        ...chainGas(this.config.chainId),
      });
      await this.publicClient.waitForTransactionReceipt({ hash: lockHash });
      console.log(`[BatchProcessor] lockFunds tx: ${lockHash} — batch ${batchId} is LOCKED`);
    } else {
      console.log(`[BatchProcessor] Phase 1: skipped (batch ${batchId} already LOCKED)`);
    }

    // ─── Between phases: CLOB operations (vault-funded, zero relayer capital) ─
    //
    // After lockFunds:
    //   - Relayer wallet received `usdcForYesGap` USDC (vault-funded) → buy YES gap tokens
    //   - Relayer wallet received `usdcForNoGap`  USDC (vault-funded) → buy NO gap tokens
    //   - Relayer wallet received finalExcessYes YES tokens (vault-provided) → sell on CLOB
    //   - Relayer wallet received finalExcessNo  NO  tokens (vault-provided) → sell on CLOB
    //
    // Note: buys are blocking (FOK).  Excess sells are placed first (non-blocking) so
    // that USDC proceeds can settle before settleBatch pulls them from the relayer.

    // Sell excess YES tokens on CLOB first (relayer needs the USDC before settleBatch)
    if (cachedYesToken && finalExcessYes > 0n && this.config.chainId === 137) {
      const usdcExpected = (finalExcessYes * effectiveClearingPrice) / PRICE_DEC;
      console.log(`[BatchProcessor] Selling ${finalExcessYes} excess YES tokens on CLOB (expecting ${usdcExpected} USDC)`);
      try {
        const { orderId } = await this.polymarket.placeMarketSell(cachedYesToken, finalExcessYes);
        console.log(`[BatchProcessor] Excess YES sell placed: orderId=${orderId}`);
      } catch (sellErr) {
        console.warn(`[BatchProcessor] Excess YES sell failed (settleBatch may revert if USDC not received):`, sellErr);
      }
    } else if (finalExcessYes > 0n && this.config.chainId !== 137) {
      console.log(`[BatchProcessor] Testnet: skipping excess YES sell (${finalExcessYes} tokens)`);
    }

    if (cachedNoToken && finalExcessNo > 0n && this.config.chainId === 137) {
      const usdcExpected = (finalExcessNo * noPrice) / PRICE_DEC;
      console.log(`[BatchProcessor] Selling ${finalExcessNo} excess NO tokens on CLOB (expecting ${usdcExpected} USDC)`);
      try {
        const { orderId } = await this.polymarket.placeMarketSell(cachedNoToken, finalExcessNo);
        console.log(`[BatchProcessor] Excess NO sell placed: orderId=${orderId}`);
      } catch (sellErr) {
        console.warn(`[BatchProcessor] Excess NO sell failed (settleBatch may revert if USDC not received):`, sellErr);
      }
    } else if (finalExcessNo > 0n && this.config.chainId !== 137) {
      console.log(`[BatchProcessor] Testnet: skipping excess NO sell (${finalExcessNo} tokens)`);
    }

    // Buy gap YES tokens from CLOB using vault-provided USDC (blocking FOK)
    if (yesGap > 0n && cachedYesToken && this.config.chainId === 137) {
      const usdcForGap = (yesGap * effectiveClearingPrice) / PRICE_DEC;
      console.log(`[BatchProcessor] YES gap: buying ${yesGap} YES tokens via CLOB (${usdcForGap} vault-provided USDC)`);
      try {
        await this.polymarket.buyYesForSettlement(cachedYesToken, yesGap, usdcForGap, this.config.ctfAddress!);
        console.log(`[BatchProcessor] YES gap acquired ✓`);
      } catch (err) {
        console.error(`[BatchProcessor] CLOB YES gap buy failed — settleBatch will revert:`, err);
        throw err;
      }
    } else if (yesGap > 0n && this.config.chainId !== 137) {
      console.log(`[BatchProcessor] Testnet: skipping CLOB YES gap buy (${yesGap} tokens) — mock CTF`);
    }

    // Buy gap NO tokens from CLOB using vault-provided USDC (blocking FOK)
    if (noGap > 0n && cachedNoToken && this.config.chainId === 137) {
      const usdcForNoGap = (noGap * noPrice) / PRICE_DEC;
      console.log(`[BatchProcessor] NO gap: buying ${noGap} NO tokens via CLOB (${usdcForNoGap} vault-provided USDC)`);
      try {
        await this.polymarket.buyYesForSettlement(cachedNoToken, noGap, usdcForNoGap, this.config.ctfAddress!);
        console.log(`[BatchProcessor] NO gap acquired ✓`);
      } catch (err) {
        console.error(`[BatchProcessor] CLOB NO gap buy failed — settleBatch will revert:`, err);
        throw err;
      }
    } else if (noGap > 0n && this.config.chainId !== 137) {
      console.log(`[BatchProcessor] Testnet: skipping CLOB NO gap buy (${noGap} tokens) — mock CTF`);
    } else if (noGap > 0n && !cachedNoToken) {
      console.warn(`[BatchProcessor] NO gap=${noGap} but NO token ID unknown — settleBatch may revert`);
    }

    // ─── Phase 2: settleBatch ────────────────────────────────────────────────
    // Verifies ZK proof; pulls gap tokens (bought with vault-USDC) from relayer;
    // pulls USDC proceeds (from excess sells) from relayer; finalizes.
    console.log(`[BatchProcessor] Phase 2: calling settleBatch for batch ${batchId}`);
    const settleHash = await this._write({
      address: this.config.vaultAddress,
      abi: BATCH_VAULT_ABI,
      functionName: "settleBatch",
      args: [batchId, proof as `0x${string}`],
      ...chainGas(this.config.chainId),
    });

    await this.publicClient.waitForTransactionReceipt({ hash: settleHash });
    console.log(`[BatchProcessor] Batch ${batchId} settled! tx: ${settleHash}`);

    // Clean up order store
    await this.store.delete(batchId.toString());

    if (excludedOrders.length > 0) {
      console.log(`[BatchProcessor] ${excludedOrders.length} buy order(s) excluded — will be requeued to next batch`);
    }

    return { excludedOrders };
  }

  /**
   * Requeue excluded buy orders to the currently-open batch using pre-signed requeue sigs.
   *
   * Called by index.ts after processBatch() settles a batch. Each excluded order has
   * up to 2 pre-signed CommitOrder EIP-712 sigs (signed by the ephemeral wallet at
   * original submission time). Since batchId is no longer in the EIP-712 message (v6
   * contract), these sigs are valid for any batch — the relayer just calls commitOrderFor
   * with the next available requeue sig, routing the order into the newly-opened batch.
   *
   * Zero user interaction required — all sigs were created silently in-browser using
   * the ephemeral private key (no MetaMask popup).
   */
  async requeueExcludedOrders(
    excludedOrders: Array<{ order: Order; commitment: `0x${string}` }>,
    fromBatchId: bigint,
  ): Promise<RequeueResult[]> {
    const results: RequeueResult[] = [];

    for (const { order, commitment } of excludedOrders) {
      // Only BUY orders (YES_BUY / NO_BUY) can be requeued — sell orders pre-deposited tokens
      if (order.side !== OrderSide.YES_BUY && order.side !== OrderSide.NO_BUY) continue;
      if (!order.requeueAuths || order.requeueAuths.length === 0) {
        console.log(`[BatchProcessor] No requeue auths remaining for ${commitment} — cannot auto-requeue`);
        results.push({ commitment, status: "no_auths", fromBatchId, remainingAuths: 0 });
        continue;
      }

      // Pop the first available requeue auth (FIFO — nonce order matters)
      const [requeueAuth, ...remainingAuths] = order.requeueAuths;

      try {
        console.log(`[BatchProcessor] Requeueing excluded order ${commitment} (ephemeral=${requeueAuth.ephemeral}, nonce=${requeueAuth.nonce})`);

        const requeueFn = order.side === OrderSide.YES_BUY ? "commitOrderFor" : "commitBuyNoOrderFor";
        const hash = await this._write({
          address:      this.config.vaultAddress,
          abi:          BATCH_VAULT_ABI,
          functionName: requeueFn,
          args: [
            commitment,
            order.amount,
            requeueAuth.ephemeral,
            requeueAuth.nonce,
            requeueAuth.deadline,
            requeueAuth.signature,
            this.config.marketId,
          ],
          ...chainGas(this.config.chainId),
        });

        await this.publicClient.waitForTransactionReceipt({ hash });

        // Determine the new batch ID (the currently-open batch for this market)
        const newBatchId = await this.publicClient.readContract({
          address:      this.config.vaultAddress,
          abi:          BATCH_VAULT_ABI,
          functionName: "getCurrentBatchId",
          args:         [this.config.marketId],
        }) as bigint;

        // Save order under new batch with remaining requeue auths (may be 0 or 1 left)
        const updatedOrder: Order = { ...order, requeueAuths: remainingAuths };
        await this.store.save(newBatchId.toString(), commitment.toLowerCase(), updatedOrder);

        console.log(`[BatchProcessor] Requeued ${commitment} → batch ${newBatchId} (${remainingAuths.length} requeue auth(s) remaining)`);
        results.push({ commitment, status: "requeued", fromBatchId, toBatchId: newBatchId, remainingAuths: remainingAuths.length });
      } catch (err: any) {
        console.error(`[BatchProcessor] Failed to requeue ${commitment}:`, err.message);
        results.push({ commitment, status: "error", fromBatchId, remainingAuths: order.requeueAuths.length - 1, errorMessage: err.message });
      }
    }

    return results;
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  private async _fetchCommitments(batchId: bigint, count: number): Promise<Commitment[]> {
    const commitments: Commitment[] = [];
    for (let i = 0; i < count; i++) {
      const c = await this.publicClient.readContract({
        address: this.config.vaultAddress,
        abi: BATCH_VAULT_ABI,
        functionName: "getCommitment",
        args: [batchId, BigInt(i)],
      }) as { hash: `0x${string}`; amount: bigint; claimed: boolean };

      // Note: no `trader` field in Commitment struct (privacy model)
      commitments.push({ hash: c.hash, amount: c.amount, index: i });
    }
    return commitments;
  }

  /**
   * Match on-chain commitments to off-chain order details.
   *
   * Matching is done by commitment hash (stored as the key in the OrderStore).
   * This is correct because the Commitment struct no longer contains a trader
   * address — commitment hashes are the only identifier on-chain.
   */
  private async _matchOrdersToCommitments(
    batchId: bigint,
    commitments: Commitment[],
    marketId: `0x${string}`,
  ): Promise<Order[]> {
    const stored = await this.store.load(batchId.toString());
    if (!stored.size) return [];

    const matched: Order[] = [];
    for (const commitment of commitments) {
      // Look up by commitment hash (relayer stores with commitment.toLowerCase() as key)
      const order = stored.get(commitment.hash.toLowerCase());
      if (!order) {
        console.warn(`[BatchProcessor] No off-chain order for commitment ${commitment.hash} — skipping`);
        continue;
      }
      // Sanity check: verify computed hash matches
      const expectedHash = this._computeCommitmentHash(marketId, order);
      if (expectedHash.toLowerCase() !== commitment.hash.toLowerCase()) {
        console.warn(`[BatchProcessor] Commitment hash mismatch for ${commitment.hash} — expected ${expectedHash} — skipping`);
        continue;
      }
      matched.push(order);
    }
    return matched;
  }

  /**
   * Mirror BatchVault._computeCommitmentHash() (v8).
   * Hash = keccak256(abi.encode(marketId, uint8(side), amount, limitPrice, salt))
   * No trader address — privacy model.
   */
  private _computeCommitmentHash(marketId: `0x${string}`, order: Order): `0x${string}` {
    return keccak256(
      encodeAbiParameters(
        [
          { type: "bytes32" },
          { type: "uint8"   }, // OrderSide enum (v8: replaces bool isBuy from v7.3)
          { type: "uint256" },
          { type: "uint256" },
          { type: "bytes32" },
        ],
        [marketId, order.side, order.amount, order.limitPrice, order.salt],
      ),
    );
  }

  /** Build a standard binary Merkle tree over `leaves`. Returns all nodes (1-indexed). */
  static buildMerkleTree(leaves: `0x${string}`[]): `0x${string}`[] {
    if (leaves.length === 0) return [ZERO_BYTES32];
    // Always build a 512-leaf tree to match DEPTH=9 in circuits/claim/src/main.nr.
    // MAX_BATCH_ORDERS=500 < 512, so this is always sufficient.
    const n = 512;
    // nodes[0] unused, nodes[1] = root, nodes[n..2n-1] = leaves
    const nodes: `0x${string}`[] = new Array(2 * n).fill(ZERO_BYTES32);
    for (let i = 0; i < leaves.length; i++) {
      nodes[n + i] = leaves[i];
    }
    for (let i = n - 1; i > 0; i--) {
      nodes[i] = keccak256(
        encodeAbiParameters(
          [{ type: "bytes32" }, { type: "bytes32" }],
          [nodes[2 * i], nodes[2 * i + 1]],
        ),
      );
    }
    return nodes;
  }

  /** Get the Merkle path (sibling hashes) for a leaf at `leafIndex` in a tree of `n` leaves. */
  static getMerklePath(leaves: `0x${string}`[], leafIndex: number): `0x${string}`[] {
    const nodes = BatchProcessor.buildMerkleTree(leaves);
    const n = nodes.length / 2; // padded power-of-2 size
    const path: `0x${string}`[] = [];
    let pos = n + leafIndex;
    while (pos > 1) {
      const siblingPos = pos % 2 === 0 ? pos + 1 : pos - 1;
      path.push(nodes[siblingPos]);
      pos = Math.floor(pos / 2);
    }
    return path;
  }
}
