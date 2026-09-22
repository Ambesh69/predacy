/**
 * Use @polymarket/clob-client directly to sign + submit a control order.
 * This tests the exact format the library uses.
 */
import "dotenv/config";
import axios from "axios";
import { buildPolyHmacSignature } from "@polymarket/clob-client/dist/signing/hmac.js";
import { orderToJson } from "@polymarket/clob-client/dist/utilities.js";
import { ExchangeOrderBuilder } from "@polymarket/clob-client/dist/order-utils/exchange.order.builder.js";
import { privateKeyToAccount } from "viem/accounts";
import { createWalletClient, http } from "viem";
import { polygon } from "viem/chains";

const CLOB_API = "https://clob.polymarket.com";
const CTF_EXCHANGE = "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E";

const PK       = (process.env.RELAYER_PRIVATE_KEY ?? "") as `0x${string}`;
const API_KEY  = process.env.POLYMARKET_API_KEY        || "";
const API_SEC  = process.env.POLYMARKET_API_SECRET     || "";
const API_PASS = process.env.POLYMARKET_API_PASSPHRASE || "";
if (!PK || !API_KEY || !API_SEC || !API_PASS || process.argv[2] !== "--live") {
  throw new Error("Set CLOB credentials and RELAYER_PRIVATE_KEY, then pass --live to post an order");
}

const TOKEN_ID = "41583919731714354912849507182398941127545694257513505398713274521520484370640";

const account = privateKeyToAccount(PK);
console.log("Relayer EOA:", account.address);

// Use clob-client's walletClient signer
const walletClient = createWalletClient({ account, chain: polygon, transport: http() });

// Build signed order using clob-client's ExchangeOrderBuilder
const builder = new ExchangeOrderBuilder(CTF_EXCHANGE, 137, walletClient);
const orderData = {
  maker: account.address,
  taker: "0x0000000000000000000000000000000000000000",
  tokenId: TOKEN_ID,
  makerAmount: "10000000",  // 10 USDC
  takerAmount: "12500000",  // ~12.5 YES
  side: 0,                  // BUY
  feeRateBps: "0",
  nonce: "0",
  expiration: "0",
  signatureType: 0,         // EOA
};

console.log("Building signed order via clob-client ExchangeOrderBuilder...");
const signedOrder = await builder.buildSignedOrder(orderData as any);
console.log("Signed order salt:", signedOrder.salt);
console.log("Signature:", signedOrder.signature.slice(0, 20) + "...");

const payload = orderToJson(signedOrder as any, API_KEY, "GTC", false, undefined);
console.log("Payload:", JSON.stringify(payload).slice(0, 200));

const body = JSON.stringify(payload);
const ts  = Math.floor(Date.now() / 1000);
const sig = await buildPolyHmacSignature(API_SEC, ts, "POST", "/order", body);

try {
  const res = await axios.post(`${CLOB_API}/order`, body, {
    headers: {
      "POLY_API_KEY":    API_KEY,
      "POLY_SIGNATURE":  sig,
      "POLY_TIMESTAMP":  `${ts}`,
      "POLY_PASSPHRASE": API_PASS,
      "POLY_ADDRESS":    account.address,
      "Content-Type":    "application/json",
    },
  });
  console.log("\n✅ ACCEPTED:", res.status, JSON.stringify(res.data));
} catch(e: any) {
  console.log("\n❌ REJECTED:", e?.response?.status, JSON.stringify(e?.response?.data));
  if (!e?.response) console.log("Error:", e?.message);
}
