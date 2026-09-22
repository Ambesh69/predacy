import { Pool } from "pg";
import { encodeAbiParameters, getAddress, keccak256, type Address, type Hex } from "viem";
import { openV12Witness, PostgresV12WitnessVault, sealV12Witness } from "./v12BatchJournal.js";
import { buildV12BuyBatchInputs, v12OrderCommitment, type V12PrivateBuyOrder } from "./v12BuyBatchProver.js";
import { v12BuyBatchId, type V12BuyBatchRequest } from "./v12BuyRunner.js";

export interface V12QueuedBuyOrder {
  marketId: Hex;
  positionTokenId: bigint;
  priceTick: bigint;
  depositWallet: Address;
  collateralAsset: Hex;
  positionAsset: Hex;
  receiptTokenHash: Hex;
  order: V12PrivateBuyOrder;
}

export interface V12PrivateReceipt {
  spent: bigint;
  shares: bigint;
  refund: bigint;
}

export interface V12BatchQueueState {
  orderCount: number;
  receiptCount: number;
}

function decimal(value: unknown, label: string): bigint {
  if (typeof value !== "string" || !/^\d+$/.test(value)) throw new Error(`${label} must be a decimal string`);
  return BigInt(value);
}

export function parseV12QueuedBuyOrder(value: unknown): V12QueuedBuyOrder {
  if (!value || typeof value !== "object") throw new Error("Invalid v12 private order");
  const data = value as Record<string, unknown>;
  const privateOrder = data.order;
  if (!privateOrder || typeof privateOrder !== "object") throw new Error("Missing v12 private order witness");
  const order = privateOrder as Record<string, unknown>;
  for (const [label, item] of Object.entries({
    marketId: data.marketId, collateralAsset: data.collateralAsset, positionAsset: data.positionAsset,
    receiptTokenHash: data.receiptTokenHash, inputNote: order.inputNote, salt: order.salt,
    refundPublicKey: order.refundPublicKey,
    positionPublicKey: order.positionPublicKey,
  })) {
    if (typeof item !== "string") throw new Error(`${label} must be bytes32`);
    assertWord(item, label);
  }
  if (typeof data.depositWallet !== "string") throw new Error("depositWallet must be an address");
  return {
    marketId: data.marketId as Hex,
    positionTokenId: decimal(data.positionTokenId, "positionTokenId"),
    priceTick: decimal(data.priceTick, "priceTick"),
    depositWallet: getAddress(data.depositWallet),
    collateralAsset: data.collateralAsset as Hex,
    positionAsset: data.positionAsset as Hex,
    receiptTokenHash: data.receiptTokenHash as Hex,
    order: {
      inputNote: order.inputNote as Hex,
      deposit: decimal(order.deposit, "deposit"),
      limitPrice: decimal(order.limitPrice, "limitPrice"),
      salt: order.salt as Hex,
      refundPublicKey: order.refundPublicKey as Hex,
      positionPublicKey: order.positionPublicKey as Hex,
    },
  };
}

function assertWord(value: string, label: string): asserts value is Hex {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error(`${label} must be bytes32`);
}

export function v12OrderGroupKey(order: V12QueuedBuyOrder): Hex {
  assertWord(order.marketId, "marketId");
  assertWord(order.collateralAsset, "collateralAsset");
  assertWord(order.positionAsset, "positionAsset");
  if (order.positionTokenId <= 0n || order.priceTick <= 0n) throw new Error("Invalid v12 market parameters");
  return keccak256(encodeAbiParameters(
    [
      { type: "bytes32" }, { type: "uint256" }, { type: "uint256" }, { type: "address" },
      { type: "bytes32" }, { type: "bytes32" },
    ],
    [order.marketId, order.positionTokenId, order.priceTick, getAddress(order.depositWallet),
      order.collateralAsset, order.positionAsset],
  ));
}

function validate(order: V12QueuedBuyOrder): { commitment: Hex; groupKey: Hex } {
  const groupKey = v12OrderGroupKey(order);
  const built = buildV12BuyBatchInputs({
    collateralAsset: order.collateralAsset,
    positionAsset: order.positionAsset,
    orders: [order.order],
    fills: [{ spent: 0n, shares: 0n }],
  });
  return { commitment: built.orderCommitments[0], groupKey };
}

/** Durable encrypted queue. Exactly two compatible orders are promoted into one executable witness. */
export class PostgresV12OrderQueue {
  private constructor(
    private readonly pool: Pool,
    private readonly witnessVault: PostgresV12WitnessVault,
    private readonly key: string,
    private readonly executionEpochMs: number,
  ) {}

  static async connect(
    databaseUrl: string,
    key: string,
    options: { executionEpochMs?: number } = {},
  ): Promise<PostgresV12OrderQueue> {
    const executionEpochMs = options.executionEpochMs ?? 60_000;
    if (!Number.isSafeInteger(executionEpochMs) || executionEpochMs < 0 || executionEpochMs > 3_600_000) {
      throw new Error("V12 execution epoch must be between 0 and 3600000 milliseconds");
    }
    const pool = new Pool({ connectionString: databaseUrl, max: 2 });
    const witnessVault = await PostgresV12WitnessVault.connect(databaseUrl, key);
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS v12_private_order_queue (
          order_commitment TEXT PRIMARY KEY,
          group_key TEXT NOT NULL,
          ciphertext TEXT NOT NULL,
          witness_digest TEXT NOT NULL,
          state TEXT NOT NULL DEFAULT 'pending',
          batch_id TEXT,
          receipt_ciphertext TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          CHECK (state IN ('pending', 'batched'))
        )
      `);
      await pool.query(`
        CREATE INDEX IF NOT EXISTS v12_private_order_queue_ready
        ON v12_private_order_queue (group_key, state, created_at)
      `);
      return new PostgresV12OrderQueue(pool, witnessVault, key, executionEpochMs);
    } catch (error) {
      await Promise.all([pool.end(), witnessVault.close()]);
      throw error;
    }
  }

  async enqueue(order: V12QueuedBuyOrder): Promise<{ commitment: Hex; groupKey: Hex }> {
    const { commitment, groupKey } = validate(order);
    const sealed = sealV12Witness(commitment, order, this.key);
    const inserted = await this.pool.query(`
      INSERT INTO v12_private_order_queue (order_commitment, group_key, ciphertext, witness_digest)
      VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING
    `, [commitment, groupKey, sealed.ciphertext, sealed.digest]);
    if (inserted.rowCount !== 1) {
      const existing = await this.pool.query<{ witness_digest: string }>(
        "SELECT witness_digest FROM v12_private_order_queue WHERE order_commitment = $1", [commitment],
      );
      if (existing.rows[0]?.witness_digest !== sealed.digest) {
        throw new Error("A different private order already uses this commitment");
      }
    }
    return { commitment, groupKey };
  }

  async assemble(groupKey: Hex): Promise<{ batchId: Hex; request: V12BuyBatchRequest } | null> {
    assertWord(groupKey, "groupKey");
    const ready = await this.pool.query<{ order_commitment: string; ciphertext: string }>(`
      SELECT order_commitment, ciphertext FROM v12_private_order_queue
      WHERE group_key = $1 AND state = 'pending'
      ORDER BY created_at, order_commitment LIMIT 2
    `, [groupKey]);
    if (ready.rows.length !== 2) return null;

    const queued = ready.rows.map((row) =>
      openV12Witness<V12QueuedBuyOrder>(row.order_commitment, row.ciphertext, this.key));
    if (queued.some((order) => v12OrderGroupKey(order).toLowerCase() !== groupKey.toLowerCase())) {
      throw new Error("Encrypted v12 queue grouping mismatch");
    }
    const first = queued[0];
    const now = Date.now();
    const executeAfterUnixMs = this.executionEpochMs === 0
      ? now
      : (Math.floor(now / this.executionEpochMs) + 1) * this.executionEpochMs;
    const request: V12BuyBatchRequest = {
      marketId: first.marketId,
      positionTokenId: first.positionTokenId,
      priceTick: first.priceTick,
      depositWallet: getAddress(first.depositWallet),
      executeAfterUnixMs,
      witness: {
        collateralAsset: first.collateralAsset,
        positionAsset: first.positionAsset,
        orders: queued.map((order) => order.order),
      },
    };
    const batchId = v12BuyBatchId(request);
    await this.witnessVault.put(batchId, request);
    const commitments = queued.map((order) => v12OrderCommitment(order.order, order.positionAsset));
    const updated = await this.pool.query(`
      UPDATE v12_private_order_queue SET state = 'batched', batch_id = $1
      WHERE state = 'pending' AND order_commitment IN ($2, $3)
    `, [batchId, commitments[0], commitments[1]]);
    if (updated.rowCount !== 2) return null;
    return { batchId, request };
  }

  /** Batches without a complete private receipt set must be resumed after a restart. */
  async pendingBatchIds(): Promise<Hex[]> {
    const result = await this.pool.query<{ batch_id: string }>(`
      SELECT batch_id FROM v12_private_order_queue
      WHERE state = 'batched' AND receipt_ciphertext IS NULL AND batch_id IS NOT NULL
      GROUP BY batch_id ORDER BY MIN(created_at)
    `);
    return result.rows.map((row) => {
      assertWord(row.batch_id, "batchId");
      return row.batch_id as Hex;
    });
  }

  async batchState(batchId: Hex): Promise<V12BatchQueueState | null> {
    assertWord(batchId, "batchId");
    const result = await this.pool.query<{ order_count: string; receipt_count: string }>(`
      SELECT COUNT(*)::text AS order_count,
             COUNT(receipt_ciphertext)::text AS receipt_count
      FROM v12_private_order_queue WHERE batch_id = $1
    `, [batchId]);
    const orderCount = Number(result.rows[0]?.order_count ?? "0");
    if (orderCount === 0) return null;
    return { orderCount, receiptCount: Number(result.rows[0].receipt_count) };
  }

  async recordReceipts(batchId: Hex, request: V12BuyBatchRequest, fills: Array<{ spent: bigint; shares: bigint }>): Promise<void> {
    assertWord(batchId, "batchId");
    if (fills.length !== request.witness.orders.length) throw new Error("V12 receipt count mismatch");
    for (let index = 0; index < fills.length; index += 1) {
      const order = request.witness.orders[index];
      const commitment = v12OrderCommitment(order, request.witness.positionAsset);
      const receipt: V12PrivateReceipt = {
        spent: fills[index].spent,
        shares: fills[index].shares,
        refund: order.deposit - fills[index].spent,
      };
      const sealed = sealV12Witness(commitment, receipt, this.key);
      const updated = await this.pool.query(`
        UPDATE v12_private_order_queue SET receipt_ciphertext = $1
        WHERE order_commitment = $2 AND batch_id = $3 AND state = 'batched'
      `, [sealed.ciphertext, commitment, batchId]);
      if (updated.rowCount !== 1) throw new Error("V12 receipt has no matching queued order");
    }
  }

  async getReceipt(commitment: Hex, receiptToken: Hex): Promise<V12PrivateReceipt | null> {
    assertWord(commitment, "orderCommitment");
    assertWord(receiptToken, "receiptToken");
    const result = await this.pool.query<{ ciphertext: string; receipt_ciphertext: string | null }>(`
      SELECT ciphertext, receipt_ciphertext FROM v12_private_order_queue WHERE order_commitment = $1
    `, [commitment]);
    if (!result.rows[0]) throw new Error("V12 private order not found");
    const order = openV12Witness<V12QueuedBuyOrder>(commitment, result.rows[0].ciphertext, this.key);
    if (keccak256(receiptToken).toLowerCase() !== order.receiptTokenHash.toLowerCase()) {
      throw new Error("Invalid v12 receipt token");
    }
    return result.rows[0].receipt_ciphertext
      ? openV12Witness<V12PrivateReceipt>(commitment, result.rows[0].receipt_ciphertext, this.key)
      : null;
  }

  async close(): Promise<void> {
    await Promise.all([this.pool.end(), this.witnessVault.close()]);
  }
}
