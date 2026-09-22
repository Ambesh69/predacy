import "dotenv/config";
import { privateKey } from "@polymarket/client/viem";
import { getAddress, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { Pool } from "pg";
import { createOperatorDepositWallet } from "../src/depositWalletClient.js";
import { PostgresV11OrderJournal } from "../src/v11OrderJournal.js";
import { PostgresV13BatchJournal, PostgresV13WitnessVault } from "../src/v13BatchJournal.js";
import { runV13BuyBatch, type V13BuyRequest } from "../src/v13BuyRunner.js";
import { PostgresV13OrderQueue } from "../src/v13OrderQueue.js";
import { V13PolygonDriver } from "../src/v13PolygonDriver.js";
import { buildV13RouteInputs, proveV13Route, proveV13Settlement } from "../src/v13Proofs.js";

const USDCE = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const PUSD = "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB";
const CTF = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045";
function required(name: string) { const value = process.env[name]?.trim(); if (!value) throw new Error(`${name} is required`); return value; }

async function main() {
  if (process.argv.length !== 4 || process.argv[2] !== "--execute" || !/^0x[0-9a-fA-F]{64}$/.test(process.argv[3])) {
    throw new Error("Usage: npm run run:v13 -- --execute <batch-binding>");
  }
  const requested = process.argv[3].toLowerCase() as Hex;
  const rpcUrl = required("RPC_URL"); const databaseUrl = required("V13_DATABASE_URL");
  const journalKey = required("V13_JOURNAL_KEY");
  const signerKey = required("V13_SIGNER_PRIVATE_KEY") as Hex;
  const relayerKey = required("V13_RELAYER_PRIVATE_KEY") as Hex;
  if (signerKey.toLowerCase() === relayerKey.toLowerCase()) throw new Error("V13 signer and relayer keys must differ");
  const depositWallet = getAddress(required("V13_DEPOSIT_WALLET"));
  const signer = privateKey(signerKey, { transport: http(rpcUrl) });
  const clob = await createOperatorDepositWallet({ signerPrivateKey: signerKey,
    builderKey: required("POLYMARKET_BUILDER_KEY"), builderSecret: required("POLYMARKET_BUILDER_SECRET"),
    builderPassphrase: required("POLYMARKET_BUILDER_PASSPHRASE"), rpcUrl,
    expectedSigner: privateKeyToAccount(signerKey).address, expectedWallet: depositWallet });
  const witnessVault = await PostgresV13WitnessVault.connect(databaseUrl, journalKey);
  const batchJournal = await PostgresV13BatchJournal.connect(databaseUrl);
  const orderJournal = await PostgresV11OrderJournal.connect(databaseUrl);
  const orderQueue = await PostgresV13OrderQueue.connect(databaseUrl, journalKey,
    async () => { throw new Error("Merkle resolver is unavailable in execution-only process"); });
  const coordinator = new Pool({ connectionString: databaseUrl, max: 1 });
  const executionLock = await coordinator.connect();
  let locked = false;
  try {
    await executionLock.query("SELECT pg_advisory_lock($1)", [13_013]);
    locked = true;
    const request = await witnessVault.get<V13BuyRequest>(requested);
    if (!request || buildV13RouteInputs(request.witness).binding.toLowerCase() !== requested) {
      throw new Error("Encrypted v13 witness is missing or has another binding");
    }
    if (getAddress(request.depositWallet) !== depositWallet) throw new Error("V13 Deposit Wallet mismatch");
    const delay = (request.executeAfterUnixMs ?? 0) - Date.now();
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    const driver = new V13PolygonDriver({ rpcUrl, pool: getAddress(required("V13_POOL_ADDRESS")),
      adapter: getAddress(required("V13_ADAPTER_ADDRESS")), usdce: USDCE, pusd: PUSD, ctf: CTF,
      routeVerifier: getAddress(required("V13_ROUTE_VERIFIER")),
      settlementVerifier: getAddress(required("V13_SETTLEMENT_VERIFIER")),
      guardian: getAddress(required("V13_GUARDIAN")), exchange: getAddress(required("V13_EXCHANGE_ADDRESS")),
      relayerKey, depositWalletSigner: signer, clob, orderJournal });
    const result = await runV13BuyBatch(request, batchJournal, driver, proveV13Route, proveV13Settlement);
    await orderQueue.recordReceipts(result.batchId, request, result.fills);
    console.log(JSON.stringify({ batchId: result.batchId, state: "settled",
      aggregateShares: result.terminal.returnShares.toString() }));
  } finally {
    if (locked) await executionLock.query("SELECT pg_advisory_unlock($1)", [13_013]);
    executionLock.release();
    await Promise.all([orderJournal.close(), batchJournal.close(), witnessVault.close(), orderQueue.close(), coordinator.end()]);
  }
}
main().catch((error) => {
  console.error(`V13 execution halted: ${error instanceof Error ? error.message : "unknown error"}. Reconcile before retrying.`);
  process.exitCode = 1;
});
