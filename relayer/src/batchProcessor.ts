import { createPublicClient, createWalletClient, http, encodeAbiParameters, keccak256 } from "viem";
import { polygon } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { computeClearingPrice } from "./clearingPrice.js";
import { ZKProver } from "./zkProver.js";
import { PolymarketClient } from "./polymarketClient.js";
import type { Order, Commitment, BatchInfo } from "./types.js";
import { BatchStatus } from "./types.js";

// BatchVault ABI — minimal subset needed by the relayer
const BATCH_VAULT_ABI = [
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
          { name: "trader", type: "address" },
          { name: "isBuy", type: "bool" },
          { name: "amount", type: "uint256" },
          { name: "limitPrice", type: "uint256" },
          { name: "salt", type: "bytes32" },
        ],
      },
      { name: "clearingPrice", type: "uint256" },
      { name: "totalBuyVol", type: "uint256" },
      { name: "totalSellVol", type: "uint256" },
      { name: "netBuyAmount", type: "uint256" },
      { name: "proof", type: "bytes" },
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
          { name: "marketId", type: "bytes32" },
          { name: "openedAt", type: "uint256" },
          { name: "closedAt", type: "uint256" },
          { name: "status", type: "uint8" },
          { name: "totalDeposited", type: "uint256" },
          { name: "clearingPrice", type: "uint256" },
          { name: "netBuyAmount", type: "uint256" },
          { name: "yesTokensReceived", type: "uint256" },
          { name: "commitmentCount", type: "uint256" },
          { name: "commitmentRoot", type: "bytes32" },
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
      { name: "index", type: "uint256" },
    ],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "hash", type: "bytes32" },
          { name: "amount", type: "uint256" },
          { name: "trader", type: "address" },
          { name: "claimed", type: "bool" },
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
      { name: "batchId", type: "uint256", indexed: true },
      { name: "trader", type: "address", indexed: true },
      { name: "commitment", type: "bytes32", indexed: false },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
  {
    name: "BatchClosed",
    type: "event",
    inputs: [
      { name: "batchId", type: "uint256", indexed: true },
      { name: "commitmentCount", type: "uint256", indexed: false },
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
  batchWindowMs: number; // default: 30_000 (matches contract BATCH_WINDOW)
}

/**
 * BatchProcessor: the off-chain relayer that drives the batch lifecycle.
 *
 * Responsibilities:
 *  1. Open batches on a schedule
 *  2. Listen for OrderCommitted events and collect order details from traders
 *     (traders send full order details to the relayer's API off-chain, or
 *      we retrieve them from a separate off-chain store)
 *  3. Close batches after BATCH_WINDOW elapses
 *  4. Compute clearing price from revealed orders
 *  5. Generate ZK proof
 *  6. Execute net position on Polymarket
 *  7. Call settleBatch() on-chain
 */
export class BatchProcessor {
  private publicClient: ReturnType<typeof createPublicClient>;
  private walletClient: ReturnType<typeof createWalletClient>;
  private account: ReturnType<typeof privateKeyToAccount>;
  private config: RelayerConfig;
  private zkProver: ZKProver;
  private polymarket: PolymarketClient;

  // In-memory store: batchId => trader => Order (off-chain order book)
  // In production: use a database (Redis, Postgres)
  private pendingOrders: Map<string, Map<string, Order>> = new Map();

  constructor(config: RelayerConfig) {
    this.config = config;
    this.account = privateKeyToAccount(config.relayerPrivateKey);

    this.publicClient = createPublicClient({
      chain: polygon,
      transport: http(config.rpcUrl),
    });

    this.walletClient = createWalletClient({
      chain: polygon,
      transport: http(config.rpcUrl),
      account: this.account,
    });

    this.zkProver = new ZKProver(false); // false = prototype mode (mock proofs)
    this.polymarket = new PolymarketClient(
      config.polymarket.apiKey,
      config.polymarket.apiSecret,
      config.polymarket.apiPassphrase
    );
  }

  // ─── Order intake (off-chain API endpoint) ────────────────────────────────

  /**
   * Accept an order from a trader.
   * The trader must have already submitted the commitment on-chain.
   * This stores the full order details for use at settlement time.
   */
  receiveOrder(batchId: bigint, order: Order): void {
    const key = batchId.toString();
    if (!this.pendingOrders.has(key)) {
      this.pendingOrders.set(key, new Map());
    }
    this.pendingOrders.get(key)!.set(order.trader.toLowerCase(), order);
    console.log(`[BatchProcessor] Received order from ${order.trader} for batch ${batchId}`);
  }

  // ─── Batch lifecycle ───────────────────────────────────────────────────────

  /** Open a new batch for a given Polymarket market */
  async openBatch(marketId: `0x${string}`): Promise<bigint> {
    console.log(`[BatchProcessor] Opening batch for market ${marketId}`);

    const hash = await this.walletClient.writeContract({
      address: this.config.vaultAddress,
      abi: BATCH_VAULT_ABI,
      functionName: "openBatch",
      args: [marketId],
    });

    const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
    const batchId = await this.publicClient.readContract({
      address: this.config.vaultAddress,
      abi: BATCH_VAULT_ABI,
      functionName: "currentBatchId",
    });

    console.log(`[BatchProcessor] Batch ${batchId} opened (tx: ${hash})`);
    return batchId;
  }

  /** Process a batch: close → compute clearing price → settle */
  async processBatch(batchId: bigint): Promise<void> {
    console.log(`[BatchProcessor] Processing batch ${batchId}`);

    // 1. Close the batch on-chain
    const closeHash = await this.walletClient.writeContract({
      address: this.config.vaultAddress,
      abi: BATCH_VAULT_ABI,
      functionName: "closeBatch",
    });
    await this.publicClient.waitForTransactionReceipt({ hash: closeHash });
    console.log(`[BatchProcessor] Batch ${batchId} closed`);

    // 2. Fetch all commitments from chain
    const batchInfo = await this.publicClient.readContract({
      address: this.config.vaultAddress,
      abi: BATCH_VAULT_ABI,
      functionName: "getBatch",
      args: [batchId],
    }) as BatchInfo;

    const commitments = await this._fetchCommitments(batchId, Number(batchInfo.commitmentCount));

    // 3. Match on-chain commitments to off-chain order details
    const orders = this._matchOrdersToCommitments(batchId, commitments, batchInfo.marketId);
    if (orders.length === 0) {
      console.log(`[BatchProcessor] No orders matched for batch ${batchId} — skipping`);
      return;
    }

    // 4. Compute clearing price
    const clearing = computeClearingPrice(orders);
    console.log(`[BatchProcessor] Clearing price: ${clearing.clearingPrice} (${orders.length} orders)`);
    console.log(`[BatchProcessor] Net buy amount: ${clearing.netBuyAmount} USDC`);

    // 5. Execute net position on Polymarket (if net buy > 0)
    if (clearing.netBuyAmount > 0n) {
      const market = await this.polymarket.getMarket(batchInfo.marketId.slice(2));
      const yesToken = market.tokens.find((t) => t.outcome === "Yes")?.token_id;
      if (yesToken) {
        console.log(`[BatchProcessor] Placing net buy of ${clearing.netBuyAmount} USDC on Polymarket`);
        await this.polymarket.placeMarketBuy(yesToken, clearing.netBuyAmount);
      }
    }

    // 6. Generate ZK proof
    const { proof } = await this.zkProver.generateProof({
      orders,
      commitments: commitments.map((c) => c.hash),
      clearingPrice: clearing.clearingPrice || 650_000n, // fallback price if no crossing
      netBuyAmount: clearing.netBuyAmount,
      filledBuyVolume: clearing.filledBuyVolume,
      filledSellVolume: clearing.filledSellVolume,
    });

    // 7. Settle on-chain
    const effectiveClearingPrice = clearing.clearingPrice || 650_000n;
    const settleHash = await this.walletClient.writeContract({
      address: this.config.vaultAddress,
      abi: BATCH_VAULT_ABI,
      functionName: "settleBatch",
      args: [
        batchId,
        orders.map((o) => ({
          trader: o.trader,
          isBuy: o.isBuy,
          amount: o.amount,
          limitPrice: o.limitPrice,
          salt: o.salt,
        })),
        effectiveClearingPrice,
        clearing.filledBuyVolume,
        clearing.filledSellVolume,
        clearing.netBuyAmount,
        proof as `0x${string}`,
      ],
    });

    await this.publicClient.waitForTransactionReceipt({ hash: settleHash });
    console.log(`[BatchProcessor] Batch ${batchId} settled! tx: ${settleHash}`);
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

      commitments.push({
        hash: c.hash,
        amount: c.amount,
        trader: c.trader,
        index: i,
      });
    }

    return commitments;
  }

  private _matchOrdersToCommitments(
    batchId: bigint,
    commitments: Commitment[],
    marketId: `0x${string}`
  ): Order[] {
    const key = batchId.toString();
    const stored = this.pendingOrders.get(key);
    if (!stored) return [];

    const matched: Order[] = [];

    for (const commitment of commitments) {
      const order = stored.get(commitment.trader.toLowerCase());
      if (!order) {
        console.warn(`[BatchProcessor] Missing order details for ${commitment.trader} — skipping`);
        continue;
      }

      // Verify the order matches the commitment
      const expectedHash = this._computeCommitmentHash(marketId, order);
      if (expectedHash !== commitment.hash) {
        console.warn(`[BatchProcessor] Commitment mismatch for ${commitment.trader} — skipping`);
        continue;
      }

      matched.push(order);
    }

    return matched;
  }

  /** Compute commitment hash matching BatchVault.commitOrder() */
  private _computeCommitmentHash(marketId: `0x${string}`, order: Order): `0x${string}` {
    return keccak256(
      encodeAbiParameters(
        [
          { type: "bytes32" },
          { type: "bool" },
          { type: "uint256" },
          { type: "uint256" },
          { type: "bytes32" },
          { type: "address" },
        ],
        [marketId, order.isBuy, order.amount, order.limitPrice, order.salt, order.trader]
      )
    );
  }
}
