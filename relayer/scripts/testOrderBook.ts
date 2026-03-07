import axios from "axios";
import { createHmac } from "node:crypto";

const CLOB   = "https://clob.polymarket.com";
const key    = process.env.POLYMARKET_API_KEY!;
const secret = process.env.POLYMARKET_API_SECRET!;
const pass   = process.env.POLYMARKET_API_PASSPHRASE!;
const addr   = process.env.RELAYER_ADDRESS ?? "";

function authHeaders(method: string, path: string) {
  const ts = Math.floor(Date.now() / 1000).toString();
  const bin = Buffer.from(secret.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  const sig = createHmac("sha256", bin).update(ts + method + path).digest("base64").replace(/\+/g, "-").replace(/\//g, "_");
  return { POLY_ADDRESS: addr, POLY_SIGNATURE: sig, POLY_TIMESTAMP: ts, POLY_API_KEY: key, POLY_PASSPHRASE: pass };
}

const tokenId = "52114319501245915516055106046884209969926127482827954674443846427813813222426";

// Test 1: GET /orders (own orders, authenticated)
const r1 = await axios.get(`${CLOB}/orders`, {
  params: { market: process.env.MARKET_ID, status: "OPEN" },
  headers: authHeaders("GET", "/orders"),
}).catch((e: any) => e.response);
console.log("GET /orders (own):", r1?.status);
const ownOrders = r1?.data ?? [];
console.log("  count:", Array.isArray(ownOrders) ? ownOrders.length : ownOrders);
if (Array.isArray(ownOrders) && ownOrders[0]) console.log("  sample keys:", Object.keys(ownOrders[0]));

// Test 2: GET /book (public aggregated book)
const r2 = await axios.get(`${CLOB}/book`, {
  params: { token_id: tokenId },
}).catch((e: any) => e.response);
console.log("\nGET /book (public):", r2?.status);
console.log("  data:", JSON.stringify(r2?.data ?? {}).slice(0, 300));

// Test 3: GET /orderbook (alternative endpoint)  
const r3 = await axios.get(`${CLOB}/orderbook`, {
  params: { token_id: tokenId },
}).catch((e: any) => e.response);
console.log("\nGET /orderbook:", r3?.status, JSON.stringify(r3?.data ?? {}).slice(0, 200));

// Test 4: GET /orders without auth (public?)
const r4 = await axios.get(`${CLOB}/orders`, {
  params: { market: process.env.MARKET_ID, maker_address: "0x0000000000000000000000000000000000000001" },
}).catch((e: any) => e.response);
console.log("\nGET /orders (no auth):", r4?.status, JSON.stringify(r4?.data ?? {}).slice(0, 200));
