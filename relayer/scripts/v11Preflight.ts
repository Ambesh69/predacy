import "dotenv/config";
import { Pool } from "pg";
import { createPublicClient, getAddress, http, parseAbi, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";
import { assessV11Environment, assertV11VaultIdentity } from "../src/v11Readiness.js";
import { assertV11PolygonAssets } from "../src/v11PolygonAssets.js";

const vaultAbi = parseAbi([
  "function depositWallet() view returns (address)",
  "function relayer() view returns (address)",
  "function guardian() view returns (address)",
  "function allocationVerifier() view returns (address)",
  "function usdce() view returns (address)",
  "function pusd() view returns (address)",
  "function ctf() view returns (address)",
  "function onramp() view returns (address)",
  "function offramp() view returns (address)",
]);

async function main(): Promise<void> {
  const config = assessV11Environment(process.env);
  const report: Record<string, unknown> = {
    configuration: config,
    polygonRpc: "not_checked",
    vault: "not_checked",
    database: "not_checked",
    livePilotPermitted: false,
  };
  if (!config.readyForReadOnlyChecks) {
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = 1;
    return;
  }

  const reader = createPublicClient({ chain: polygon, transport: http(process.env.RPC_URL!, { timeout: 10_000 }) });
  try {
    const chainId = await reader.getChainId();
    if (chainId !== polygon.id) throw new Error("RPC is not Polygon mainnet");
    report.polygonRpc = "pass";
    const vault = getAddress(process.env.V11_VAULT_ADDRESS!) as Address;
    const wallet = getAddress(process.env.V11_DEPOSIT_WALLET!) as Address;
    const verifier = getAddress(process.env.V11_ALLOCATION_VERIFIER!) as Address;
    const [vaultCode, walletCode, verifierCode, actualWallet, actualRelayer, actualGuardian, actualVerifier,
      usdce, pusd, ctf, onramp, offramp] = await Promise.all([
      reader.getCode({ address: vault }),
      reader.getCode({ address: wallet }),
      reader.getCode({ address: verifier }),
      reader.readContract({ address: vault, abi: vaultAbi, functionName: "depositWallet" }),
      reader.readContract({ address: vault, abi: vaultAbi, functionName: "relayer" }),
      reader.readContract({ address: vault, abi: vaultAbi, functionName: "guardian" }),
      reader.readContract({ address: vault, abi: vaultAbi, functionName: "allocationVerifier" }),
      reader.readContract({ address: vault, abi: vaultAbi, functionName: "usdce" }),
      reader.readContract({ address: vault, abi: vaultAbi, functionName: "pusd" }),
      reader.readContract({ address: vault, abi: vaultAbi, functionName: "ctf" }),
      reader.readContract({ address: vault, abi: vaultAbi, functionName: "onramp" }),
      reader.readContract({ address: vault, abi: vaultAbi, functionName: "offramp" }),
    ]);
    if (!vaultCode || vaultCode === "0x" || !walletCode || walletCode === "0x" ||
        !verifierCode || verifierCode === "0x") {
      throw new Error("V11 vault, Deposit Wallet, or verifier is undeployed");
    }
    assertV11VaultIdentity({ depositWallet: actualWallet, relayer: actualRelayer,
      guardian: actualGuardian,
      allocationVerifier: actualVerifier }, {
      depositWallet: wallet,
      relayer: privateKeyToAccount(process.env.V11_RELAYER_PRIVATE_KEY as `0x${string}`).address,
      guardian: getAddress(process.env.V11_GUARDIAN!),
      allocationVerifier: verifier,
    });
    assertV11PolygonAssets({ usdce, pusd, ctf, onramp, offramp });
    report.vault = "pass";
  } catch {
    report.vault = "failed_onchain_identity_or_rpc_check";
  }

  const pool = new Pool({ connectionString: process.env.V11_DATABASE_URL, connectionTimeoutMillis: 5_000, max: 1 });
  try {
    await pool.query("SELECT 1");
    report.database = "pass";
  } catch {
    report.database = "unreachable";
  } finally {
    await pool.end();
  }
  console.log(JSON.stringify(report, null, 2));
  if (report.polygonRpc !== "pass" || report.vault !== "pass" || report.database !== "pass") {
    process.exitCode = 1;
  }
}

main().catch(() => {
  console.error("V11 read-only preflight failed");
  process.exitCode = 1;
});
