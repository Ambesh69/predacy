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

if (!PK) { console.error("Set RELAYER_PRIVATE_KEY"); process.exit(1); }

const account = privateKeyToAccount(PK);
console.log("EOA:", account.address);

const walletClient = createWalletClient({ account, chain: polygon, transport: http("https://polygon-rpc.com") });

const creds = API_KEY ? { key: API_KEY, secret: API_SEC, passphrase: API_PASS } : undefined;
const client = new ClobClient("https://clob.polymarket.com", 137, walletClient, creds);

if (!creds) {
  console.log("No API creds — deriving...");
  const derived = await client.deriveApiKey();
  console.log("Derived key:", derived.key);
  process.exit(0);
}

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
