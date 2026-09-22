import "dotenv/config";
import { createPublicClient, getAddress, http, isAddressEqual, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";
import { PostgresV13BatchJournal, PostgresV13WitnessVault } from "../src/v13BatchJournal.js";
import { resolveV13LaunchPolicy } from "../src/v13LaunchPolicy.js";

function required(name: string) { const value = process.env[name]?.trim(); if (!value) throw new Error(`${name} is required`); return value; }

async function main() {
  const policy = resolveV13LaunchPolicy(polygon.id, process.env);
  if (process.env.V13_PRIVATE_TRADING_ENABLED === "true" && !policy.enabled) throw new Error(policy.blocker!);
  const rpcUrl = required("RPC_URL"); const databaseUrl = required("V13_DATABASE_URL");
  const key = required("V13_JOURNAL_KEY"); const poolAddress = getAddress(required("V13_POOL_ADDRESS"));
  const adapterAddress = getAddress(required("V13_ADAPTER_ADDRESS"));
  const configured = {
    withdraw: getAddress(required("V13_WITHDRAW_VERIFIER")), transfer: getAddress(required("V13_TRANSFER_VERIFIER")),
    order: getAddress(required("V13_ORDER_VERIFIER")), route: getAddress(required("V13_ROUTE_VERIFIER")),
    settlement: getAddress(required("V13_SETTLEMENT_VERIFIER")), cancel: getAddress(required("V13_CANCEL_VERIFIER")),
    guardian: getAddress(required("V13_GUARDIAN")), depositWallet: getAddress(required("V13_DEPOSIT_WALLET")),
  };
  const relayer = privateKeyToAccount(required("V13_RELAYER_PRIVATE_KEY") as `0x${string}`).address;
  const signer = privateKeyToAccount(required("V13_SIGNER_PRIVATE_KEY") as `0x${string}`).address;
  if (relayer === signer || relayer === configured.guardian || signer === configured.guardian) {
    throw new Error("V13 relayer, Deposit Wallet signer, and guardian must be separate");
  }
  const client = createPublicClient({ chain: polygon, transport: http(rpcUrl) });
  const addresses = [poolAddress, adapterAddress, configured.withdraw, configured.transfer, configured.order,
    configured.route, configured.settlement, configured.cancel, configured.depositWallet];
  const code = await Promise.all(addresses.map((address) => client.getCode({ address })));
  if (code.some((value) => !value || value === "0x")) throw new Error("A configured v13 contract is undeployed");
  const abi = parseAbi([
    "function withdrawVerifier() view returns(address)", "function transferVerifier() view returns(address)",
    "function orderVerifier() view returns(address)", "function routeVerifier() view returns(address)",
    "function settlementVerifier() view returns(address)", "function cancelVerifier() view returns(address)",
    "function executionAdapter() view returns(address)", "function guardian() view returns(address)",
    "function relayer() view returns(address)", "function paused() view returns(bool)",
    "function activeBuy() view returns(bytes32,bytes32,uint256,uint256,bool)",
  ]);
  const [withdraw, transfer, order, route, settlement, cancel, adapter, guardian, onchainRelayer, paused, active] =
    await Promise.all([
      client.readContract({ address: poolAddress, abi, functionName: "withdrawVerifier" }),
      client.readContract({ address: poolAddress, abi, functionName: "transferVerifier" }),
      client.readContract({ address: poolAddress, abi, functionName: "orderVerifier" }),
      client.readContract({ address: poolAddress, abi, functionName: "routeVerifier" }),
      client.readContract({ address: poolAddress, abi, functionName: "settlementVerifier" }),
      client.readContract({ address: poolAddress, abi, functionName: "cancelVerifier" }),
      client.readContract({ address: poolAddress, abi, functionName: "executionAdapter" }),
      client.readContract({ address: poolAddress, abi, functionName: "guardian" }),
      client.readContract({ address: poolAddress, abi, functionName: "relayer" }),
      client.readContract({ address: poolAddress, abi, functionName: "paused" }),
      client.readContract({ address: poolAddress, abi, functionName: "activeBuy" }),
    ]);
  const actual = [withdraw, transfer, order, route, settlement, cancel, adapter, guardian, onchainRelayer].map(getAddress);
  const expected = [configured.withdraw, configured.transfer, configured.order, configured.route,
    configured.settlement, configured.cancel, adapterAddress, configured.guardian, relayer];
  const labels = ["withdraw", "transfer", "order", "route", "settlement", "cancel", "adapter", "guardian", "relayer"];
  const mismatch = actual.findIndex((value, i) => !isAddressEqual(value, expected[i]));
  if (mismatch !== -1) {
    throw new Error(`V13 ${labels[mismatch]} mismatch: expected ${expected[mismatch]}, received ${actual[mismatch]}`);
  }
  if (active[4]) throw new Error("A v13 batch is active");
  if (!policy.enabled && !paused) throw new Error("Disabled v13 intake requires the pool to remain paused");
  if (policy.enabled && paused) throw new Error("Enabled v13 intake points to a paused pool");
  const [journal, vault] = await Promise.all([
    PostgresV13BatchJournal.connect(databaseUrl), PostgresV13WitnessVault.connect(databaseUrl, key),
  ]);
  try {
    const unresolved = await journal.listUnresolved();
    if (unresolved.length) throw new Error(`${unresolved.length} unresolved v13 journal action(s)`);
  } finally { await Promise.all([journal.close(), vault.close()]); }
  console.log(JSON.stringify({ ok: true, policy, pool: poolAddress, adapter: adapterAddress, paused }));
}
main().catch((error) => { console.error(error instanceof Error ? error.message : "V13 preflight failed"); process.exitCode = 1; });
