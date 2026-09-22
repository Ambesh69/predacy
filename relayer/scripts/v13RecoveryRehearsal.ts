import "dotenv/config";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { keccak256, toHex, type Hex } from "viem";
import { PostgresV13BatchJournal, PostgresV13WitnessVault } from "../src/v13BatchJournal.js";
import { runV13BuyBatch, type V13BuyDriver, type V13BuyRequest } from "../src/v13BuyRunner.js";
import { buildV13RouteInputs, buildV13SettlementInputs } from "../src/v13Proofs.js";
import { v13OrderCommitment } from "../src/v13Proofs.js";
import { PostgresV13OrderQueue, type V13QueuedOrder } from "../src/v13OrderQueue.js";
import { V13MerkleTree } from "../src/v13MerkleTree.js";
import { v13Fixture } from "./lib/v13Fixture.js";

const sourceDatabaseUrl = process.env.V13_DATABASE_URL;
const key = process.env.V13_JOURNAL_KEY;
if (!sourceDatabaseUrl || !key) throw new Error("V13_DATABASE_URL and V13_JOURNAL_KEY are required");
const schema = process.env.V13_REHEARSAL_SCHEMA;
if (schema && !/^v13_rehearsal_[0-9a-f]{24}$/.test(schema)) throw new Error("Invalid rehearsal schema");
const connectionUrl = new URL(sourceDatabaseUrl);
if (schema) connectionUrl.searchParams.set("options",
  `${connectionUrl.searchParams.get("options") ?? ""} -c search_path=${schema}`.trim());
const databaseUrl = connectionUrl.toString();
const stages = ["route", "fill", "withdraw_pusd", "unwrap_pusd", "return_shares", "settle"] as const;
const terminal = { returnPusd: 450_000n, returnShares: 1_000_000n, confirmedTradeCount: 1 };

async function checkQueueConcurrency(db: Pool, cancelOne = false) {
  const fixture = v13Fixture(randomBytes(32).toString("hex"));
  const base = [...fixture.witness.orders, { ...fixture.witness.orders[0],
    orderSecret: `0x${randomBytes(32).toString("hex")}` as Hex }];
  if (cancelOne) base.push({ ...fixture.witness.orders[1],
    orderSecret: `0x${randomBytes(32).toString("hex")}` as Hex });
  const tree = new V13MerkleTree();
  const commitments = base.map(v13OrderCommitment);
  commitments.forEach((commitment, index) => tree.append(index, commitment));
  let cancelled = false;
  let failResolution = false;
  const resolve = async (leaves: Array<{ index: number; commitment: Hex }>) => {
    if (failResolution) throw new Error("Synthetic queue RPC failure");
    return leaves.map((leaf) => ({ merkle: tree.witness(leaf.index, leaf.commitment),
      spent: cancelled && leaf.index === 0 }));
  };
  const first = await PostgresV13OrderQueue.connect(databaseUrl!, key!, resolve);
  const second = await PostgresV13OrderQueue.connect(databaseUrl!, key!, resolve);
  const batches: string[] = [];
  try {
    let groupKey: Hex | undefined;
    for (let index = 0; index < base.length; index++) {
      const order: V13QueuedOrder = { marketId: fixture.marketId, positionTokenId: fixture.positionTokenId,
        priceTick: fixture.priceTick, depositWallet: fixture.depositWallet,
        collateralAsset: fixture.witness.collateralAsset, positionAsset: fixture.witness.positionAsset,
        receiptTokenHash: keccak256(toHex("synthetic receipt")), orderLeafIndex: index,
        order: { deposit: base[index].deposit, limitPrice: base[index].limitPrice,
          refundPublicKey: base[index].refundPublicKey, positionPublicKey: base[index].positionPublicKey,
          orderSecret: base[index].orderSecret } };
      groupKey = (await first.enqueue(order)).groupKey;
    }
    if (cancelOne) {
      failResolution = true;
      await assert.rejects(first.assemble(groupKey!), /Synthetic queue RPC failure/);
      failResolution = false;
      const untouched = await db.query<{ state: string }>(
        "SELECT state FROM v13_private_order_queue WHERE order_commitment=ANY($1::text[])", [commitments]);
      assert(untouched.rows.every((row) => row.state === "pending"), "RPC failure must not claim queued orders");
      cancelled = true;
    }
    const results = await Promise.all([first.assemble(groupKey!), second.assemble(groupKey!)]);
    const assembled = results.filter((result) => result !== null);
    batches.push(...assembled.map((result) => result.batchId));
    assert.equal(assembled.length, 1, "Concurrent workers must assemble exactly one pair out of three live orders");
    const rows = await db.query<{ state: string; batch_id: string | null }>(
      "SELECT state,batch_id FROM v13_private_order_queue WHERE order_commitment=ANY($1::text[])", [commitments]);
    assert.equal(rows.rows.filter((row) => row.state === "batched").length, 2);
    assert.equal(rows.rows.filter((row) => row.state === "pending").length, cancelOne ? 2 : 1);
    assert(rows.rows.filter((row) => row.state === "batched").every((row) => row.batch_id === batches[0]));
    if (cancelOne) {
      assert(!assembled[0]!.request.witness.orders.map(v13OrderCommitment).includes(commitments[0]),
        "A spent order cannot consume a batch slot");
      cancelled = false;
      const recovered = await first.assemble(groupKey!);
      assert(recovered, "A cancellation reversed by a reorg must leave both remaining orders available");
      batches.push(recovered.batchId);
    }
    console.log(JSON.stringify({ v13AtomicQueueAssembly: "pass", workers: 2, orders: base.length,
      batches: batches.length, cancelledQueueRecovery: cancelOne ? "pass" : "not exercised", chainState: "simulated" }));
  } finally {
    const stored = await db.query<{ batch_id: string }>(
      "SELECT DISTINCT batch_id FROM v13_private_order_queue WHERE order_commitment=ANY($1::text[]) AND batch_id IS NOT NULL",
      [commitments]);
    await db.query("DELETE FROM v13_private_witnesses WHERE batch_id=ANY($1::text[])",
      [stored.rows.map((row) => row.batch_id)]);
    await db.query("DELETE FROM v13_private_order_queue WHERE order_commitment=ANY($1::text[])", [commitments]);
    await Promise.all([first.close(), second.close()]);
  }
}

async function child(batchId: Hex, stopAfter: string) {
  const db = new Pool({ connectionString: databaseUrl, max: 2 });
  const journal = await PostgresV13BatchJournal.connect(databaseUrl!);
  const vault = await PostgresV13WitnessVault.connect(databaseUrl!, key!);
  const request = await vault.get<V13BuyRequest>(batchId);
  assert(request, "Reconnected process lost the encrypted batch witness");
  const counts = async () => (await db.query<{ counts: Record<string, number> }>(
    "SELECT counts FROM v13_recovery_rehearsals WHERE id=$1", [batchId])).rows[0].counts;
  const hash = (action: string) => keccak256(toHex(`${batchId}:${action}`));
  const checkpoint = (stage: string) => {
    if (stage === stopAfter) process.exit(75);
  };
  const action = (stage: string) => ({
    async send() {
      const before = await counts();
      assert.equal(before[stage] ?? 0, 0, `${stage} would be broadcast twice`);
      await db.query("UPDATE v13_recovery_rehearsals SET counts=$2::jsonb WHERE id=$1",
        [batchId, JSON.stringify({ ...before, [stage]: 1 })]);
      return hash(stage);
    },
    async confirm(txHash: Hex) {
      assert.equal(txHash, hash(stage), "Recovered action changed its transaction hash");
      assert.equal((await counts())[stage], 1);
      checkpoint(stage);
    },
  });
  const driver: V13BuyDriver = {
    async assertBatch() {
      const current = await counts();
      return current.settle ? "SETTLED" : current.route ? "ROUTED" : "READY";
    },
    route: () => action("route"),
    assertFunding: async () => {},
    async executeAggregateOrder() {
      const before = await counts();
      if (!before.fill) {
        await db.query("UPDATE v13_recovery_rehearsals SET counts=$2::jsonb WHERE id=$1",
          [batchId, JSON.stringify({ ...before, fill: 1 })]);
      }
      checkpoint("fill");
      return terminal;
    },
    withdrawPusd: () => action("withdraw_pusd"), unwrapPusd: () => action("unwrap_pusd"),
    returnShares: () => action("return_shares"),
    async assertPoolReturns() {
      const current = await counts();
      for (const stage of ["withdraw_pusd", "unwrap_pusd", "return_shares"]) assert.equal(current[stage], 1);
    },
    settle: () => action("settle"),
  };
  try {
    const result = await runV13BuyBatch(request, journal, driver,
      async (batch) => ({ ...buildV13RouteInputs(batch), proof: "0x" }),
      async (batch, fills) => ({ ...buildV13SettlementInputs(batch, fills), proof: "0x" }),
      { allowNewRoute: stopAfter === "route" });
    assert.equal(result.fills.reduce((total, fill) => total + fill.spent, 0n), 550_000n);
    assert.equal(result.fills.reduce((total, fill) => total + fill.shares, 0n), 1_000_000n);
  } finally { await Promise.all([db.end(), journal.close(), vault.close()]); }
}

async function main() {
  if (!schema) {
    // Exercise the live database engine without exposing synthetic jobs to production workers.
    const isolatedSchema = `v13_rehearsal_${randomBytes(12).toString("hex")}`;
    const admin = new Pool({ connectionString: sourceDatabaseUrl, max: 1 });
    try {
      await admin.query(`CREATE SCHEMA ${isolatedSchema}`);
      const code = await new Promise<number | null>((resolve, reject) => {
        const worker = spawn(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url)],
          { env: { ...process.env, V13_REHEARSAL_SCHEMA: isolatedSchema }, stdio: "inherit" });
        worker.on("error", reject);
        worker.on("exit", resolve);
      });
      assert.equal(code, 0, "Isolated v13 PostgreSQL rehearsal failed");
    } finally {
      try { await admin.query(`DROP SCHEMA IF EXISTS ${isolatedSchema} CASCADE`); }
      finally { await admin.end(); }
    }
    return;
  }
  if (process.argv[2] === "--child") {
    if (!/^0x[0-9a-f]{64}$/.test(process.argv[3] ?? "")) throw new Error("Invalid rehearsal ID");
    return child(process.argv[3] as Hex, process.argv[4]);
  }
  const request = v13Fixture(randomBytes(32).toString("hex"));
  const batchId = buildV13RouteInputs(request.witness).binding;
  const db = new Pool({ connectionString: databaseUrl, max: 1 });
  const vault = await PostgresV13WitnessVault.connect(databaseUrl!, key!);
  try {
    const setup = await PostgresV13BatchJournal.connect(databaseUrl!);
    await setup.close();
    await db.query(`CREATE TABLE IF NOT EXISTS v13_recovery_rehearsals
      (id TEXT PRIMARY KEY, counts JSONB NOT NULL DEFAULT '{}'::jsonb)`);
    await db.query("INSERT INTO v13_recovery_rehearsals(id) VALUES($1)", [batchId]);
    await vault.put(batchId, request);
    for (const stage of [...stages, "complete", "complete"]) {
      const code = await new Promise<number | null>((resolve, reject) => {
        const worker = spawn(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url),
          "--child", batchId, stage], { env: process.env, stdio: "inherit" });
        worker.on("error", reject);
        worker.on("exit", resolve);
      });
      assert.equal(code, stage === "complete" ? 0 : 75, `Recovery checkpoint ${stage} failed`);
    }
    const current = (await db.query<{ counts: Record<string, number> }>(
      "SELECT counts FROM v13_recovery_rehearsals WHERE id=$1", [batchId])).rows[0].counts;
    for (const stage of stages) assert.equal(current[stage], 1, `${stage} replayed`);
    await checkQueueConcurrency(db);
    await checkQueueConcurrency(db, true);
    console.log(JSON.stringify({ v13PostgresRestartRecovery: "pass", processRestarts: stages.length,
      duplicateActions: 0, encryptedWitnessRecovery: "pass", chainAndClob: "simulated" }));
  } finally {
    await db.query("DELETE FROM v13_batch_intents WHERE batch_id=$1", [batchId]);
    await db.query("DELETE FROM v13_private_witnesses WHERE batch_id=$1", [batchId]);
    await db.query("DELETE FROM v13_recovery_rehearsals WHERE id=$1", [batchId]);
    await Promise.all([vault.close(), db.end()]);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "V13 recovery rehearsal failed");
  process.exitCode = 1;
});
