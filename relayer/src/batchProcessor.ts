import { createPublicClient, createWalletClient, http, encodeAbiParameters, keccak256 } from "viem";
import { polygonAmoy } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { computeClearingPrice } from "./clearingPrice.js";
import { ZKProver } from "./zkProver.js";
import { PolymarketClient } from "./polymarketClient.js";
import type { Order, Commitment, BatchInfo } from "./types.js";

// Polygon Amoy requires min 25 gwei priority fee. Apply to every write.
const AMOY_GAS = {
  maxPriorityFeePerGas: 30_000_000_000n, // 30 gwei
  maxFeePerGas:         35_000_000_000n, // 35 gwei
} as const;

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
    inputs: [],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    name: "settleBatch",
    type: "function",
    inputs: [
      { name: "batchId", type: "uint256" },
      {
        name: "orders",
        type: "tuple[]",
        components: [
          { name: "trader",     type: "address" },
          { name: "isBuy",      type: "bool"    },
          { name: "amount",     type: "uint256" },
          { name: "limitPrice", type: "uint256" },
          { name: "salt",       type: "bytes32" },
        ],
      },
      { name: "clearingPrice", type: "uint256" },
      { name: "totalBuyVol",   type: "uint256" },
      { name: "totalSellVol",  type: "uint256" },
      { name: "netBuyAmount",  type: "uint256" },
      { name: "proof",         type: "bytes"   },
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
        components: [
          { name: "marketId",          type: "bytes32" },
          { name: "openedAt",          type: "uint256" },
          { name: "closedAt",          type: "uint256" },
          { name: "status",            type: "uint8"   },
          { name: "totalDeposited",    type: "uint256" },
          { name: "clearingPrice",     type: "uint256" },
          { name: "netBuyAmount",      type: "uint256" },
          { name: "yesTokensReceived", type: "uint256" },
          { name: "commitmentCount",   type: "uint256" },
          { name: "commitmentRoot",    type: "bytes32" },
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
        components: [
          { name: "hash",    type: "bytes32" },
          { name: "amount",  type: "uint256" },
          { name: "trader",  type: "address" },
          { name: "claimed", type: "bool"    },
        ],
      },
    ],
    stateMutability: "view",
  },
  {
    name: "currentBatchId",
    type: "function",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  // Events
  {
    name: "OrderCommitted",
    type: "event",
    inputs: [
      { name: "batchId",    type: "uint256", indexed: true  },
      { name: "trader",     type: "address", indexed: true  },
      { name: "commitment", type: "bytes32", indexed: false },
      { name: "amount",     type: "uint256", indexed: false },
    ],
  },
  {
    name: "BatchClosed",
    type: "event",
    inputs: [
      { name: "batchId",         type: "uint256", indexed: true  },
      { name: "commitmentCount", type: "uint256", indexed: false },
    ],
  },
  {
    name: "BatchSettled",
    type: "event",
    inputs: [
      { name: "batchId",           type: "uint256", indexed: true  },
      { name: "clearingPrice",     type: "uint256", indexed: false },
      { name: "totalBuyVolume",    type: "uint256", indexed: false },
      { name: "totalSellVolume",   type: "uint256", indexed: false },
      { name: "netBuyAmount",      type: "uint256", indexed: false },
      { name: "yesTokensReceived", type: "uint256", indexed: false },
    ],
  },
] as const;

export interface RelayerConfig {
  rpcUrl: string;
  vaultAddress: `0x${string}`;
  relayerPrivateKey: `0x${string}`;
  polymarket: {
    apiKey: string;
    apiSecret: string;
    apiPassphrase: string;
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
 *  7. Call settleBatch() on-chain
 */
export class BatchProcessor {
  private publicClient: ReturnType<typeof createPublicClient>;
  private walletClient: ReturnType<typeof createWalletClient>;
  private config: RelayerConfig;
  private zkProver: ZKProver;
  private polymarket: PolymarketClient;

  // In-memory store: batchId => trader => Order (off-chain order book)
  // Production: use Redis/Postgres
  private pendingOrders: Map<string, Map<string, Order>> = new Map();

  constructor(config: RelayerConfig) {
    this.config = config;
    const account = privateKeyToAccount(config.relayerPrivateKey);

    this.publicClient = createPublicClient({
      chain: polygonAmoy,
      transport: http(config.rpcUrl),
    });

    this.walletClient = createWalletClient({
      chain: polygonAmoy,
      transport: http(config.rpcUrl),
      account,
    });

    this.zkProver = new ZKProver(false); // false = prototype mode (mock proofs)
    this.polymarket = new PolymarketClient(
      config.polymarket.apiKey,
      config.polymarket.apiSecret,
      config.polymarket.apiPassphrase,
    );
  }

  // ─── Order intake (called from HTTP /order endpoint) ──────────────────────

  /**
   * Store off-chain order details from a trader.
   * The trader must have already submitted the commitment on-chain first.
   */
  receiveOrder(batchId: bigint, order: Order): void {
    const key = batchId.toString();
    if (!this.pendingOrders.has(key)) {
      this.pendingOrders.set(key, new Map());
    }
    this.pendingOrders.get(key)!.set(order.trader.toLowerCase(), order);
    console.log(`[BatchProcessor] Stored order from ${order.trader} for batch ${batchId}`);
  }

  /** Returns how many off-chain orders are stored for a batch */
  orderCount(batchId: bigint): number {
    return this.pendingOrders.get(batchId.toString())?.size ?? 0;
  }

  // ─── Batch lifecycle ───────────────────────────────────────────────────────

  /** Open a new batch for a given Polymarket market (relayer-only on-chain call) */
  async openBatch(marketId: `0x${string}`): Promise<bigint> {
    console.log(`[BatchProcessor] Opening batch for market ${marketId}`);

    const hash = await this.walletClient.writeContract({
      address: this.config.vaultAddress,
      abi: BATCH_VAULT_ABI,
      functionName: "openBatch",
      args: [marketId],
      ...AMOY_GAS,
    });

    await this.publicClient.waitForTransactionReceipt({ hash });

    const batchId = await this.publicClient.readContract({
      address: this.config.vaultAddress,
      abi: BATCH_VAULT_ABI,
      functionName: "currentBatchId",
    }) as bigint;

    console.log(`[BatchProcessor] Batch ${batchId} opened (tx: ${hash})`);
    return batchId;
  }

  /** Close the current batch (anyone can call after BATCH_WINDOW expires) */
  async closeBatch(): Promise<void> {
    const hash = await this.walletClient.writeContract({
      address: this.config.vaultAddress,
      abi: BATCH_VAULT_ABI,
      functionName: "closeBatch",
      ...AMOY_GAS,
    });
    await this.publicClient.waitForTransactionReceipt({ hash });
    console.log(`[BatchProcessor] closeBatch tx: ${hash}`);
  }

  /**
   * Process a closed batch:
   *   fetch commitments → match off-chain orders → compute clearing price
   *   → Polymarket execution → ZK proof → settleBatch on-chain
   */
  async processBatch(batchId: bigint): Promise<void> {
    console.log(`[BatchProcessor] Processing batch ${batchId}`);

    // 1. Fetch on-chain batch info + commitments
    const batchInfo = await this.publicClient.readContract({
      address: this.config.vaultAddress,
      abi: BATCH_VAULT_ABI,
      functionName: "getBatch",
      args: [batchId],
    }) as BatchInfo;

    const commitments = await this._fetchCommitments(batchId, Number(batchInfo.commitmentCount));
    console.log(`[BatchProcessor] ${commitments.length} on-chain commitments`);

    // 2. Match to off-chain order details (verifies commitment hashes)
    const orders = this._matchOrdersToCommitments(batchId, commitments, batchInfo.marketId);
    console.log(`[BatchProcessor] ${orders.length}/${commitments.length} orders matched`);

    if (orders.length === 0) {
      console.log(`[BatchProcessor] No matched orders — skipping settlement`);
      return;
    }

    // 3. Compute batch clearing price
    const clearing = computeClearingPrice(orders);
    console.log(
      `[BatchProcessor] Clearing: internalPrice=${clearing.clearingPrice}, ` +
      `buyVol=${clearing.filledBuyVolume}, sellVol=${clearing.filledSellVolume}, ` +
      `netBuy=${clearing.netBuyAmount}`,
    );

    // 4. Fetch Polymarket data + execute net position (only when API keys are set)
    //
    // When the batch has an internal clearing price (orders crossed), use it.
    // When there's no crossing (e.g. all-buy batch or no overlapping limits),
    // fetch the live Polymarket mid price instead so settlement is anchored to
    // real market data rather than an arbitrary fallback constant.
    let effectiveClearingPrice = clearing.clearingPrice;

    if (this.config.polymarket.apiKey) {
      try {
        // Single market fetch shared by both the price-discovery and routing steps
        const market   = await this.polymarket.getMarket(batchInfo.marketId.slice(2));
        const yesToken = market.tokens.find((t) => t.outcome === "Yes")?.token_id;

        if (!yesToken) throw new Error("YES token not found for market");

        // When no internal crossing occurred, anchor clearing price to Polymarket mid
        if (effectiveClearingPrice === 0n) {
          const mid = await this.polymarket.getMidPrice(yesToken);
          effectiveClearingPrice = BigInt(Math.round(mid * 1_000_000));
          console.log(
            `[BatchProcessor] No internal crossing — anchoring to Polymarket mid: ` +
            `${mid} → ${effectiveClearingPrice}`,
          );
        }

        // Route net buy position to Polymarket
        if (clearing.netBuyAmount > 0n) {
          const usdcStr = (Number(clearing.netBuyAmount) / 1e6).toFixed(2);
          console.log(`[BatchProcessor] → Routing net BUY YES: $${usdcStr} USDC to Polymarket`);
          const { orderId, limitPrice } = await this.polymarket.placeMarketBuy(yesToken, clearing.netBuyAmount);
          console.log(`[BatchProcessor] → Polymarket order ${orderId} placed (limit ${limitPrice})`);

          // If clearing was settled by Polymarket (no internal cross), use the
          // actual limit price used on Polymarket so settlement reflects reality.
          if (clearing.clearingPrice === 0n) {
            effectiveClearingPrice = BigInt(Math.round(limitPrice * 1_000_000));
          }
        } else {
          console.log(`[BatchProcessor] → No net position to route (fully matched internally or zero buys)`);
        }
      } catch (err) {
        // Non-fatal: settlement proceeds on-chain with best-effort clearing price
        console.warn(`[BatchProcessor] Polymarket step failed (non-fatal):`, err);
      }
    }

    // Final safety: never settle with price = 0 (contract would reject)
    if (effectiveClearingPrice === 0n) {
      effectiveClearingPrice = 650_000n; // 0.65 fallback when API not configured
      console.log(`[BatchProcessor] No Polymarket API — using fallback clearing price: ${effectiveClearingPrice}`);
    }

    console.log(`[BatchProcessor] Effective clearing price: ${effectiveClearingPrice}`);

    // 5. Generate ZK proof (mock in prototype mode)
    const { proof } = await this.zkProver.generateProof({
      orders,
      commitments: commitments.map((c) => c.hash),
      clearingPrice: effectiveClearingPrice,
      netBuyAmount: clearing.netBuyAmount,
      filledBuyVolume: clearing.filledBuyVolume,
      filledSellVolume: clearing.filledSellVolume,
    });

    // 6. Settle on-chain
    const settleHash = await this.walletClient.writeContract({
      address: this.config.vaultAddress,
      abi: BATCH_VAULT_ABI,
      functionName: "settleBatch",
      args: [
        batchId,
        orders.map((o) => ({
          trader:     o.trader,
          isBuy:      o.isBuy,
          amount:     o.amount,
          limitPrice: o.limitPrice,
          salt:       o.salt,
        })),
        effectiveClearingPrice,
        clearing.filledBuyVolume,
        clearing.filledSellVolume,
        clearing.netBuyAmount,
        proof as `0x${string}`,
      ],
      ...AMOY_GAS,
    });

    await this.publicClient.waitForTransactionReceipt({ hash: settleHash });
    console.log(`[BatchProcessor] Batch ${batchId} settled! tx: ${settleHash}`);

    // Clean up in-memory store
    this.pendingOrders.delete(batchId.toString());
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
      }) as { hash: `0x${string}`; amount: bigint; trader: `0x${string}`; claimed: boolean };

      commitments.push({ hash: c.hash, amount: c.amount, trader: c.trader, index: i });
    }
    return commitments;
  }

  private _matchOrdersToCommitments(
    batchId: bigint,
    commitments: Commitment[],
    marketId: `0x${string}`,
  ): Order[] {
    const stored = this.pendingOrders.get(batchId.toString());
    if (!stored) return [];

    const matched: Order[] = [];
    for (const commitment of commitments) {
      const order = stored.get(commitment.trader.toLowerCase());
      if (!order) {
        console.warn(`[BatchProcessor] No off-chain order for ${commitment.trader} — skipping`);
        continue;
      }
      const expectedHash = this._computeCommitmentHash(marketId, order);
      if (expectedHash.toLowerCase() !== commitment.hash.toLowerCase()) {
        console.warn(`[BatchProcessor] Commitment mismatch for ${commitment.trader} — skipping`);
        continue;
      }
      matched.push(order);
    }
    return matched;
  }

  /** Mirror BatchVault.commitOrder() commitment hash computation */
  private _computeCommitmentHash(marketId: `0x${string}`, order: Order): `0x${string}` {
    return keccak256(
      encodeAbiParameters(
        [
          { type: "bytes32" },
          { type: "bool"    },
          { type: "uint256" },
          { type: "uint256" },
          { type: "bytes32" },
          { type: "address" },
        ],
        [marketId, order.isBuy, order.amount, order.limitPrice, order.salt, order.trader],
      ),
    );
  }
}
