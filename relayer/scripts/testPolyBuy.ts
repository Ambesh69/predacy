/**
 * Test if PolymarketClient can place a GTC limit buy order.
 * Uses the working _buildSignedOrder path to verify auth + EIP-712 works.
 */
import "dotenv/config";
import { PolymarketClient } from "../src/polymarketClient.js";

const API_KEY  = process.env.POLYMARKET_API_KEY;
const API_SEC  = process.env.POLYMARKET_API_SECRET;
const API_PASS = process.env.POLYMARKET_API_PASSPHRASE;
const PK       = (process.env.RELAYER_PRIVATE_KEY ?? "") as `0x${string}`;

const TOKEN_ID = "41583919731714354912849507182398941127545694257513505398713274521520484370640";

if (!PK || !API_KEY || !API_SEC || !API_PASS || process.argv[2] !== "--live") {
  console.error("Set CLOB credentials and RELAYER_PRIVATE_KEY, then pass --live to post an order");
  process.exit(1);
}

const client = new PolymarketClient(API_KEY, API_SEC, API_PASS, PK);
console.log("Testing PolymarketClient.placeLimitBuy (GTC at 0.50)…");

try {
  const res = await client.placeLimitBuy(TOKEN_ID, 5_000_000n, 0.50);
  console.log("✅ Order placed:", JSON.stringify(res));
} catch(e: any) {
  console.log("❌ Error:", e?.response?.status ?? "", JSON.stringify(e?.response?.data ?? e?.message ?? String(e)));
}
