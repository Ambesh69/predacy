import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { Pool } from "pg";

export type V13BatchAction =
  "route" | "plan" | "withdraw_pusd" | "unwrap_pusd" | "return_shares" | "settle" | "cancel";
export type V13ActionState = "prepared" | "submitting" | "broadcast" | "confirmed" | "uncertain";
export interface V13Intent {
  batchId: string; action: V13BatchAction; state: V13ActionState;
  payload: Record<string, string>; txHash: string | null; error: string | null;
}
export interface V13BatchJournal {
  prepare(batchId: string, action: V13BatchAction, payload: Record<string, string>): Promise<V13Intent>;
  claim(batchId: string, action: V13BatchAction): Promise<V13Intent | null>;
  recordBroadcast(batchId: string, action: V13BatchAction, txHash: string): Promise<void>;
  recordConfirmed(batchId: string, action: V13BatchAction): Promise<void>;
  recordUncertain(batchId: string, action: V13BatchAction, error: string): Promise<void>;
  get(batchId: string, action: V13BatchAction): Promise<V13Intent | null>;
  listUnresolved(): Promise<V13Intent[]>;
}

interface Row {
  batch_id: string; action: V13BatchAction; state: V13ActionState;
  payload: Record<string, string>; tx_hash: string | null; error: string | null;
}

function assertId(value: string, label: string): void {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error(`Invalid v13 ${label}`);
}
function intent(row: Row): V13Intent {
  return { batchId: row.batch_id, action: row.action, state: row.state,
    payload: row.payload, txHash: row.tx_hash, error: row.error };
}

export class PostgresV13BatchJournal implements V13BatchJournal {
  private constructor(private readonly pool: Pool) {}

  static async connect(databaseUrl: string): Promise<PostgresV13BatchJournal> {
    if (!databaseUrl) throw new Error("V13_DATABASE_URL is required");
    const pool = new Pool({ connectionString: databaseUrl, max: 4 });
    try {
      await pool.query(`CREATE TABLE IF NOT EXISTS v13_batch_intents (
        batch_id TEXT NOT NULL, action TEXT NOT NULL CHECK (action IN
          ('route','plan','withdraw_pusd','unwrap_pusd','return_shares','settle','cancel')),
        state TEXT NOT NULL CHECK (state IN ('prepared','submitting','broadcast','confirmed','uncertain')),
        payload JSONB NOT NULL, tx_hash TEXT, error TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (batch_id, action))`);
      return new PostgresV13BatchJournal(pool);
    } catch (error) { await pool.end(); throw error; }
  }

  async close() { await this.pool.end(); }
  async prepare(batchId: string, action: V13BatchAction, payload: Record<string, string>) {
    assertId(batchId, "batch ID");
    if (!Object.keys(payload).length || Object.values(payload).some((value) => typeof value !== "string")) {
      throw new Error("V13 action needs immutable public string parameters");
    }
    const json = JSON.stringify(payload);
    const inserted = await this.pool.query<Row>(`INSERT INTO v13_batch_intents
      (batch_id,action,state,payload) VALUES ($1,$2,'prepared',$3::jsonb)
      ON CONFLICT DO NOTHING RETURNING *`, [batchId, action, json]);
    if (inserted.rows[0]) return intent(inserted.rows[0]);
    const existing = await this.pool.query<Row>(`SELECT * FROM v13_batch_intents
      WHERE batch_id=$1 AND action=$2 AND payload=$3::jsonb`, [batchId, action, json]);
    if (!existing.rows[0]) throw new Error("A different v13 action is already journaled");
    return intent(existing.rows[0]);
  }
  async claim(batchId: string, action: V13BatchAction) {
    assertId(batchId, "batch ID");
    const result = await this.pool.query<Row>(`UPDATE v13_batch_intents SET state='submitting',updated_at=NOW()
      WHERE batch_id=$1 AND action=$2 AND state='prepared' RETURNING *`, [batchId, action]);
    return result.rows[0] ? intent(result.rows[0]) : null;
  }
  async recordBroadcast(batchId: string, action: V13BatchAction, txHash: string) {
    assertId(txHash, "transaction hash");
    await this.transition(batchId, action, "submitting", "broadcast", txHash, null);
  }
  async recordConfirmed(batchId: string, action: V13BatchAction) {
    await this.transition(batchId, action, "broadcast", "confirmed", null, null);
  }
  async recordUncertain(batchId: string, action: V13BatchAction, error: string) {
    assertId(batchId, "batch ID");
    const result = await this.pool.query(`UPDATE v13_batch_intents SET state='uncertain',error=$3,updated_at=NOW()
      WHERE batch_id=$1 AND action=$2 AND state IN ('submitting','broadcast')`, [batchId, action, error]);
    if (result.rowCount !== 1) throw new Error("V13 action cannot be marked uncertain");
  }
  async get(batchId: string, action: V13BatchAction) {
    assertId(batchId, "batch ID");
    const result = await this.pool.query<Row>("SELECT * FROM v13_batch_intents WHERE batch_id=$1 AND action=$2",
      [batchId, action]);
    return result.rows[0] ? intent(result.rows[0]) : null;
  }
  async listUnresolved() {
    const result = await this.pool.query<Row>(`SELECT * FROM v13_batch_intents
      WHERE state IN ('submitting','broadcast','uncertain') ORDER BY created_at`);
    return result.rows.map(intent);
  }
  private async transition(batchId: string, action: V13BatchAction, from: V13ActionState,
    to: V13ActionState, txHash: string | null, error: string | null) {
    assertId(batchId, "batch ID");
    const result = await this.pool.query(`UPDATE v13_batch_intents
      SET state=$3,tx_hash=COALESCE($4,tx_hash),error=$5,updated_at=NOW()
      WHERE batch_id=$1 AND action=$2 AND state=$6`, [batchId, action, to, txHash, error, from]);
    if (result.rowCount !== 1) throw new Error(`V13 journal transition ${from} -> ${to} failed`);
  }
}

function keyBytes(key: string): Buffer {
  const value = key.startsWith("0x") ? key.slice(2) : key;
  if (!/^[0-9a-fA-F]{64}$/.test(value)) throw new Error("V13_JOURNAL_KEY must be exactly 32 bytes");
  return Buffer.from(value, "hex");
}
function encode(value: unknown) {
  return JSON.stringify(value, (_key, item) => typeof item === "bigint" ? { __v13_bigint: item.toString() } : item);
}
function decode<T>(value: string): T {
  return JSON.parse(value, (_key, item) => item && typeof item === "object" &&
    Object.keys(item).length === 1 && typeof item.__v13_bigint === "string"
    ? BigInt(item.__v13_bigint) : item) as T;
}
export function sealV13Witness(id: string, witness: unknown, key: string) {
  assertId(id, "witness ID");
  const plaintext = encode(witness);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyBytes(key), iv);
  cipher.setAAD(Buffer.from(id.toLowerCase()));
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return { ciphertext: [iv, cipher.getAuthTag(), encrypted].map((part) => part.toString("base64")).join("."),
    digest: createHash("sha256").update(plaintext).digest("hex") };
}
export function openV13Witness<T>(id: string, ciphertext: string, key: string): T {
  assertId(id, "witness ID");
  const parts = ciphertext.split(".").map((part) => Buffer.from(part, "base64"));
  if (parts.length !== 3 || parts[0].length !== 12 || parts[1].length !== 16 || !parts[2].length) {
    throw new Error("Invalid encrypted v13 witness");
  }
  const decipher = createDecipheriv("aes-256-gcm", keyBytes(key), parts[0]);
  decipher.setAAD(Buffer.from(id.toLowerCase()));
  decipher.setAuthTag(parts[1]);
  return decode<T>(Buffer.concat([decipher.update(parts[2]), decipher.final()]).toString("utf8"));
}

export class PostgresV13WitnessVault {
  private constructor(private readonly pool: Pool, private readonly key: string) {}
  static async connect(databaseUrl: string, key: string) {
    keyBytes(key);
    const pool = new Pool({ connectionString: databaseUrl, max: 2 });
    try {
      await pool.query(`CREATE TABLE IF NOT EXISTS v13_private_witnesses
        (batch_id TEXT PRIMARY KEY,ciphertext TEXT NOT NULL,witness_digest TEXT NOT NULL,
         created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
      return new PostgresV13WitnessVault(pool, key);
    } catch (error) { await pool.end(); throw error; }
  }
  async put(batchId: string, witness: unknown) {
    const sealed = sealV13Witness(batchId, witness, this.key);
    const inserted = await this.pool.query(`INSERT INTO v13_private_witnesses
      (batch_id,ciphertext,witness_digest) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
    [batchId, sealed.ciphertext, sealed.digest]);
    if (inserted.rowCount === 1) return;
    const existing = await this.pool.query<{ witness_digest: string }>(
      "SELECT witness_digest FROM v13_private_witnesses WHERE batch_id=$1", [batchId]);
    if (existing.rows[0]?.witness_digest !== sealed.digest) throw new Error("Different v13 witness already stored");
  }
  async get<T>(batchId: string): Promise<T | null> {
    assertId(batchId, "batch ID");
    const result = await this.pool.query<{ ciphertext: string }>(
      "SELECT ciphertext FROM v13_private_witnesses WHERE batch_id=$1", [batchId]);
    return result.rows[0] ? openV13Witness<T>(batchId, result.rows[0].ciphertext, this.key) : null;
  }
  async close() { await this.pool.end(); }
}
