import "dotenv/config";
import { getAddress, createPublicClient, http, parseAbi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";
import { privateKey } from "@polymarket/client/viem";
import { createOperatorDepositWallet } from "../src/depositWalletClient.js";
import { PostgresV11BatchJournal } from "../src/v11BatchJournal.js";
import { PostgresV11OrderJournal } from "../src/v11OrderJournal.js";
import { parseV11OrderManifest } from "../src/v11OrderManifest.js";
import { PostgresV11PilotBudget, AUTHORIZED_V11_PILOT_CAP_MICRO_USD } from "../src/v11PilotBudget.js";
import { V11PolygonDriver } from "../src/v11PolygonDriver.js";
import { assertV11PolygonAssets } from "../src/v11PolygonAssets.js";
import { assessV11Environment, assertV11VaultIdentity } from "../src/v11Readiness.js";
import { runV11SingleOrder } from "../src/v11SingleOrderRunner.js";

const vaultAbi = parseAbi([
  "function usdce() view returns (address)",
  "function pusd() view returns (address)",
  "function ctf() view returns (address)",
  "function onramp() view returns (address)",
  "function offramp() view returns (address)",
  "function allocationVerifier() view returns (address)",
  "function relayer() view returns (address)",
  "function guardian() view returns (address)",
  "function depositWallet() view returns (address)",
]);

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function main(): Promise<void> {
  if (process.argv.length !== 4 || process.argv[2] !== "--execute" || !/^\d+$/.test(process.argv[3])) {
    throw new Error("Usage: npm run run:v11 -- --execute <closed-batch-id>");
  }
  const readiness = assessV11Environment(process.env);
  if (!readiness.readyForReadOnlyChecks) {
    throw new Error(`V11 configuration incomplete: ${[...readiness.missing, ...readiness.errors].join(", ")}`);
  }
  const batchId = process.argv[3];
  const order = parseV11OrderManifest(required("V11_ORDER_JSON"), batchId);
  const wallet = getAddress(required("V11_DEPOSIT_WALLET"));
  if (order.depositWallet !== wallet) throw new Error("V11 manifest Deposit Wallet differs from configuration");
  const signerKey = required("V11_SIGNER_PRIVATE_KEY") as Hex;
  const relayerKey = required("V11_RELAYER_PRIVATE_KEY") as Hex;
  if ([process.env.POLYMARKET_SIGNER_KEY, process.env.RELAYER_PRIVATE_KEY].some(
    (key) => key?.toLowerCase() === signerKey.toLowerCase(),
  )) throw new Error("V11 signer must not reuse a legacy production key");

  const rpcUrl = required("RPC_URL");
  const vault = getAddress(required("V11_VAULT_ADDRESS"));
  const reader = createPublicClient({ chain: polygon, transport: http(rpcUrl) });
  if (await reader.getChainId() !== polygon.id) throw new Error("V11 RPC is not Polygon mainnet");
  const [vaultCode, walletCode, usdce, pusd, ctf, onramp, offramp,
    verifier, relayer, guardian, actualWallet] = await Promise.all([
    reader.getCode({ address: vault }), reader.getCode({ address: wallet }),
    reader.readContract({ address: vault, abi: vaultAbi, functionName: "usdce" }),
    reader.readContract({ address: vault, abi: vaultAbi, functionName: "pusd" }),
    reader.readContract({ address: vault, abi: vaultAbi, functionName: "ctf" }),
    reader.readContract({ address: vault, abi: vaultAbi, functionName: "onramp" }),
    reader.readContract({ address: vault, abi: vaultAbi, functionName: "offramp" }),
    reader.readContract({ address: vault, abi: vaultAbi, functionName: "allocationVerifier" }),
    reader.readContract({ address: vault, abi: vaultAbi, functionName: "relayer" }),
    reader.readContract({ address: vault, abi: vaultAbi, functionName: "guardian" }),
    reader.readContract({ address: vault, abi: vaultAbi, functionName: "depositWallet" }),
  ]);
  if (!vaultCode || vaultCode === "0x" || !walletCode || walletCode === "0x") {
    throw new Error("V11 vault or Deposit Wallet is undeployed");
  }
  assertV11VaultIdentity({ depositWallet: actualWallet, relayer, guardian,
    allocationVerifier: verifier }, {
    depositWallet: wallet, relayer: privateKeyToAccount(relayerKey).address,
    guardian: getAddress(required("V11_GUARDIAN")),
    allocationVerifier: getAddress(required("V11_ALLOCATION_VERIFIER")),
  });
  assertV11PolygonAssets({ usdce, pusd, ctf, onramp, offramp });

  const signer = privateKey(signerKey, { transport: http(rpcUrl) });
  const clob = await createOperatorDepositWallet({
    signerPrivateKey: signerKey,
    builderKey: required("POLYMARKET_BUILDER_KEY"),
    builderSecret: required("POLYMARKET_BUILDER_SECRET"),
    builderPassphrase: required("POLYMARKET_BUILDER_PASSPHRASE"),
    rpcUrl, expectedSigner: privateKeyToAccount(signerKey).address, expectedWallet: wallet,
  });
  const driver = new V11PolygonDriver({
    rpcUrl, vault, usdce, pusd, ctf, onramp, offramp,
    allocationVerifier: verifier, guardian, exchange: getAddress(required("V11_EXCHANGE_ADDRESS")) as Address,
    relayerKey, depositWalletSigner: signer, clob,
  });

  const databaseUrl = required("V11_DATABASE_URL");
  const batchJournal = await PostgresV11BatchJournal.connect(databaseUrl);
  try {
    const orderJournal = await PostgresV11OrderJournal.connect(databaseUrl);
    try {
      const budget = await PostgresV11PilotBudget.connect(databaseUrl, AUTHORIZED_V11_PILOT_CAP_MICRO_USD);
      try {
        await runV11SingleOrder(order, batchJournal, orderJournal, driver, budget);
        console.log(JSON.stringify({ batchId, state: "settled" }));
      } finally { await budget.close(); }
    } finally { await orderJournal.close(); }
  } finally { await batchJournal.close(); }
}

main().catch((error: unknown) => {
  const detail = error instanceof Error ? error.message : "unknown error";
  console.error(`V11 execution halted: ${detail}. Inspect the durable journals and on-chain/CLOB state before retrying.`);
  process.exitCode = 1;
});
