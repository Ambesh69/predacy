import { Pool } from "pg";

export type V11BatchAction = "route" | "plan" | "return_pusd" | "return_shares" | "finalize";
export type V11BatchActionState = "prepared" | "submitting" | "broadcast" | "confirmed" | "uncertain";

export interface V11BatchIntent {
  batchId: string;
  action: V11BatchAction;
  state: V11BatchActionState;
  payload: Record<string, string>;
  txHash: string | null;
  error: string | null;
}

export interface V11BatchJournal {
  prepare(batchId: string, action: V11BatchAction, payload: Record<string, string>): Promise<V11BatchIntent>;
  claim(batchId: string, action: V11BatchAction): Promise<V11BatchIntent | null>;
  recordBroadcast(batchId: string, action: V11BatchAction, txHash: string): Promise<void>;
  recordConfirmed(batchId: string, action: V11BatchAction): Promise<void>;
  recordUncertain(batchId: string, action: V11BatchAction, error: string): Promise<void>;
  get(batchId: string, action: V11BatchAction): Promise<V11BatchIntent | null>;
  listUnresolved(): Promise<V11BatchIntent[]>;
}

interface IntentRow {
  batch_id: string;
  action: V11BatchAction;
  state: V11BatchActionState;
  payload: Record<string, string>;
  tx_hash: string | null;
  error: string | null;
}

function fromRow(row: IntentRow): V11BatchIntent {
  return {
    batchId: row.batch_id,
    action: row.action,
    state: row.state,
    payload: row.payload,
    txHash: row.tx_hash,
    error: row.error,
  };
}

/** Write-ahead journal: an ambiguous send is never replayed automatically. */
export class PostgresV11BatchJournal implements V11BatchJournal {
  private constructor(private readonly pool: Pool) {}

  static async connect(databaseUrl: string): Promise<PostgresV11BatchJournal> {
    if (!databaseUrl) throw new Error("V11_DATABASE_URL is required for v11 batch execution");
    const pool = new Pool({ connectionString: databaseUrl, max: 4 });
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS v11_batch_intents (
          batch_id TEXT NOT NULL,
          action TEXT NOT NULL CHECK (action IN ('route','plan','return_pusd','return_shares','finalize')),
          state TEXT NOT NULL CHECK (state IN ('prepared','submitting','broadcast','confirmed','uncertain')),
          payload JSONB NOT NULL,
          tx_hash TEXT,
          error TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (batch_id, action)
        )
      `);
      return new PostgresV11BatchJournal(pool);
    } catch (error) {
      await pool.end();
      throw error;
    }
  }

  async close(): Promise<void> { await this.pool.end(); }

  async prepare(batchId: string, action: V11BatchAction, payload: Record<string, string>): Promise<V11BatchIntent> {
    this.assertKey(batchId);
    if (!Object.keys(payload).length || Object.values(payload).some((value) => typeof value !== "string")) {
      throw new Error("V11 batch action needs immutable string parameters");
    }
    const json = JSON.stringify(payload);
    const inserted = await this.pool.query<IntentRow>(`
      INSERT INTO v11_batch_intents (batch_id, action, state, payload)
      VALUES ($1, $2, 'prepared', $3::jsonb)
      ON CONFLICT DO NOTHING RETURNING *
    `, [batchId, action, json]);
    if (inserted.rows[0]) return fromRow(inserted.rows[0]);
    const existing = await this.pool.query<IntentRow>(`
      SELECT * FROM v11_batch_intents
      WHERE batch_id = $1 AND action = $2 AND payload = $3::jsonb
    `, [batchId, action, json]);
    if (!existing.rows[0]) throw new Error("A different v11 batch action is already journaled");
    return fromRow(existing.rows[0]);
  }

  async claim(batchId: string, action: V11BatchAction): Promise<V11BatchIntent | null> {
    this.assertKey(batchId);
    const result = await this.pool.query<IntentRow>(`
      UPDATE v11_batch_intents SET state = 'submitting', updated_at = NOW()
      WHERE batch_id = $1 AND action = $2 AND state = 'prepared' RETURNING *
    `, [batchId, action]);
    return result.rows[0] ? fromRow(result.rows[0]) : null;
  }

  async recordBroadcast(batchId: string, action: V11BatchAction, txHash: string): Promise<void> {
    if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) throw new Error("Invalid v11 transaction hash");
    await this.transition(batchId, action, "submitting", "broadcast", txHash, null);
  }

  async recordConfirmed(batchId: string, action: V11BatchAction): Promise<void> {
    await this.transition(batchId, action, "broadcast", "confirmed", null, null);
  }

  async recordUncertain(batchId: string, action: V11BatchAction, error: string): Promise<void> {
    this.assertKey(batchId);
    const result = await this.pool.query(`
      UPDATE v11_batch_intents SET state = 'uncertain', error = $3, updated_at = NOW()
      WHERE batch_id = $1 AND action = $2 AND state IN ('submitting','broadcast')
    `, [batchId, action, error]);
    if (result.rowCount !== 1) throw new Error("V11 batch action cannot be marked uncertain");
  }

  async get(batchId: string, action: V11BatchAction): Promise<V11BatchIntent | null> {
    this.assertKey(batchId);
    const result = await this.pool.query<IntentRow>(
      "SELECT * FROM v11_batch_intents WHERE batch_id = $1 AND action = $2", [batchId, action],
    );
    return result.rows[0] ? fromRow(result.rows[0]) : null;
  }

  async listUnresolved(): Promise<V11BatchIntent[]> {
    const result = await this.pool.query<IntentRow>(`
      SELECT * FROM v11_batch_intents WHERE state IN ('submitting','broadcast','uncertain') ORDER BY created_at
    `);
    return result.rows.map(fromRow);
  }

  private async transition(
    batchId: string, action: V11BatchAction, from: V11BatchActionState,
    to: V11BatchActionState, txHash: string | null, error: string | null,
  ): Promise<void> {
    this.assertKey(batchId);
    const result = await this.pool.query(`
      UPDATE v11_batch_intents
      SET state = $3, tx_hash = COALESCE($4, tx_hash), error = $5, updated_at = NOW()
      WHERE batch_id = $1 AND action = $2 AND state = $6
    `, [batchId, action, to, txHash, error, from]);
    if (result.rowCount !== 1) throw new Error(`V11 batch journal transition ${from} -> ${to} failed`);
  }

  private assertKey(batchId: string): void {
    if (!/^\d+$/.test(batchId)) throw new Error("Invalid v11 batch ID");
  }
}
