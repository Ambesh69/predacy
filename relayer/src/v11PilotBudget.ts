import { Pool } from "pg";

export interface V11PilotBudget {
  reserve(batchId: string, exposureMicroUsd: bigint): Promise<void>;
}

export const AUTHORIZED_V11_PILOT_CAP_MICRO_USD = 10_000_000n;

/** Conservative exposure: a sell share is valued at its $1 maximum payout. */
export class PostgresV11PilotBudget implements V11PilotBudget {
  private constructor(private readonly pool: Pool, private readonly capMicroUsd: bigint) {}

  static async connect(databaseUrl: string, capMicroUsd: bigint): Promise<PostgresV11PilotBudget> {
    if (!databaseUrl || capMicroUsd <= 0n || capMicroUsd > AUTHORIZED_V11_PILOT_CAP_MICRO_USD) {
      throw new Error("V11 pilot needs a durable database and a cap no greater than $10");
    }
    const pool = new Pool({ connectionString: databaseUrl, max: 4 });
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS v11_pilot_budget (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          reserved_micro_usd NUMERIC(78,0) NOT NULL CHECK (reserved_micro_usd >= 0)
        )
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS v11_pilot_reservations (
          batch_id TEXT PRIMARY KEY,
          exposure_micro_usd NUMERIC(78,0) NOT NULL CHECK (exposure_micro_usd > 0),
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await pool.query("INSERT INTO v11_pilot_budget (id, reserved_micro_usd) VALUES (1, 0) ON CONFLICT DO NOTHING");
      return new PostgresV11PilotBudget(pool, capMicroUsd);
    } catch (error) {
      await pool.end();
      throw error;
    }
  }

  async close(): Promise<void> { await this.pool.end(); }

  async reserve(batchId: string, exposureMicroUsd: bigint): Promise<void> {
    if (!/^\d+$/.test(batchId) || exposureMicroUsd <= 0n || exposureMicroUsd > this.capMicroUsd) {
      throw new Error("V11 pilot order exceeds the authorized exposure cap");
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const budget = await client.query<{ reserved_micro_usd: string }>(
        "SELECT reserved_micro_usd FROM v11_pilot_budget WHERE id = 1 FOR UPDATE",
      );
      if (!budget.rows[0]) throw new Error("V11 pilot budget row is missing");
      const existing = await client.query<{ exposure_micro_usd: string }>(
        "SELECT exposure_micro_usd FROM v11_pilot_reservations WHERE batch_id = $1", [batchId],
      );
      if (existing.rows[0]) {
        if (BigInt(existing.rows[0].exposure_micro_usd) !== exposureMicroUsd) {
          throw new Error("V11 pilot batch was reserved for a different amount");
        }
      } else {
        if (BigInt(budget.rows[0].reserved_micro_usd) + exposureMicroUsd > this.capMicroUsd) {
          throw new Error("V11 pilot total would exceed the authorized exposure cap");
        }
        await client.query(
          "INSERT INTO v11_pilot_reservations (batch_id, exposure_micro_usd) VALUES ($1, $2)",
          [batchId, exposureMicroUsd.toString()],
        );
        await client.query(
          "UPDATE v11_pilot_budget SET reserved_micro_usd = reserved_micro_usd + $1 WHERE id = 1",
          [exposureMicroUsd.toString()],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
