import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { Pool } from "pg";

export type V12BatchAction =
  "route" | "plan" | "withdraw_pusd" | "unwrap_pusd" | "return_shares" | "settle" | "cancel";
export type V12BatchActionState = "prepared" | "submitting" | "broadcast" | "confirmed" | "uncertain";

export interface V12BatchIntent {
  batchId: string;
  action: V12BatchAction;
  state: V12BatchActionState;
  payload: Record<string, string>;
  txHash: string | null;
  error: string | null;
}

export interface V12BatchJournal {
  prepare(batchId: string, action: V12BatchAction, payload: Record<string, string>): Promise<V12BatchIntent>;
  claim(batchId: string, action: V12BatchAction): Promise<V12BatchIntent | null>;
  recordBroadcast(batchId: string, action: V12BatchAction, txHash: string): Promise<void>;
  recordConfirmed(batchId: string, action: V12BatchAction): Promise<void>;
  recordUncertain(batchId: string, action: V12BatchAction, error: string): Promise<void>;
  get(batchId: string, action: V12BatchAction): Promise<V12BatchIntent | null>;
  listUnresolved(): Promise<V12BatchIntent[]>;
}

interface IntentRow {
  batch_id: string;
  action: V12BatchAction;
  state: V12BatchActionState;
  payload: Record<string, string>;
  tx_hash: string | null;
  error: string | null;
}

function assertBatchId(batchId: string): void {
  if (!/^0x[0-9a-fA-F]{64}$/.test(batchId)) throw new Error("Invalid v12 batch ID");
}

function fromRow(row: IntentRow): V12BatchIntent {
  return { batchId: row.batch_id, action: row.action, state: row.state, payload: row.payload,
    txHash: row.tx_hash, error: row.error };
}

/** Durable one-shot transaction journal. Ambiguous submissions are quarantined, never replayed. */
export class PostgresV12BatchJournal implements V12BatchJournal {
  private constructor(private readonly pool: Pool) {}

  static async connect(databaseUrl: string): Promise<PostgresV12BatchJournal> {
    if (!databaseUrl) throw new Error("V12_DATABASE_URL is required for private batch execution");
    const pool = new Pool({ connectionString: databaseUrl, max: 4 });
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS v12_batch_intents (
          batch_id TEXT NOT NULL,
          action TEXT NOT NULL CHECK (action IN (
            'route','plan','withdraw_pusd','unwrap_pusd','return_shares','settle','cancel'
          )),
          state TEXT NOT NULL CHECK (state IN ('prepared','submitting','broadcast','confirmed','uncertain')),
          payload JSONB NOT NULL,
          tx_hash TEXT,
          error TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (batch_id, action)
        )
      `);
      return new PostgresV12BatchJournal(pool);
    } catch (error) {
      await pool.end();
      throw error;
    }
  }

  async close(): Promise<void> { await this.pool.end(); }

  async prepare(batchId: string, action: V12BatchAction, payload: Record<string, string>) {
    assertBatchId(batchId);
    if (!Object.keys(payload).length || Object.values(payload).some((value) => typeof value !== "string")) {
      throw new Error("V12 action needs immutable public string parameters");
    }
    const json = JSON.stringify(payload);
    const inserted = await this.pool.query<IntentRow>(`
      INSERT INTO v12_batch_intents (batch_id, action, state, payload)
      VALUES ($1, $2, 'prepared', $3::jsonb) ON CONFLICT DO NOTHING RETURNING *
    `, [batchId, action, json]);
    if (inserted.rows[0]) return fromRow(inserted.rows[0]);
    const existing = await this.pool.query<IntentRow>(`
      SELECT * FROM v12_batch_intents WHERE batch_id = $1 AND action = $2 AND payload = $3::jsonb
    `, [batchId, action, json]);
    if (!existing.rows[0]) throw new Error("A different v12 batch action is already journaled");
    return fromRow(existing.rows[0]);
  }

  async claim(batchId: string, action: V12BatchAction) {
    assertBatchId(batchId);
    const result = await this.pool.query<IntentRow>(`
      UPDATE v12_batch_intents SET state = 'submitting', updated_at = NOW()
      WHERE batch_id = $1 AND action = $2 AND state = 'prepared' RETURNING *
    `, [batchId, action]);
    return result.rows[0] ? fromRow(result.rows[0]) : null;
  }

  async recordBroadcast(batchId: string, action: V12BatchAction, txHash: string) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) throw new Error("Invalid v12 transaction hash");
    await this.transition(batchId, action, "submitting", "broadcast", txHash, null);
  }

  async recordConfirmed(batchId: string, action: V12BatchAction) {
    await this.transition(batchId, action, "broadcast", "confirmed", null, null);
  }

  async recordUncertain(batchId: string, action: V12BatchAction, error: string) {
    assertBatchId(batchId);
    const result = await this.pool.query(`
      UPDATE v12_batch_intents SET state = 'uncertain', error = $3, updated_at = NOW()
      WHERE batch_id = $1 AND action = $2 AND state IN ('submitting','broadcast')
    `, [batchId, action, error]);
    if (result.rowCount !== 1) throw new Error("V12 batch action cannot be marked uncertain");
  }

  async get(batchId: string, action: V12BatchAction) {
    assertBatchId(batchId);
    const result = await this.pool.query<IntentRow>(
      "SELECT * FROM v12_batch_intents WHERE batch_id = $1 AND action = $2", [batchId, action],
    );
    return result.rows[0] ? fromRow(result.rows[0]) : null;
  }

  async listUnresolved() {
    const result = await this.pool.query<IntentRow>(`
      SELECT * FROM v12_batch_intents WHERE state IN ('submitting','broadcast','uncertain') ORDER BY created_at
    `);
    return result.rows.map(fromRow);
  }

  private async transition(
    batchId: string, action: V12BatchAction, from: V12BatchActionState,
    to: V12BatchActionState, txHash: string | null, error: string | null,
  ) {
    assertBatchId(batchId);
    const result = await this.pool.query(`
      UPDATE v12_batch_intents SET state = $3, tx_hash = COALESCE($4, tx_hash), error = $5, updated_at = NOW()
      WHERE batch_id = $1 AND action = $2 AND state = $6
    `, [batchId, action, to, txHash, error, from]);
    if (result.rowCount !== 1) throw new Error(`V12 batch journal transition ${from} -> ${to} failed`);
  }
}

function keyBytes(key: string): Buffer {
  const normalized = key.startsWith("0x") ? key.slice(2) : key;
  if (!/^[0-9a-fA-F]{64}$/.test(normalized)) throw new Error("V12_JOURNAL_KEY must be exactly 32 bytes");
  return Buffer.from(normalized, "hex");
}

function encodePrivate(value: unknown): string {
  return JSON.stringify(value, (_key, item) => typeof item === "bigint" ? { __v12_bigint: item.toString() } : item);
}

function decodePrivate<T>(value: string): T {
  return JSON.parse(value, (_key, item) => item && typeof item === "object" &&
    Object.keys(item).length === 1 && typeof item.__v12_bigint === "string"
    ? BigInt(item.__v12_bigint) : item) as T;
}

export function sealV12Witness(batchId: string, witness: unknown, key: string): { ciphertext: string; digest: string } {
  assertBatchId(batchId);
  const plaintext = encodePrivate(witness);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyBytes(key), iv);
  cipher.setAAD(Buffer.from(batchId.toLowerCase()));
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    ciphertext: [iv, cipher.getAuthTag(), encrypted].map((part) => part.toString("base64")).join("."),
    digest: createHash("sha256").update(plaintext).digest("hex"),
  };
}

export function openV12Witness<T>(batchId: string, ciphertext: string, key: string): T {
  assertBatchId(batchId);
  const parts = ciphertext.split(".");
  if (parts.length !== 3) throw new Error("Invalid encrypted v12 witness");
  const [iv, tag, encrypted] = parts.map((part) => Buffer.from(part, "base64"));
  if (iv.length !== 12 || tag.length !== 16 || encrypted.length === 0) throw new Error("Invalid encrypted v12 witness");
  const decipher = createDecipheriv("aes-256-gcm", keyBytes(key), iv);
  decipher.setAAD(Buffer.from(batchId.toLowerCase()));
  decipher.setAuthTag(tag);
  return decodePrivate<T>(Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8"));
}

/** Encrypted witness persistence. The database never receives plaintext private order fields. */
export class PostgresV12WitnessVault {
  private constructor(private readonly pool: Pool, private readonly key: string) {}

  static async connect(databaseUrl: string, key: string): Promise<PostgresV12WitnessVault> {
    keyBytes(key);
    const pool = new Pool({ connectionString: databaseUrl, max: 2 });
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS v12_private_witnesses (
          batch_id TEXT PRIMARY KEY,
          ciphertext TEXT NOT NULL,
          witness_digest TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      return new PostgresV12WitnessVault(pool, key);
    } catch (error) {
      await pool.end();
      throw error;
    }
  }

  async put(batchId: string, witness: unknown): Promise<void> {
    const sealed = sealV12Witness(batchId, witness, this.key);
    const inserted = await this.pool.query(`
      INSERT INTO v12_private_witnesses (batch_id, ciphertext, witness_digest)
      VALUES ($1, $2, $3) ON CONFLICT DO NOTHING
    `, [batchId, sealed.ciphertext, sealed.digest]);
    if (inserted.rowCount === 1) return;
    const existing = await this.pool.query<{ witness_digest: string }>(
      "SELECT witness_digest FROM v12_private_witnesses WHERE batch_id = $1", [batchId],
    );
    if (existing.rows[0]?.witness_digest !== sealed.digest) {
      throw new Error("A different private witness is already stored for this v12 batch");
    }
  }

  async get<T>(batchId: string): Promise<T | null> {
    assertBatchId(batchId);
    const result = await this.pool.query<{ ciphertext: string }>(
      "SELECT ciphertext FROM v12_private_witnesses WHERE batch_id = $1", [batchId],
    );
    return result.rows[0] ? openV12Witness<T>(batchId, result.rows[0].ciphertext, this.key) : null;
  }

  async close(): Promise<void> { await this.pool.end(); }
}
