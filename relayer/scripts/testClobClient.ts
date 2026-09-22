/**
 * Use @polymarket/clob-client ClobClient end-to-end.
 */
import "dotenv/config";
import { ClobClient } from "@polymarket/clob-client";
import { createWalletClient, http } from "viem";
import { polygon } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

const PK       = (process.env.RELAYER_PRIVATE_KEY ?? "") as `0x${string}`;
const API_KEY  = process.env.POLYMARKET_API_KEY        || "";
const API_SEC  = process.env.POLYMARKET_API_SECRET     || "";
const API_PASS = process.env.POLYMARKET_API_PASSPHRASE || "";

if (!PK || !API_KEY || !API_SEC || !API_PASS || process.argv[2] !== "--live") {
  throw new Error("Set CLOB credentials and RELAYER_PRIVATE_KEY, then pass --live to post an order");
}

const account = privateKeyToAccount(PK);
console.log("EOA:", account.address);

const walletClient = createWalletClient({ account, chain: polygon, transport: http("https://polygon-rpc.com") });

const creds = { key: API_KEY, secret: API_SEC, passphrase: API_PASS };
const client = new ClobClient("https://clob.polymarket.com", 137, walletClient, creds);

// Try a simple order
const TOKEN_ID = "41583919731714354912849507182398941127545694257513505398713274521520484370640";
try {
  const order = await client.createOrder({
    tokenID: TOKEN_ID,
    price: 0.50,     // limit buy at 0.50 (won't fill)
    side: "BUY" as any,
    size: 5,
  });
  console.log("Order built, submitting...");
  const res = await client.postOrder(order, "GTC" as any);
  console.log("✅ Result:", JSON.stringify(res));
} catch(e: any) {
  console.log("❌ Error:", e?.response?.status ?? "", JSON.stringify(e?.response?.data ?? e?.message ?? "").slice(0, 300));
}
