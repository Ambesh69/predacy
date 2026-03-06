/**
 * Test CLOB auth using the exact same headers as @polymarket/clob-client
 * Run: cd relayer && npx tsx scripts/testClobAuth2.ts
 */
import "dotenv/config";
import { buildPolyHmacSignature } from "@polymarket/clob-client/dist/signing/hmac.js";
import { ClobClient } from "@polymarket/clob-client";
import { createWalletClient, http } from "viem";
import { polygon } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import axios from "axios";

const CLOB = "https://clob.polymarket.com";

const PK = (process.env.RELAYER_PRIVATE_KEY || "") as `0x${string}`;
if (!PK) {
  console.error("Set RELAYER_PRIVATE_KEY");
  process.exit(1);
}

const account = privateKeyToAccount(PK);
console.log("Signer:", account.address);

// Derive API creds from private key (same as generateClobApiKey.ts)
const walletClient = createWalletClient({
  account,
  chain: polygon,
  transport: http("https://polygon-rpc.com/"),
});
const client = new ClobClient(CLOB, 137, walletClient);
const creds = await client.deriveApiKey(0);
console.log("API key:", creds.key);

// Build L2 auth headers exactly as the library does
const ts  = Math.floor(Date.now() / 1000);
const sig = await buildPolyHmacSignature(creds.secret, ts, "GET", "/data/orders", undefined);

const headers = {
  POLY_ADDRESS:    account.address,
  POLY_SIGNATURE:  sig,
  POLY_TIMESTAMP:  `${ts}`,
  POLY_API_KEY:    creds.key,
  POLY_PASSPHRASE: creds.passphrase,
};

console.log("\nHeaders:", JSON.stringify(headers, null, 2));

const res = await axios.get(`${CLOB}/data/orders`, { headers }).catch((e: any) => ({
  status: e?.response?.status,
  data:   e?.response?.data,
}));
console.log("\nGET /data/orders →", (res as any).status ?? 200);
console.log(JSON.stringify((res as any).data ?? (res as any), null, 2).slice(0, 500));
