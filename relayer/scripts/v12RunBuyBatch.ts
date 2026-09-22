import "dotenv/config";
import { privateKey } from "@polymarket/client/viem";
import { getAddress, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createOperatorDepositWallet } from "../src/depositWalletClient.js";
import { PostgresV11OrderJournal } from "../src/v11OrderJournal.js";
import { PostgresV12BatchJournal, PostgresV12WitnessVault } from "../src/v12BatchJournal.js";
import { PostgresV12OrderQueue } from "../src/v12OrderQueue.js";
import { proveV12BuyBatch } from "../src/v12BuyBatchProver.js";
import { runV12BuyBatch, v12BuyBatchId, type V12BuyBatchRequest } from "../src/v12BuyRunner.js";
import { V12PolygonDriver } from "../src/v12PolygonDriver.js";

const USDCE = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const PUSD = "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB";
const CTF = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function main(): Promise<void> {
  if (process.argv.length !== 4 || process.argv[2] !== "--execute" ||
      !/^0x[0-9a-fA-F]{64}$/.test(process.argv[3])) {
    throw new Error("Usage: npm run run:v12 -- --execute <order-set-hash>");
  }
  const requestedBatchId = process.argv[3].toLowerCase() as Hex;
  const rpcUrl = required("RPC_URL");
  const databaseUrl = required("V12_DATABASE_URL");
  const journalKey = required("V12_JOURNAL_KEY");
  const signerKey = required("V12_SIGNER_PRIVATE_KEY") as Hex;
  const relayerKey = required("V12_RELAYER_PRIVATE_KEY") as Hex;
  if (signerKey.toLowerCase() === relayerKey.toLowerCase()) {
    throw new Error("V12 Deposit Wallet signer and relayer keys must be separate");
  }
  const depositWallet = getAddress(required("V12_DEPOSIT_WALLET"));
  const signer = privateKey(signerKey, { transport: http(rpcUrl) });
  const clob = await createOperatorDepositWallet({
    signerPrivateKey: signerKey,
    builderKey: required("POLYMARKET_BUILDER_KEY"),
    builderSecret: required("POLYMARKET_BUILDER_SECRET"),
    builderPassphrase: required("POLYMARKET_BUILDER_PASSPHRASE"),
    rpcUrl,
    expectedSigner: privateKeyToAccount(signerKey).address,
    expectedWallet: depositWallet,
  });

  const witnessVault = await PostgresV12WitnessVault.connect(databaseUrl, journalKey);
  const batchJournal = await PostgresV12BatchJournal.connect(databaseUrl);
  const orderJournal = await PostgresV11OrderJournal.connect(databaseUrl);
  const orderQueue = await PostgresV12OrderQueue.connect(databaseUrl, journalKey);
  try {
    const request = await witnessVault.get<V12BuyBatchRequest>(requestedBatchId);
    if (!request || v12BuyBatchId(request).toLowerCase() !== requestedBatchId) {
      throw new Error("Encrypted v12 witness is missing or does not match the requested order-set hash");
    }
    if (getAddress(request.depositWallet) !== depositWallet) {
      throw new Error("Encrypted v12 witness targets a different Deposit Wallet");
    }
    if (request.executeAfterUnixMs !== undefined) {
      if (!Number.isSafeInteger(request.executeAfterUnixMs) || request.executeAfterUnixMs < 0) {
        throw new Error("Encrypted v12 witness has an invalid execution epoch");
      }
      const delay = request.executeAfterUnixMs - Date.now();
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    }
    const driver = new V12PolygonDriver({
      rpcUrl,
      pool: getAddress(required("V12_POOL_ADDRESS")),
      adapter: getAddress(required("V12_ADAPTER_ADDRESS")),
      usdce: USDCE,
      pusd: PUSD,
      ctf: CTF,
      batchVerifier: getAddress(required("V12_BUY_BATCH_VERIFIER")),
      guardian: getAddress(required("V12_GUARDIAN")),
      exchange: getAddress(required("V12_EXCHANGE_ADDRESS")),
      relayerKey,
      depositWalletSigner: signer,
      clob,
      orderJournal,
    });
    const result = await runV12BuyBatch(request, batchJournal, driver, proveV12BuyBatch);
    await orderQueue.recordReceipts(result.batchId, request, result.fills);
    console.log(JSON.stringify({ batchId: result.batchId, state: "settled",
      aggregateShares: result.terminal.returnShares.toString() }));
  } finally {
    await orderJournal.close();
    await batchJournal.close();
    await witnessVault.close();
    await orderQueue.close();
  }
}

main().catch((error: unknown) => {
  const detail = error instanceof Error ? error.message : "unknown error";
  console.error(`V12 execution halted: ${detail}. Reconcile journals, Polygon, and CLOB state before retrying.`);
  process.exitCode = 1;
});
