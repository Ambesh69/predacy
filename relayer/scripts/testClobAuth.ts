/**
 * Quick auth test — checks if API key is valid on Polymarket CLOB.
 * Run: cd relayer && npx tsx scripts/testClobAuth.ts
 */
import "dotenv/config";
import { createHmac } from "node:crypto";
import axios from "axios";

const CLOB = "https://clob.polymarket.com";

const apiKey        = process.env.POLYMARKET_API_KEY        || "8deaf5f4-d1bb-31fa-fb61-50dffabc8017";
const apiSecret     = process.env.POLYMARKET_API_SECRET     || "4JjxgThu9m1Wc0Iexd_Hbr_9jUDtgwVXj1OpUM154Fg=";
const apiPassphrase = process.env.POLYMARKET_API_PASSPHRASE || "bc22e8157fb7a689d9e2ba80a667063c0a9a1844a927702b081ca0fe28b9fd5f";

console.log(`Testing API key: ${apiKey}`);

function authHeaders(method: string, path: string, body = "") {
  const ts      = Math.floor(Date.now() / 1000).toString();
  const message = ts + method.toUpperCase() + path + body;
  // Decode base64url secret to binary (Polymarket stores secrets as base64url)
  const secretBinary = Buffer.from(apiSecret.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  // Output must be URL-safe base64 (+→-, /→_)
  const sig = createHmac("sha256", secretBinary).update(message).digest("base64")
    .replace(/\+/g, "-").replace(/\//g, "_");
  return {
    "POLY-API-KEY":    apiKey,
    "POLY-SIGNATURE":  sig,
    "POLY-TIMESTAMP":  ts,
    "POLY-PASSPHRASE": apiPassphrase,
  };
}

async function get(path: string) {
  try {
    const res = await axios.get(`${CLOB}${path}`, { headers: authHeaders("GET", path) });
    return { status: res.status, data: res.data };
  } catch (e: any) {
    return { status: e?.response?.status, data: e?.response?.data };
  }
}

// Test various authenticated endpoints
const endpoints = [
  "/orders",           // list open orders — authenticated GET
  "/positions",        // list positions — authenticated GET
  "/data/orders",      // historical orders — authenticated GET
];

for (const path of endpoints) {
  const r = await get(path);
  const body = typeof r.data === "string" ? r.data.slice(0, 200) : JSON.stringify(r.data).slice(0, 300);
  console.log(`GET ${path} → ${r.status}: ${body}`);
}
