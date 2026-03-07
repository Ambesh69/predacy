/**
 * Test if PolymarketClient can place a GTC limit buy order.
 * Uses the working _buildSignedOrder path to verify auth + EIP-712 works.
 */
import "dotenv/config";
import { PolymarketClient } from "../src/polymarketClient.js";

const API_KEY  = process.env.POLYMARKET_API_KEY        || "8deaf5f4-d1bb-31fa-fb61-50dffabc8017";
const API_SEC  = process.env.POLYMARKET_API_SECRET     || "4JjxgThu9m1Wc0Iexd_Hbr_9jUDtgwVXj1OpUM154Fg=";
const API_PASS = process.env.POLYMARKET_API_PASSPHRASE || "bc22e8157fb7a689d9e2ba80a667063c0a9a1844a927702b081ca0fe28b9fd5f";
const PK       = (process.env.RELAYER_PRIVATE_KEY ?? "") as `0x${string}`;

const TOKEN_ID = "41583919731714354912849507182398941127545694257513505398713274521520484370640";

if (!PK) { console.error("Set RELAYER_PRIVATE_KEY"); process.exit(1); }

const client = new PolymarketClient(API_KEY, API_SEC, API_PASS, PK);
console.log("Testing PolymarketClient.placeLimitBuy (GTC at 0.50)…");

try {
  const res = await client.placeLimitBuy(TOKEN_ID, 5_000_000n, 0.50);
  console.log("✅ Order placed:", JSON.stringify(res));
} catch(e: any) {
  console.log("❌ Error:", e?.response?.status ?? "", JSON.stringify(e?.response?.data ?? e?.message ?? String(e)));
}
