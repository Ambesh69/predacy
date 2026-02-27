import { createPublicClient, createWalletClient, http, encodeAbiParameters, keccak256 } from "viem";
import { polygon, polygonAmoy } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { computeClearingPrice, computeFillsAtPrice } from "./clearingPrice.js";
import { ZKProver } from "./zkProver.js";
import { PolymarketClient } from "./polymarketClient.js";
import { createOrderStore, type OrderStore } from "./orderStore.js";
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
    name: "commitOrderFor",
    type: "function",
    inputs: [
      { name: "commitment", type: "bytes32" },
      { name: "amount",     type: "uint256" },
      { name: "signer",     type: "address" },
      { name: "nonce",      type: "uint256" },
      { name: "deadline",   type: "uint256" },
      { name: "signature",  type: "bytes"   },
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
      { name: "netSellYes",    type: "uint256" },
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
          { name: "totalSellYes",      type: "uint256" },
          { name: "clearingPrice",     type: "uint256" },
          { name: "netBuyAmount",      type: "uint256" },
          { name: "yesTokensReceived", type: "uint256" },
          { name: "filledSellYes",     type: "uint256" },
          { name: "totalFilledBuyVol", type: "uint256" },
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
  // Note: events are not listed here — index.ts uses parseAbiItem() for getLogs
  // which avoids inflating the ABI union type (viem TypeScript inference degrades
  // beyond ~10 entries, causing spurious "chain missing" errors on writeContract).
] as const;

export interface RelayerConfig {
  rpcUrl: string;
  chainId: number;          // 137 = Polygon mainnet, 80002 = Polygon Amoy
  vaultAddress: `0x${string}`;
  relayerPrivateKey: `0x${string}`;
  redisUrl?: string;        // Optional — falls back to in-memory if not set
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

    this.zkProver = new ZKProver(false); // false = prototype mode (mock proofs)
    this.polymarket = new PolymarketClient(
      config.polymarket.apiKey,
      config.polymarket.apiSecret,
      config.polymarket.apiPassphrase,
    );
    this.store = createOrderStore(config.redisUrl);
  }

  // ─── Order intake (called from HTTP /order endpoint) ──────────────────────

  /**
   * Privacy path: the trader signed an EIP-712 CommitOrder off-chain.
   * The relayer calls commitOrderFor() on-chain (only relayer address visible),
   * then stores the order details for settlement.
   *
   * @param batchId    Current batch ID
   * @param order      Full plaintext order (stored off-chain for settlement)
   * @param commitment The keccak256 commitment hash (already computed by frontend)
   * @param signer     Trader's wallet address (appears in OrderCommitted as trader)
   * @param nonce      EIP-712 nonce from nonces[signer] at signing time
   * @param deadline   Signature expiry (unix seconds)
   * @param signature  65-byte EIP-712 signature
   */
  async submitCommitmentFor(
    batchId: bigint,
    order: Order,
    commitment: `0x${string}`,
    signer: `0x${string}`,
    nonce: bigint,
    deadline: bigint,
    signature: `0x${string}`,
  ): Promise<void> {
    console.log(`[BatchProcessor] Submitting commitOrderFor on behalf of ${signer}`);

    const hash = await this._write({
      address: this.config.vaultAddress,
      abi: BATCH_VAULT_ABI,
      functionName: "commitOrderFor",
      args: [commitment, order.amount, signer, nonce, deadline, signature],
      ...AMOY_GAS,
    });

    await this.publicClient.waitForTransactionReceipt({ hash });
    console.log(`[BatchProcessor] commitOrderFor tx: ${hash} (trader=${signer} hidden, relayer on-chain)`);

    // Store order details keyed by signer address for settlement matching
    await this.store.save(batchId.toString(), signer.toLowerCase(), { ...order, trader: signer });
    console.log(`[BatchProcessor] Stored private order from ${signer} for batch ${batchId}`);
  }

  /**
   * Privacy path for SELL orders: trader signed an EIP-712 CommitOrder off-chain.
   * The relayer calls commitSellOrderFor() on-chain — YES tokens pulled from signer via
   * safeTransferFrom (requires signer to have called ctf.setApprovalForAll(vault, true)).
   *
   * @param yesAmount  Number of YES tokens (6 decimals) to sell
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
    console.log(`[BatchProcessor] Submitting commitSellOrderFor on behalf of ${signer}`);

    const hash = await this._write({
      address: this.config.vaultAddress,
      abi: BATCH_VAULT_ABI,
      functionName: "commitSellOrderFor",
      args: [commitment, order.amount, signer, nonce, deadline, signature],
      ...AMOY_GAS,
    });

    await this.publicClient.waitForTransactionReceipt({ hash });
    console.log(`[BatchProcessor] commitSellOrderFor tx: ${hash} (seller=${signer} hidden)`);

    await this.store.save(batchId.toString(), signer.toLowerCase(), { ...order, trader: signer });
    console.log(`[BatchProcessor] Stored private sell order from ${signer} for batch ${batchId}`);
  }

  /**
   * Legacy path: trader already called commitOrder() directly (address visible on-chain).
   * Just store the off-chain order details for settlement.
   */
  async receiveOrder(batchId: bigint, order: Order): Promise<void> {
    await this.store.save(batchId.toString(), order.trader.toLowerCase(), order);
    console.log(`[BatchProcessor] Stored order from ${order.trader} for batch ${batchId}`);
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
    const hash = await this._write({
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
    // or hash computed with wrong marketId), we CANNOT settle this batch — calling
    // settleBatch would revert with CommitmentMismatch every time.
    // Throw early to let the poll handler count failures and force-skip the batch.
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

    // 3. Compute internal batch clearing price (finds optimal crossing price if buys+sells cross)
    const clearing = computeClearingPrice(orders);
    console.log(
      `[BatchProcessor] Internal clearing: price=${clearing.clearingPrice}, ` +
      `buyVol=${clearing.filledBuyVolume}, sellVol=${clearing.filledSellVolume}, ` +
      `netBuy=${clearing.netBuyAmount}`,
    );

    // 4. Fetch Polymarket data + execute net position (only when API keys are set)
    //
    // Split into two phases:
    //   Phase A (price discovery) — runs before computeFillsAtPrice so the correct price
    //     is used when computing fills. Fetches the YES token ID and, if no internal
    //     crossing occurred, anchors effectiveClearingPrice to the live Polymarket mid.
    //   Phase B (order routing) — runs after computeFillsAtPrice, using the correct
    //     net positions (netBuyAmount / netSellYes) at the effective price.
    let effectiveClearingPrice = clearing.clearingPrice;
    let cachedYesToken: string | undefined;

    // ─── 4a. Price discovery ──────────────────────────────────────────────────
    if (this.config.polymarket.apiKey) {
      try {
        const market = await this.polymarket.getMarket(batchInfo.marketId.slice(2));
        cachedYesToken = market.tokens.find((t) => t.outcome === "Yes")?.token_id;
        if (!cachedYesToken) throw new Error("YES token not found for market");

        // When no internal crossing occurred, anchor clearing price to Polymarket mid
        if (effectiveClearingPrice === 0n) {
          const mid = await this.polymarket.getMidPrice(cachedYesToken);
          effectiveClearingPrice = BigInt(Math.round(mid * 1_000_000));
          console.log(
            `[BatchProcessor] No internal crossing — anchoring to Polymarket mid: ` +
            `${mid} → ${effectiveClearingPrice}`,
          );
        }
      } catch (err) {
        console.warn(`[BatchProcessor] Polymarket price-discovery step failed (non-fatal):`, err);
      }
    }

    // Final safety: contract rejects clearingPrice === 0.
    // Use 65¢ fallback for all batches (buy-only, sell-only, or empty) when there is no
    // internal crossing and no Polymarket API configured.
    // For sell-only batches: BatchVault._executeSellOnPolymarket calls MockCTF.mockSellYes,
    // which burns YES tokens from the vault and mints the corresponding USDC to the vault —
    // so no buyer deposits are needed to fund the seller payout.
    if (effectiveClearingPrice === 0n) {
      effectiveClearingPrice = 650_000n; // 0.65 fallback when API not configured
      console.log(`[BatchProcessor] No Polymarket API — using fallback clearing price: ${effectiveClearingPrice}`);
    }

    console.log(`[BatchProcessor] Effective clearing price: ${effectiveClearingPrice}`);

    // 5. Re-compute fills at the effective clearing price.
    //    The internal clearing algorithm may have returned price=0 (no crossing) or a price that
    //    differs from effectiveClearingPrice (Polymarket mid). computeFillsAtPrice gives the
    //    correct filled volumes and net positions for the actual price used at settlement.
    let fills = computeFillsAtPrice(orders, effectiveClearingPrice);
    console.log(
      `[BatchProcessor] Fills at effective price: buyVol=${fills.filledBuyVolume}, ` +
      `sellYes=${fills.filledSellYes}, netBuy=${fills.netBuyAmount}, netSellYes=${fills.netSellYes}`,
    );

    // ─── 4b. Order routing (buy or sell to Polymarket CLOB) ──────────────────
    if (this.config.polymarket.apiKey && cachedYesToken) {
      try {
        if (fills.netBuyAmount > 0n) {
          // Route net buy: spend USDC to acquire YES tokens for buyers
          const usdcStr = (Number(fills.netBuyAmount) / 1e6).toFixed(2);
          console.log(`[BatchProcessor] → Routing net BUY YES: $${usdcStr} USDC to Polymarket`);
          const { orderId, limitPrice } = await this.polymarket.placeMarketBuy(
            cachedYesToken,
            fills.netBuyAmount,
          );
          console.log(`[BatchProcessor] → Polymarket BUY order ${orderId} placed (limit ${limitPrice})`);

          // If price came from Polymarket mid (no internal cross), refine effectiveClearingPrice
          // to the actual limit price used, then re-compute fills for accurate settlement params.
          if (clearing.clearingPrice === 0n) {
            effectiveClearingPrice = BigInt(Math.round(limitPrice * 1_000_000));
            fills = computeFillsAtPrice(orders, effectiveClearingPrice);
            console.log(`[BatchProcessor] → Refined clearing price to ${effectiveClearingPrice}`);
          }
        } else if (fills.netSellYes > 0n) {
          // Route net sell: sell excess YES tokens on Polymarket for USDC
          const yesStr = (Number(fills.netSellYes) / 1e6).toFixed(4);
          console.log(`[BatchProcessor] → Routing net SELL YES: ${yesStr} tokens to Polymarket`);
          const { orderId, limitPrice } = await this.polymarket.placeMarketSell(
            cachedYesToken,
            fills.netSellYes,
          );
          console.log(`[BatchProcessor] → Polymarket SELL order ${orderId} placed (limit ${limitPrice})`);
        } else {
          console.log(`[BatchProcessor] → No net position to route (fully matched internally or zero orders)`);
        }
      } catch (err) {
        // Non-fatal: settlement proceeds on-chain with best-effort clearing price
        console.warn(`[BatchProcessor] Polymarket routing step failed (non-fatal):`, err);
      }
    }

    // 6. Generate ZK proof (mock in prototype mode)
    const { proof } = await this.zkProver.generateProof({
      orders,
      commitments: commitments.map((c) => c.hash),
      clearingPrice: effectiveClearingPrice,
      netBuyAmount:      fills.netBuyAmount,
      filledBuyVolume:   fills.filledBuyVolume,
      filledSellVolume:  fills.filledSellYes,
    });

    // 7. Settle on-chain
    const settleHash = await this._write({
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
        fills.filledBuyVolume,
        fills.filledSellYes,
        fills.netBuyAmount,
        fills.netSellYes,
        proof as `0x${string}`,
      ],
      ...AMOY_GAS,
    });

    await this.publicClient.waitForTransactionReceipt({ hash: settleHash });
    console.log(`[BatchProcessor] Batch ${batchId} settled! tx: ${settleHash}`);

    // Clean up order store
    await this.store.delete(batchId.toString());
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

  private async _matchOrdersToCommitments(
    batchId: bigint,
    commitments: Commitment[],
    marketId: `0x${string}`,
  ): Promise<Order[]> {
    const stored = await this.store.load(batchId.toString());
    if (!stored.size) return [];

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
