import "dotenv/config";
import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import { PostgresV12BatchJournal, PostgresV12WitnessVault } from "../src/v12BatchJournal.js";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function main(): Promise<void> {
  const databaseUrl = required("V12_DATABASE_URL");
  const key = required("V12_JOURNAL_KEY");
  const batchId = `0x${randomBytes(32).toString("hex")}`;
  const txHash = `0x${randomBytes(32).toString("hex")}`;
  const witness = { rehearsal: true, nonce: randomBytes(16).toString("hex"), amount: 1_350_000n };

  let journal = await PostgresV12BatchJournal.connect(databaseUrl);
  let vault = await PostgresV12WitnessVault.connect(databaseUrl, key);
  try {
    await vault.put(batchId, witness);
    await journal.prepare(batchId, "route", { rehearsal: "true", amount: "1350000" });
    if (!await journal.claim(batchId, "route")) throw new Error("Could not claim rehearsal route");
    await journal.recordBroadcast(batchId, "route", txHash);
  } finally {
    await Promise.all([journal.close(), vault.close()]);
  }

  journal = await PostgresV12BatchJournal.connect(databaseUrl);
  vault = await PostgresV12WitnessVault.connect(databaseUrl, key);
  const cleanup = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const restored = await vault.get<typeof witness>(batchId);
    if (!restored || restored.nonce !== witness.nonce || restored.amount !== witness.amount) {
      throw new Error("Encrypted witness did not survive PostgreSQL reconnect");
    }
    if (await journal.claim(batchId, "route")) {
      throw new Error("Broadcast action became claimable after PostgreSQL reconnect");
    }
    const before = await journal.get(batchId, "route");
    if (before?.state !== "broadcast" || before.txHash?.toLowerCase() !== txHash.toLowerCase()) {
      throw new Error("Broadcast journal state did not survive PostgreSQL reconnect");
    }
    await journal.recordConfirmed(batchId, "route");
    if ((await journal.get(batchId, "route"))?.state !== "confirmed") {
      throw new Error("Reconnected journal could not complete the action");
    }
    console.log(JSON.stringify({
      database: "pass",
      encryptedWitnessReconnect: "pass",
      noReplayAfterReconnect: "pass",
      transitionAfterReconnect: "pass",
    }));
  } finally {
    await Promise.all([
      cleanup.query("DELETE FROM v12_private_witnesses WHERE batch_id = $1", [batchId]),
      cleanup.query("DELETE FROM v12_batch_intents WHERE batch_id = $1", [batchId]),
    ]).catch(() => {});
    await Promise.all([journal.close(), vault.close(), cleanup.end()]);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "V12 PostgreSQL recovery rehearsal failed");
  process.exitCode = 1;
});
