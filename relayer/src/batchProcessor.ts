import { createPublicClient, createWalletClient, http, encodeAbiParameters, keccak256 } from "viem";
import { polygon, polygonAmoy } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { computeClearingPrice, computeFillsAtPrice } from "./clearingPrice.js";
import { ZKProver } from "./zkProver.js";
import { PolymarketClient } from "./polymarketClient.js";
import { createOrderStore, type OrderStore } from "./orderStore.js";
import type { Order, Commitment, BatchInfo, TransferAuth } from "./types.js";

// Polygon Amoy requires min 25 gwei priority fee. Apply to every write.
const AMOY_GAS = {
  maxPriorityFeePerGas: 30_000_000_000n, // 30 gwei
  maxFeePerGas:         35_000_000_000n, // 35 gwei
} as const;

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
          { name: "isBuy",      type: "bool"    },
          { name: "amount",     type: "uint256" },
          { name: "limitPrice", type: "uint256" },
          { name: "salt",       type: "bytes32" },
        ],
      },
      // EIP-3009 transfer authorizations — one per order (same index as orders[]).
      // For sell orders and unfilled buy orders, pass zero-value struct (ignored by contract).
      // `from` = ephemeral wallet address (source of USDC pull for filled buy orders).
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
          { name: "claimMerkleRoot",   type: "bytes32" },
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

export interface RelayerConfig {
  rpcUrl: string;
  chainId: number;          // 137 = Polygon mainnet, 80002 = Polygon Amoy
  vaultAddress: `0x${string}`;
  relayerPrivateKey: `0x${string}`;
  marketId: `0x${string}`;  // Polymarket condition ID this processor manages
  redisUrl?: string;        // Optional — falls back to in-memory if not set
  useRealZk?: boolean;      // true = generate real UltraHonk proofs via bb; default false (mock)
  adapterAddress?: `0x${string}`; // PublicInputAdapter address (required when useRealZk=true)
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
    );
    this.store = createOrderStore(config.redisUrl);
  }

  // ─── Order intake (called from HTTP /order endpoint) ──────────────────────

  /**
   * Privacy path: the trader signed an EIP-712 CommitOrder AND an EIP-3009
   * TransferWithAuthorization off-chain.
   *
   * The relayer calls commitOrderFor() on-chain (only relayer address visible),
   * then stores the order details + TransferAuth for settlement.
   *
   * At settlement, the stored TransferAuth for each filled buy order is submitted
   * to BatchVault.settleBatch(), which calls IUSDC.transferWithAuthorization()
   * to pull USDC from the user's wallet — no upfront deposit needed.
   *
   * @param batchId      Current batch ID
   * @param order        Full plaintext order (stored off-chain for settlement)
   * @param commitment   The keccak256 commitment hash (already computed by frontend)
   * @param signer       Trader's wallet address
   * @param nonce        EIP-712 nonce from nonces[signer] at signing time
   * @param deadline     Signature expiry (unix seconds)
   * @param signature    65-byte EIP-712 CommitOrder signature
   * @param transferAuth EIP-3009 authorization (buy orders only — undefined for sell orders)
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

    console.log(`[BatchProcessor] Submitting commitOrderFor on behalf of ${signer}`);

    const hash = await this._write({
      address: this.config.vaultAddress,
      abi: BATCH_VAULT_ABI,
      functionName: "commitOrderFor",
      args: [commitment, order.amount, signer, nonce, deadline, signature, this.config.marketId],
      ...AMOY_GAS,
    });

    await this.publicClient.waitForTransactionReceipt({ hash });
    console.log(`[BatchProcessor] commitOrderFor tx: ${hash} (trader=${signer} hidden)`);

    // Store order keyed by commitment hash — used for matching at settlement.
    // (Trader address not in on-chain Commitment struct — match by hash, not address)
    const orderWithAuth: Order = { ...order, trader: signer, transferAuth };
    await this.store.save(batchId.toString(), commitment.toLowerCase(), orderWithAuth);
    console.log(`[BatchProcessor] Stored order for commitment ${commitment} (batch ${batchId})`);
  }

  /**
   * Privacy path for SELL orders: trader signed an EIP-712 CommitOrder off-chain.
   * The relayer calls commitSellOrderFor() on-chain — YES tokens pulled from signer via
   * safeTransferFrom (requires signer to have called ctf.setApprovalForAll(vault, true)).
   *
   * Note: Sell orders don't need a TransferAuth (no USDC involved at order time).
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
    // Same hash verification as buy orders — prevent irrecoverable commitment mismatches.
    const expected = this._computeCommitmentHash(this.config.marketId, order);
    if (expected.toLowerCase() !== commitment.toLowerCase()) {
      throw new Error(
        `Commitment hash mismatch (sell) — order rejected. ` +
        `Expected: ${expected}, received: ${commitment}.`,
      );
    }

    console.log(`[BatchProcessor] Submitting commitSellOrderFor on behalf of ${signer}`);

    const hash = await this._write({
      address: this.config.vaultAddress,
      abi: BATCH_VAULT_ABI,
      functionName: "commitSellOrderFor",
      args: [commitment, order.amount, signer, nonce, deadline, signature, this.config.marketId],
      ...AMOY_GAS,
    });

    await this.publicClient.waitForTransactionReceipt({ hash });
    console.log(`[BatchProcessor] commitSellOrderFor tx: ${hash} (seller=${signer})`);

    // Sell orders: no TransferAuth (seller deposited YES tokens, not USDC)
    const orderWithTrader: Order = { ...order, trader: signer };
    await this.store.save(batchId.toString(), commitment.toLowerCase(), orderWithTrader);
    console.log(`[BatchProcessor] Stored sell order for commitment ${commitment} (batch ${batchId})`);
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
      ...AMOY_GAS,
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
      ...AMOY_GAS,
    });
    await this.publicClient.waitForTransactionReceipt({ hash });
    console.log(`[BatchProcessor] closeBatch tx: ${hash} (market: ${this.config.marketId})`);
  }

  /**
   * Process a closed batch:
   *   fetch commitments → match off-chain orders → compute clearing price
   *   → Polymarket execution → ZK proof → settleBatch on-chain
   *
   * EIP-3009 settlement: for each filled buy order, the stored TransferAuth
   * is included in settleBatch(). The contract calls IUSDC.transferWithAuthorization()
   * to pull USDC from the user's wallet — no relayer capital needed.
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

    // 3. Compute internal batch clearing price
    const clearing = computeClearingPrice(orders);
    console.log(
      `[BatchProcessor] Internal clearing: price=${clearing.clearingPrice}, ` +
      `buyVol=${clearing.filledBuyVolume}, sellVol=${clearing.filledSellVolume}, ` +
      `netBuy=${clearing.netBuyAmount}`,
    );

    // 4. Fetch Polymarket data + execute net position (only when API keys are set)
    let effectiveClearingPrice = clearing.clearingPrice;
    let cachedYesToken: string | undefined;

    // ─── 4a. Price discovery ──────────────────────────────────────────────────
    if (this.config.polymarket.apiKey) {
      try {
        const market = await this.polymarket.getMarket(batchInfo.marketId.slice(2));
        cachedYesToken = market.tokens.find((t) => t.outcome === "Yes")?.token_id;
        if (!cachedYesToken) throw new Error("YES token not found for market");

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

    if (effectiveClearingPrice === 0n) {
      effectiveClearingPrice = 650_000n; // 0.65 fallback when API not configured
      console.log(`[BatchProcessor] No Polymarket API — using fallback clearing price: ${effectiveClearingPrice}`);
    }

    console.log(`[BatchProcessor] Effective clearing price: ${effectiveClearingPrice}`);

    // 5. Re-compute fills at the effective clearing price.
    let fills = computeFillsAtPrice(orders, effectiveClearingPrice);
    console.log(
      `[BatchProcessor] Fills at effective price: buyVol=${fills.filledBuyVolume}, ` +
      `sellYes=${fills.filledSellYes}, netBuy=${fills.netBuyAmount}, netSellYes=${fills.netSellYes}`,
    );

    // ─── 4b. Order routing ────────────────────────────────────────────────────
    if (this.config.polymarket.apiKey && cachedYesToken) {
      try {
        if (fills.netBuyAmount > 0n) {
          const usdcStr = (Number(fills.netBuyAmount) / 1e6).toFixed(2);
          console.log(`[BatchProcessor] → Routing net BUY YES: $${usdcStr} USDC to Polymarket`);
          const { orderId, limitPrice } = await this.polymarket.placeMarketBuy(
            cachedYesToken,
            fills.netBuyAmount,
          );
          console.log(`[BatchProcessor] → Polymarket BUY order ${orderId} placed (limit ${limitPrice})`);

          if (clearing.clearingPrice === 0n) {
            effectiveClearingPrice = BigInt(Math.round(limitPrice * 1_000_000));
            fills = computeFillsAtPrice(orders, effectiveClearingPrice);
            console.log(`[BatchProcessor] → Refined clearing price to ${effectiveClearingPrice}`);
          }
        } else if (fills.netSellYes > 0n) {
          const yesStr = (Number(fills.netSellYes) / 1e6).toFixed(4);
          console.log(`[BatchProcessor] → Routing net SELL YES: ${yesStr} tokens to Polymarket`);
          const { orderId, limitPrice } = await this.polymarket.placeMarketSell(
            cachedYesToken,
            fills.netSellYes,
          );
          console.log(`[BatchProcessor] → Polymarket SELL order ${orderId} placed (limit ${limitPrice})`);
        } else {
          console.log(`[BatchProcessor] → No net position to route`);
        }
      } catch (err) {
        console.warn(`[BatchProcessor] Polymarket routing step failed (non-fatal):`, err);
      }
    }

    // 6. Generate ZK proof (mock in prototype mode; real proof when USE_REAL_ZK=true)
    const { proof } = await this.zkProver.generateProof({
      marketId:          batchInfo.marketId,
      orders,
      commitments:       commitments.map((c) => c.hash),
      clearingPrice:     effectiveClearingPrice,
      netBuyAmount:      fills.netBuyAmount,
      filledBuyVolume:   fills.filledBuyVolume,
      filledSellVolume:  fills.filledSellYes,
    });

    // 6b. PublicInputAdapter (real ZK only)
    if (this.config.useRealZk && this.config.adapterAddress) {
      console.log(`[BatchProcessor] Setting pendingOrderCount=${orders.length} on PublicInputAdapter`);
      const adapterHash = await this._write({
        address: this.config.adapterAddress,
        abi: ADAPTER_ABI,
        functionName: "setPendingOrderCount",
        args: [BigInt(orders.length)],
        ...AMOY_GAS,
      });
      await this.publicClient.waitForTransactionReceipt({ hash: adapterHash });
      console.log(`[BatchProcessor] PublicInputAdapter ready (tx: ${adapterHash})`);
    }

    // 7. Build EIP-3009 TransferAuth[] — one per order (parallel to orders[]).
    //    For filled buy orders: use stored TransferAuth (pulls USDC from user's wallet).
    //    For sell orders / unfilled buy orders: zero struct (contract skips these).
    const auths = orders.map((order) => {
      const isFilled = order.isBuy
        ? order.limitPrice >= effectiveClearingPrice
        : order.limitPrice <= effectiveClearingPrice;

      if (order.isBuy && isFilled && order.transferAuth) {
        console.log(`[BatchProcessor] Including TransferAuth for filled buy order (ephemeral=${order.trader})`);
        // Ensure `from` = ephemeral wallet address (stored as order.trader)
        return { ...order.transferAuth, from: order.trader };
      }

      if (order.isBuy && isFilled && !order.transferAuth) {
        console.warn(`[BatchProcessor] Filled buy order for ${order.trader} has no TransferAuth — settlement will fail for this order`);
      }

      return ZERO_TRANSFER_AUTH;
    });

    // 8. Settle on-chain
    const settleHash = await this._write({
      address: this.config.vaultAddress,
      abi: BATCH_VAULT_ABI,
      functionName: "settleBatch",
      args: [
        batchId,
        orders.map((o) => ({
          isBuy:      o.isBuy,
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

  /** Mirror BatchVault._executeCommit commitment hash computation (no trader address) */
  private _computeCommitmentHash(marketId: `0x${string}`, order: Order): `0x${string}` {
    return keccak256(
      encodeAbiParameters(
        [
          { type: "bytes32" },
          { type: "bool"    },
          { type: "uint256" },
          { type: "uint256" },
          { type: "bytes32" },
        ],
        [marketId, order.isBuy, order.amount, order.limitPrice, order.salt],
      ),
    );
  }

  /** Build a standard binary Merkle tree over `leaves`. Returns all nodes (1-indexed). */
  static buildMerkleTree(leaves: `0x${string}`[]): `0x${string}`[] {
    if (leaves.length === 0) return [ZERO_BYTES32];
    let n = 1;
    while (n < leaves.length) n <<= 1;
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
