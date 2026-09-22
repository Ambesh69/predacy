import "dotenv/config";
import { WalletType } from "@polymarket/client";
import {
  createPublicClient, getAddress, http, parseAbi, type Address, type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";
import { createOperatorDepositWallet } from "../src/depositWalletClient.js";
import { PostgresV12BatchJournal } from "../src/v12BatchJournal.js";
import { PostgresV12OrderQueue } from "../src/v12OrderQueue.js";

const USDCE = getAddress("0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174");
const PUSD = getAddress("0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB");
const CTF = getAddress("0x4D97DCd97eC945f40cF65F87097ACe5EA0476045");

const poolAbi = parseAbi([
  "function paused() view returns (bool)",
  "function activeBuy() view returns (bytes32,bytes32,uint256,uint256,uint8,bool)",
  "function collateral() view returns (address)",
  "function ctf() view returns (address)",
  "function withdrawVerifier() view returns (address)",
  "function transferVerifier() view returns (address)",
  "function orderVerifier() view returns (address)",
  "function batchVerifier() view returns (address)",
  "function executionAdapter() view returns (address)",
  "function guardian() view returns (address)",
  "function relayer() view returns (address)",
]);
const adapterAbi = parseAbi([
  "function usdce() view returns (address)",
  "function pusd() view returns (address)",
  "function pool() view returns (address)",
  "function operator() view returns (address)",
  "function guardian() view returns (address)",
  "function depositWallet() view returns (address)",
]);

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function main(): Promise<void> {
  const errors: string[] = [];
  const checks: Record<string, unknown> = {};
  const capture = async (name: string, check: () => Promise<unknown>) => {
    try { checks[name] = await check(); } catch (error) {
      checks[name] = "failed";
      errors.push(`${name}: ${error instanceof Error ? error.message : "unknown error"}`);
    }
  };

  const rpcUrl = required("RPC_URL");
  const databaseUrl = required("V12_DATABASE_URL");
  const journalKey = required("V12_JOURNAL_KEY");
  const pool = getAddress(required("V12_POOL_ADDRESS"));
  const adapter = getAddress(required("V12_ADAPTER_ADDRESS"));
  const withdrawVerifier = getAddress(required("V12_WITHDRAW_VERIFIER"));
  const transferVerifier = getAddress(required("V12_TRANSFER_VERIFIER"));
  const orderVerifier = getAddress(required("V12_ORDER_VERIFIER"));
  const batchVerifier = getAddress(required("V12_BUY_BATCH_VERIFIER"));
  const guardian = getAddress(required("V12_GUARDIAN"));
  const depositWallet = getAddress(required("V12_DEPOSIT_WALLET"));
  const relayerKey = required("V12_RELAYER_PRIVATE_KEY") as Hex;
  const signerKey = required("V12_SIGNER_PRIVATE_KEY") as Hex;
  const relayer = privateKeyToAccount(relayerKey).address;
  const signer = privateKeyToAccount(signerKey).address;
  if (new Set([relayer.toLowerCase(), signer.toLowerCase(), guardian.toLowerCase()]).size !== 3) {
    throw new Error("V12 relayer, Deposit Wallet signer, and guardian must be separate roles");
  }

  const reader = createPublicClient({ chain: polygon, transport: http(rpcUrl, { timeout: 15_000 }) });
  await capture("polygon", async () => {
    if (await reader.getChainId() !== polygon.id) throw new Error("RPC is not Polygon mainnet");
    const addresses = [pool, adapter, withdrawVerifier, transferVerifier, orderVerifier, batchVerifier, depositWallet];
    const code = await Promise.all(addresses.map((address) => reader.getCode({ address })));
    if (code.some((value) => !value || value === "0x")) throw new Error("A configured v12 contract is undeployed");
    return "pass";
  });

  await capture("contracts", async () => {
    const [paused, active, collateral, ctf, actualWithdraw, actualTransfer, actualOrder, actualBatch,
      actualAdapter, actualGuardian, actualRelayer, adapterUsdce, adapterPusd, adapterPool,
      adapterOperator, adapterGuardian, actualWallet] = await Promise.all([
      reader.readContract({ address: pool, abi: poolAbi, functionName: "paused" }),
      reader.readContract({ address: pool, abi: poolAbi, functionName: "activeBuy" }),
      reader.readContract({ address: pool, abi: poolAbi, functionName: "collateral" }),
      reader.readContract({ address: pool, abi: poolAbi, functionName: "ctf" }),
      reader.readContract({ address: pool, abi: poolAbi, functionName: "withdrawVerifier" }),
      reader.readContract({ address: pool, abi: poolAbi, functionName: "transferVerifier" }),
      reader.readContract({ address: pool, abi: poolAbi, functionName: "orderVerifier" }),
      reader.readContract({ address: pool, abi: poolAbi, functionName: "batchVerifier" }),
      reader.readContract({ address: pool, abi: poolAbi, functionName: "executionAdapter" }),
      reader.readContract({ address: pool, abi: poolAbi, functionName: "guardian" }),
      reader.readContract({ address: pool, abi: poolAbi, functionName: "relayer" }),
      reader.readContract({ address: adapter, abi: adapterAbi, functionName: "usdce" }),
      reader.readContract({ address: adapter, abi: adapterAbi, functionName: "pusd" }),
      reader.readContract({ address: adapter, abi: adapterAbi, functionName: "pool" }),
      reader.readContract({ address: adapter, abi: adapterAbi, functionName: "operator" }),
      reader.readContract({ address: adapter, abi: adapterAbi, functionName: "guardian" }),
      reader.readContract({ address: adapter, abi: adapterAbi, functionName: "depositWallet" }),
    ]);
    const expected: Array<[Address, Address, string]> = [
      [getAddress(collateral), USDCE, "pool collateral"], [getAddress(ctf), CTF, "pool CTF"],
      [getAddress(actualWithdraw), withdrawVerifier, "withdraw verifier"],
      [getAddress(actualTransfer), transferVerifier, "transfer verifier"],
      [getAddress(actualOrder), orderVerifier, "order verifier"],
      [getAddress(actualBatch), batchVerifier, "batch verifier"],
      [getAddress(actualAdapter), adapter, "pool adapter"], [getAddress(actualGuardian), guardian, "pool guardian"],
      [getAddress(actualRelayer), relayer, "pool relayer"], [getAddress(adapterUsdce), USDCE, "adapter USDC.e"],
      [getAddress(adapterPusd), PUSD, "adapter pUSD"], [getAddress(adapterPool), pool, "adapter pool"],
      [getAddress(adapterOperator), relayer, "adapter operator"],
      [getAddress(adapterGuardian), guardian, "adapter guardian"],
      [getAddress(actualWallet), depositWallet, "adapter Deposit Wallet"],
    ];
    const mismatch = expected.find(([actual, wanted]) => actual !== wanted);
    if (mismatch) throw new Error(`${mismatch[2]} mismatch`);
    if (active[5]) throw new Error("A v12 batch is still active");
    if (process.env.V12_PRIVATE_TRADING_ENABLED !== "true" && !paused) {
      throw new Error("Pool must remain paused while public intake is disabled");
    }
    return { identity: "pass", paused };
  });

  await capture("postgres", async () => {
    const journal = await PostgresV12BatchJournal.connect(databaseUrl);
    const queue = await PostgresV12OrderQueue.connect(databaseUrl, journalKey, { executionEpochMs: 0 });
    try {
      const unresolved = await journal.listUnresolved();
      const pending = await queue.pendingBatchIds();
      if (unresolved.length) throw new Error(`${unresolved.length} chain action(s) require reconciliation`);
      if (pending.length) throw new Error(`${pending.length} encrypted batch(es) require recovery`);
      return "pass";
    } finally {
      await Promise.all([journal.close(), queue.close()]);
    }
  });

  await capture("polymarket", async () => {
    const client = await createOperatorDepositWallet({
      signerPrivateKey: signerKey,
      builderKey: required("POLYMARKET_BUILDER_KEY"),
      builderSecret: required("POLYMARKET_BUILDER_SECRET"),
      builderPassphrase: required("POLYMARKET_BUILDER_PASSPHRASE"),
      rpcUrl,
      expectedSigner: signer,
      expectedWallet: depositWallet,
    });
    if (client.account.walletType !== WalletType.DEPOSIT_WALLET ||
        getAddress(client.account.wallet) !== depositWallet) throw new Error("Deposit Wallet identity mismatch");
    return "pass";
  });

  console.log(JSON.stringify({ ready: errors.length === 0, checks, errors }, null, 2));
  if (errors.length) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "V12 preflight failed");
  process.exitCode = 1;
});
