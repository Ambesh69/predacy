import { Pool } from "pg";
import { encodeAbiParameters, getAddress, keccak256, type Address, type Hex } from "viem";
import { openV13Witness, PostgresV13WitnessVault, sealV13Witness } from "./v13BatchJournal.js";
import { buildV13RouteInputs, v13Nullifier, v13OrderCommitment, type V13MerkleWitness, type V13PrivateOrder } from "./v13Proofs.js";
import type { V13BuyRequest } from "./v13BuyRunner.js";

export interface V13QueuedOrder {
  marketId: Hex; positionTokenId: bigint; priceTick: bigint; depositWallet: Address;
  collateralAsset: Hex; positionAsset: Hex; receiptTokenHash: Hex; orderLeafIndex: number;
  order: Omit<V13PrivateOrder, "positionAsset" | "merkle">;
}
export interface V13Receipt { spent: bigint; shares: bigint; refund: bigint }
export type V13WitnessResolver = (leaves: Array<{ index: number; commitment: Hex; nullifier: Hex }>) =>
  Promise<Array<{ merkle: V13MerkleWitness; spent: boolean }>>;

function word(value: unknown, label: string): Hex {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error(`${label} must be bytes32`);
  return value as Hex;
}
function decimal(value: unknown, label: string): bigint {
  if (typeof value !== "string" || !/^\d+$/.test(value)) throw new Error(`${label} must be decimal`);
  return BigInt(value);
}

export function parseV13QueuedOrder(value: unknown): V13QueuedOrder {
  if (!value || typeof value !== "object") throw new Error("Invalid v13 private order");
  const data = value as Record<string, unknown>;
  if (!data.order || typeof data.order !== "object") throw new Error("Missing v13 order witness");
  const order = data.order as Record<string, unknown>;
  const leaf = decimal(order.orderLeafIndex, "orderLeafIndex");
  if (leaf >= 1_048_576n) throw new Error("orderLeafIndex exceeds tree capacity");
  if (typeof data.depositWallet !== "string") throw new Error("depositWallet must be an address");
  return {
    marketId: word(data.marketId, "marketId"),
    positionTokenId: decimal(data.positionTokenId, "positionTokenId"),
    priceTick: decimal(data.priceTick, "priceTick"), depositWallet: getAddress(data.depositWallet),
    collateralAsset: word(data.collateralAsset, "collateralAsset"),
    positionAsset: word(data.positionAsset, "positionAsset"),
    receiptTokenHash: word(data.receiptTokenHash, "receiptTokenHash"), orderLeafIndex: Number(leaf),
    order: { deposit: decimal(order.deposit, "deposit"), limitPrice: decimal(order.limitPrice, "limitPrice"),
      refundPublicKey: word(order.refundPublicKey, "refundPublicKey"),
      positionPublicKey: word(order.positionPublicKey, "positionPublicKey"),
      orderSecret: word(order.orderSecret, "orderSecret") },
  };
}

export function v13OrderGroupKey(order: V13QueuedOrder): Hex {
  if (order.positionTokenId <= 0n || order.priceTick <= 0n) throw new Error("Invalid v13 market parameters");
  return keccak256(encodeAbiParameters([
    { type: "bytes32" }, { type: "uint256" }, { type: "uint256" }, { type: "address" },
    { type: "bytes32" }, { type: "bytes32" },
  ], [order.marketId, order.positionTokenId, order.priceTick, getAddress(order.depositWallet),
    order.collateralAsset, order.positionAsset]));
}

function commitment(order: V13QueuedOrder): Hex {
  return v13OrderCommitment({ ...order.order, positionAsset: order.positionAsset });
}

export class PostgresV13OrderQueue {
  private constructor(private readonly pool: Pool, private readonly vault: PostgresV13WitnessVault,
    private readonly key: string, private readonly resolveWitnesses: V13WitnessResolver,
    private readonly executionEpochMs: number) {}

  static async connect(databaseUrl: string, key: string, resolveWitnesses: V13WitnessResolver,
    options: { executionEpochMs?: number } = {}) {
    const epoch = options.executionEpochMs ?? 60_000;
    if (!Number.isSafeInteger(epoch) || epoch < 0 || epoch > 3_600_000) throw new Error("Invalid v13 execution epoch");
    const pool = new Pool({ connectionString: databaseUrl, max: 2 });
    const vault = await PostgresV13WitnessVault.connect(databaseUrl, key);
    try {
      await pool.query(`CREATE TABLE IF NOT EXISTS v13_private_order_queue (
        order_commitment TEXT PRIMARY KEY,group_key TEXT NOT NULL,leaf_index INTEGER NOT NULL,
        ciphertext TEXT NOT NULL,witness_digest TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending',
        batch_id TEXT,receipt_ciphertext TEXT,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CHECK (state IN ('pending','batched')))`);
      await pool.query(`CREATE INDEX IF NOT EXISTS v13_private_order_ready
        ON v13_private_order_queue(group_key,state,created_at)`);
      return new PostgresV13OrderQueue(pool, vault, key, resolveWitnesses, epoch);
    } catch (error) { await Promise.all([pool.end(), vault.close()]); throw error; }
  }

  async enqueue(order: V13QueuedOrder) {
    const id = commitment(order); const groupKey = v13OrderGroupKey(order);
    const resolved = await this.resolveWitnesses([{ index: order.orderLeafIndex, commitment: id,
      nullifier: v13Nullifier(id, order.order.orderSecret, 6) }]);
    if (resolved.length !== 1) throw new Error("V13 order leaf was not found on-chain");
    if (typeof resolved[0].spent !== "boolean") throw new Error("V13 order spend status is unavailable");
    if (resolved[0].spent) throw new Error("V13 order has already been cancelled or routed");
    const sealed = sealV13Witness(id, order, this.key);
    const inserted = await this.pool.query(`INSERT INTO v13_private_order_queue
      (order_commitment,group_key,leaf_index,ciphertext,witness_digest) VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT DO NOTHING`, [id, groupKey, order.orderLeafIndex, sealed.ciphertext, sealed.digest]);
    if (inserted.rowCount !== 1) {
      const prior = await this.pool.query<{ witness_digest: string }>(
        "SELECT witness_digest FROM v13_private_order_queue WHERE order_commitment=$1", [id]);
      if (prior.rows[0]?.witness_digest !== sealed.digest) throw new Error("Different v13 witness uses this commitment");
    }
    return { commitment: id, groupKey };
  }

  async assemble(groupKey: Hex): Promise<{ batchId: Hex; request: V13BuyRequest } | null> {
    word(groupKey, "groupKey");
    const connection = await this.pool.connect();
    try {
      await connection.query("BEGIN");
      const excluded: string[] = [];
      // Exclusions are snapshot-local: a reorg must not permanently discard a user's order.
      while (true) {
        const ready = await connection.query<{ order_commitment: string; leaf_index: number; ciphertext: string }>(
          `SELECT order_commitment,leaf_index,ciphertext FROM v13_private_order_queue
           WHERE group_key=$1 AND state='pending' AND NOT (order_commitment=ANY($2::text[]))
           ORDER BY created_at,order_commitment LIMIT 32 FOR UPDATE`, [groupKey, excluded]);
        if (ready.rows.length < 2) {
          await connection.query("ROLLBACK");
          return null;
        }
        const queued = ready.rows.map((row) => openV13Witness<V13QueuedOrder>(row.order_commitment, row.ciphertext, this.key));
        if (queued.some((item) => v13OrderGroupKey(item).toLowerCase() !== groupKey.toLowerCase())) {
          throw new Error("Encrypted v13 queue grouping mismatch");
        }
        const candidates = ready.rows.map((row, index) => ({ index: row.leaf_index,
          commitment: word(row.order_commitment, "commitment"),
          nullifier: v13Nullifier(word(row.order_commitment, "commitment"), queued[index].order.orderSecret, 6) }));
        const states = await this.resolveWitnesses(candidates);
        if (states.length !== candidates.length || states.some((state) => typeof state.spent !== "boolean")) {
          throw new Error("V13 order spend status is unavailable");
        }
        const live = states.flatMap((state, index) => state.spent ? [] : [index]).slice(0, 2);
        if (live.length !== 2) {
          if (ready.rows.length < 32) {
            await connection.query("ROLLBACK");
            return null;
          }
          excluded.push(...candidates.filter((_leaf, index) => states[index].spent).map((leaf) => leaf.commitment));
          continue;
        }
        const leaves = live.map((index) => candidates[index]);
        const selected = live.map((index) => queued[index]);
        const witnesses = live.map((index) => states[index].merkle);
        if (witnesses[0].root.toLowerCase() !== witnesses[1].root.toLowerCase()) {
          throw new Error("V13 orders do not share the current pool root");
        }
        const first = selected[0]; const now = Date.now();
        const request: V13BuyRequest = { marketId: first.marketId, positionTokenId: first.positionTokenId,
          priceTick: first.priceTick, depositWallet: first.depositWallet,
          executeAfterUnixMs: this.executionEpochMs === 0 ? now
            : (Math.floor(now / this.executionEpochMs) + 1) * this.executionEpochMs,
          witness: { collateralAsset: first.collateralAsset, positionAsset: first.positionAsset, orders: [
            { ...selected[0].order, positionAsset: first.positionAsset, merkle: witnesses[0] },
            { ...selected[1].order, positionAsset: first.positionAsset, merkle: witnesses[1] },
          ] } };
        const batchId = buildV13RouteInputs(request.witness).binding;
        await this.vault.put(batchId, request, connection);
        const updated = await connection.query(`UPDATE v13_private_order_queue SET state='batched',batch_id=$1
          WHERE state='pending' AND order_commitment IN ($2,$3)`, [batchId, leaves[0].commitment, leaves[1].commitment]);
        if (updated.rowCount !== 2) throw new Error("V13 batch must claim both orders atomically");
        await connection.query("COMMIT");
        return { batchId, request };
      }
    } catch (error) {
      await connection.query("ROLLBACK");
      throw error;
    } finally { connection.release(); }
  }

  async pendingBatchIds(): Promise<Hex[]> {
    const result = await this.pool.query<{ batch_id: string }>(`SELECT batch_id FROM v13_private_order_queue
      WHERE state='batched' AND receipt_ciphertext IS NULL AND batch_id IS NOT NULL
      GROUP BY batch_id ORDER BY MIN(created_at)`);
    return result.rows.map((row) => word(row.batch_id, "batchId"));
  }
  async recordReceipts(batchId: Hex, request: V13BuyRequest, fills: Array<{ spent: bigint; shares: bigint }>) {
    if (fills.length !== 2) throw new Error("V13 receipt count mismatch");
    for (let i = 0; i < 2; i++) {
      const id = v13OrderCommitment(request.witness.orders[i]);
      const sealed = sealV13Witness(id, { spent: fills[i].spent, shares: fills[i].shares,
        refund: request.witness.orders[i].deposit - fills[i].spent } satisfies V13Receipt, this.key);
      const result = await this.pool.query(`UPDATE v13_private_order_queue SET receipt_ciphertext=$1
        WHERE order_commitment=$2 AND batch_id=$3 AND state='batched'`, [sealed.ciphertext, id, batchId]);
      if (result.rowCount !== 1) throw new Error("V13 receipt has no queued order");
    }
  }
  async getReceipt(id: Hex, token: Hex): Promise<V13Receipt | null> {
    const result = await this.pool.query<{ ciphertext: string; receipt_ciphertext: string | null }>(
      "SELECT ciphertext,receipt_ciphertext FROM v13_private_order_queue WHERE order_commitment=$1", [id]);
    if (!result.rows[0]) throw new Error("V13 private order not found");
    const order = openV13Witness<V13QueuedOrder>(id, result.rows[0].ciphertext, this.key);
    if (keccak256(token).toLowerCase() !== order.receiptTokenHash.toLowerCase()) throw new Error("Invalid v13 receipt token");
    return result.rows[0].receipt_ciphertext
      ? openV13Witness<V13Receipt>(id, result.rows[0].receipt_ciphertext, this.key) : null;
  }
  async close() { await Promise.all([this.pool.end(), this.vault.close()]); }
}
