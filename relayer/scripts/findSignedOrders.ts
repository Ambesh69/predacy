import axios from "axios";
import { createHmac } from "node:crypto";

const CLOB = "https://clob.polymarket.com";
const key    = process.env.POLYMARKET_API_KEY!;
const secret = process.env.POLYMARKET_API_SECRET!;
const pass   = process.env.POLYMARKET_API_PASSPHRASE!;
const addr   = process.env.RELAYER_ADDRESS ?? "";
const marketId = process.env.MARKET_ID!;

function auth(method: string, path: string) {
  const ts = Math.floor(Date.now() / 1000).toString();
  const bin = Buffer.from(secret.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  const sig = createHmac("sha256", bin).update(ts + method.toUpperCase() + path).digest("base64").replace(/\+/g, "-").replace(/\//g, "_");
  return { POLY_ADDRESS: addr, POLY_SIGNATURE: sig, POLY_TIMESTAMP: ts, POLY_API_KEY: key, POLY_PASSPHRASE: pass };
}

// First get the market to find token IDs
const mkt = await axios.get(`${CLOB}/markets/${marketId}`).catch((e:any) => e.response);
console.log("Market status:", mkt?.status);
const tokenId = mkt?.data?.tokens?.[0]?.token_id;
console.log("YES token ID:", tokenId);

if (!tokenId) { console.log("Full market data:", JSON.stringify(mkt?.data).slice(0,500)); process.exit(1); }

// Try endpoints that might return signed orders
const tests = [
  [`/book`, { token_id: tokenId }],
  [`/data/orders`, { market: marketId, status: "OPEN", limit: 5 }],
  [`/orders`, { token_id: tokenId, status: "OPEN" }],
  [`/sampling-markets`, { condition_id: marketId }],
] as const;

for (const [path, params] of tests) {
  const r = await axios.get(`${CLOB}${path}`, {
    params,
    headers: auth("GET", path),
  }).catch((e:any) => e.response);
  const data = r?.data;
  const snippet = JSON.stringify(data).slice(0, 200);
  console.log(`\n${path} →`, r?.status, snippet);
  // Check if any returned orders have a 'signature' field
  const orders = Array.isArray(data) ? data : data?.data ?? data?.orders ?? [];
  if (orders.length > 0) {
    console.log("  Keys:", Object.keys(orders[0]).join(", "));
    if (orders[0].signature) console.log("  ✅ HAS SIGNATURE!");
  }
}
