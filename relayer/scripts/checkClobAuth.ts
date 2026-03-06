/**
 * Diagnose Polymarket CLOB API auth.
 *
 * Checks:
 *   1. Is the API key valid? (GET /profile)
 *   2. What proxy wallet is associated with this API key?
 *   3. What proxy wallet does Polymarket derive for the signer EOA?
 *
 * Run:
 *   cd relayer && npx tsx scripts/checkClobAuth.ts
 *
 * Required env vars: RELAYER_PRIVATE_KEY (mainnet key), POLYMARKET_API_KEY,
 *   POLYMARKET_API_SECRET, POLYMARKET_API_PASSPHRASE
 */

import "dotenv/config";
import { createHmac } from "node:crypto";
import { createWalletClient, http } from "viem";
import { polygon } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { ClobClient } from "@polymarket/clob-client";
import axios from "axios";

const CLOB_API = "https://clob.polymarket.com";

const PK = (process.env.RELAYER_PRIVATE_KEY ?? "") as `0x${string}`;
if (!PK || PK === "0x") {
  console.error("Missing RELAYER_PRIVATE_KEY");
  process.exit(1);
}

const API_KEY        = process.env.POLYMARKET_API_KEY        ?? "";
const API_SECRET     = process.env.POLYMARKET_API_SECRET     ?? "";
const API_PASSPHRASE = process.env.POLYMARKET_API_PASSPHRASE ?? "";

const account = privateKeyToAccount(PK);
console.log(`Signer EOA: ${account.address}`);
console.log(`API key:    ${API_KEY || "(not set)"}\n`);

// ─── Build L2 auth headers ────────────────────────────────────────────────────

function authHeaders(method: string, path: string, body = ""): Record<string, string> {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const message   = timestamp + method.toUpperCase() + path + body;
  const sig       = createHmac("sha256", API_SECRET).update(message).digest("base64");
  return {
    "POLY-API-KEY":    API_KEY,
    "POLY-SIGNATURE":  sig,
    "POLY-TIMESTAMP":  timestamp,
    "POLY-PASSPHRASE": API_PASSPHRASE,
    "Content-Type":    "application/json",
  };
}

// ─── 1. Check auth via GET /profile ──────────────────────────────────────────

console.log("── Test 1: GET /profile (tests L2 auth headers) ─────────────────────────");
try {
  const res = await axios.get(`${CLOB_API}/profile`, {
    headers: authHeaders("GET", "/profile"),
  });
  console.log("✓ Auth OK! Profile:");
  console.log(JSON.stringify(res.data, null, 2));
} catch (err: any) {
  const status = err?.response?.status;
  const data   = err?.response?.data;
  console.error(`✗ Auth FAILED (${status}):`, JSON.stringify(data));
  if (status === 401) {
    console.error("\n  → API key is invalid or secret/passphrase don't match.");
    console.error("  → Run generateClobApiKey.ts with the correct RELAYER_PRIVATE_KEY.");
  }
}

// ─── 2. Derive proxy wallet via ClobClient ────────────────────────────────────

console.log("\n── Test 2: deriveApiKey — shows what key Polymarket gives for this EOA ─");
try {
  const walletClient = createWalletClient({
    account,
    chain: polygon,
    transport: http("https://polygon-rpc.com/"),
  });

  const client = new ClobClient(CLOB_API, 137, walletClient);
  const creds  = await client.deriveApiKey(0);

  console.log("Key derived from private key:");
  console.log(`  API_KEY        = ${creds.key}`);
  console.log(`  API_SECRET     = ${creds.secret}`);
  console.log(`  API_PASSPHRASE = ${creds.passphrase}`);

  if (creds.key === API_KEY) {
    console.log("\n✓ API_KEY in env matches derived key — key is correct.");
  } else {
    console.warn(`\n✗ MISMATCH! Env API_KEY=${API_KEY}`);
    console.warn(`  Derived key=${creds.key}`);
    console.warn("  → Update Railway: POLYMARKET_API_KEY, POLYMARKET_API_SECRET, POLYMARKET_API_PASSPHRASE");
    console.warn("    with the derived values above.");
  }
} catch (err: any) {
  console.error("✗ deriveApiKey failed:", err?.response?.data ?? err?.message);
}
