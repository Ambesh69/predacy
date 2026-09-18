import { Pool } from "pg";
import type { SignedOrder } from "@polymarket/client/actions";

export type V11OrderState = "prepared" | "submitting" | "accepted" | "rejected" | "uncertain" | "settled";

export interface V11OrderIntent {
  batchId: string;
  legId: string;
  state: V11OrderState;
  signedOrder: SignedOrder;
  orderId: string | null;
  response: unknown | null;
  error: string | null;
}

export interface V11OrderJournal {
  prepare(batchId: string, legId: string, signedOrder: SignedOrder): Promise<V11OrderIntent>;
  claimForSubmission(batchId: string, legId: string): Promise<V11OrderIntent | null>;
  recordAccepted(batchId: string, legId: string, orderId: string, response: unknown): Promise<void>;
  recordRejected(batchId: string, legId: string, response: unknown): Promise<void>;
  recordUncertain(batchId: string, legId: string, error: string): Promise<void>;
  get(batchId: string, legId: string): Promise<V11OrderIntent | null>;
  listUnresolved(): Promise<V11OrderIntent[]>;
}

interface IntentRow {
  batch_id: string;
  leg_id: string;
  state: V11OrderState;
  signed_order: SignedOrder;
  order_id: string | null;
  response: unknown | null;
  error: string | null;
}

function fromRow(row: IntentRow): V11OrderIntent {
  return {
    batchId: row.batch_id,
    legId: row.leg_id,
    state: row.state,
    signedOrder: row.signed_order,
    orderId: row.order_id,
    response: row.response,
    error: row.error,
  };
}

/** A separate durable store is mandatory for v11; Redis and process memory are not fallbacks. */
export class PostgresV11OrderJournal implements V11OrderJournal {
  private constructor(private readonly pool: Pool) {}

  static async connect(databaseUrl: string): Promise<PostgresV11OrderJournal> {
    if (!databaseUrl) throw new Error("V11_DATABASE_URL is required for live order execution");
    const pool = new Pool({ connectionString: databaseUrl, max: 4 });
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS v11_order_intents (
          batch_id TEXT NOT NULL,
          leg_id TEXT NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('prepared','submitting','accepted','rejected','uncertain','settled')),
          signed_order JSONB NOT NULL,
          order_id TEXT,
          response JSONB,
          error TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (batch_id, leg_id)
        )
      `);
      return new PostgresV11OrderJournal(pool);
    } catch (error) {
      await pool.end();
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async prepare(batchId: string, legId: string, signedOrder: SignedOrder): Promise<V11OrderIntent> {
    this.assertKey(batchId, legId);
    const orderJson = JSON.stringify(signedOrder);
    if (!orderJson || orderJson === "{}") throw new Error("Signed CLOB order is required");
    const inserted = await this.pool.query<IntentRow>(`
      INSERT INTO v11_order_intents (batch_id, leg_id, state, signed_order)
      VALUES ($1, $2, 'prepared', $3::jsonb)
      ON CONFLICT DO NOTHING
      RETURNING *
    `, [batchId, legId, orderJson]);
    if (inserted.rows[0]) return fromRow(inserted.rows[0]);
    const existing = await this.pool.query<IntentRow>(`
      SELECT * FROM v11_order_intents
      WHERE batch_id = $1 AND leg_id = $2 AND signed_order = $3::jsonb
    `, [batchId, legId, orderJson]);
    if (!existing.rows[0]) throw new Error("A different signed order already exists for this v11 leg");
    return fromRow(existing.rows[0]);
  }

  async claimForSubmission(batchId: string, legId: string): Promise<V11OrderIntent | null> {
    this.assertKey(batchId, legId);
    const result = await this.pool.query<IntentRow>(`
      UPDATE v11_order_intents SET state = 'submitting', updated_at = NOW()
      WHERE batch_id = $1 AND leg_id = $2 AND state = 'prepared'
      RETURNING *
    `, [batchId, legId]);
    return result.rows[0] ? fromRow(result.rows[0]) : null;
  }

  async recordAccepted(batchId: string, legId: string, orderId: string, response: unknown): Promise<void> {
    if (!orderId) throw new Error("Accepted CLOB response has no order ID");
    await this.transition(batchId, legId, "submitting", "accepted", orderId, response, null);
  }

  async recordRejected(batchId: string, legId: string, response: unknown): Promise<void> {
    await this.transition(batchId, legId, "submitting", "rejected", null, response, null);
  }

  async recordUncertain(batchId: string, legId: string, error: string): Promise<void> {
    await this.transition(batchId, legId, "submitting", "uncertain", null, null, error);
  }

  async get(batchId: string, legId: string): Promise<V11OrderIntent | null> {
    this.assertKey(batchId, legId);
    const result = await this.pool.query<IntentRow>(
      "SELECT * FROM v11_order_intents WHERE batch_id = $1 AND leg_id = $2",
      [batchId, legId],
    );
    return result.rows[0] ? fromRow(result.rows[0]) : null;
  }

  async listUnresolved(): Promise<V11OrderIntent[]> {
    const result = await this.pool.query<IntentRow>(`
      SELECT * FROM v11_order_intents
      WHERE state IN ('submitting','accepted','uncertain') ORDER BY created_at
    `);
    return result.rows.map(fromRow);
  }

  private async transition(
    batchId: string, legId: string, from: V11OrderState, to: V11OrderState,
    orderId: string | null, response: unknown | null, error: string | null,
  ): Promise<void> {
    this.assertKey(batchId, legId);
    const result = await this.pool.query(`
      UPDATE v11_order_intents
      SET state = $3, order_id = $4, response = $5::jsonb, error = $6, updated_at = NOW()
      WHERE batch_id = $1 AND leg_id = $2 AND state = $7
    `, [batchId, legId, to, orderId, response === null ? null : JSON.stringify(response), error, from]);
    if (result.rowCount !== 1) throw new Error(`V11 order journal transition ${from} -> ${to} failed`);
  }

  private assertKey(batchId: string, legId: string): void {
    if (!/^\d+$/.test(batchId) || !/^[a-zA-Z0-9_-]{1,64}$/.test(legId)) {
      throw new Error("Invalid v11 batch or leg ID");
    }
  }
}
