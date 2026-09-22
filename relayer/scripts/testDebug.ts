import "dotenv/config";
import axios from "axios";
import { buildPolyHmacSignature } from "@polymarket/clob-client/dist/signing/hmac.js";
import { privateKeyToAccount } from "viem/accounts";

const PK       = (process.env.RELAYER_PRIVATE_KEY ?? "") as `0x${string}`;
const API_KEY  = process.env.POLYMARKET_API_KEY || "";
const API_SEC  = process.env.POLYMARKET_API_SECRET || "";
const API_PASS = process.env.POLYMARKET_API_PASSPHRASE || "";
if (!PK || !API_KEY || !API_SEC || !API_PASS || process.argv[2] !== "--live") {
  throw new Error("Set CLOB credentials and RELAYER_PRIVATE_KEY, then pass --live to post an order");
}
const CTF_EXCHANGE = "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E" as const;
const TOKEN_ID = "41583919731714354912849507182398941127545694257513505398713274521520484370640";
const ZERO   = "0x0000000000000000000000000000000000000000" as `0x${string}`;

const account = privateKeyToAccount(PK);

// Use EXACTLY the same approach as the clob-client:
// - "Polymarket CTF Exchange" domain
// - salt as STRING from Math.round(Math.random() * Date.now())
// - amounts as strings
const salt = Math.round(Math.random() * Date.now());  // string-friendly number

const DOMAIN = { name: "Polymarket CTF Exchange", version: "1" as const, chainId: 137, verifyingContract: CTF_EXCHANGE };
const ORDER_TYPES = {
  Order: [
    { name: "salt", type: "uint256" }, { name: "maker", type: "address" },
    { name: "signer", type: "address" }, { name: "taker", type: "address" },
    { name: "tokenId", type: "uint256" }, { name: "makerAmount", type: "uint256" },
    { name: "takerAmount", type: "uint256" }, { name: "expiration", type: "uint256" },
    { name: "nonce", type: "uint256" }, { name: "feeRateBps", type: "uint256" },
    { name: "side", type: "uint8" }, { name: "signatureType", type: "uint8" },
  ],
} as const;

// Use STRING values exactly as clob-client does
const msg = {
  salt:          `${salt}`,           // STRING
  maker:         account.address,
  signer:        account.address,
  taker:         ZERO,
  tokenId:       TOKEN_ID,            // STRING
  makerAmount:   "10000000",          // STRING
  takerAmount:   "12500000",          // STRING
  expiration:    "0",                 // STRING
  nonce:         "0",                 // STRING
  feeRateBps:    "0",                 // STRING
  side:          0,                   // NUMBER
  signatureType: 0,                   // NUMBER
};

const signature = await account.signTypedData({
  domain: DOMAIN, types: ORDER_TYPES, primaryType: "Order", message: msg as any,
});
console.log("Salt:", salt);
console.log("Sig:", signature.slice(0, 30) + "...");

// Build body in EXACT clob-client field order
const body = JSON.stringify({
  deferExec: false,
  order: {
    salt,                            // NUMBER (from parseInt of string)
    maker:         account.address,
    signer:        account.address,
    taker:         ZERO,
    tokenId:       TOKEN_ID,
    makerAmount:   "10000000",
    takerAmount:   "12500000",
    side:          "BUY",
    expiration:    "0",
    nonce:         "0",
    feeRateBps:    "0",
    signatureType: 0,
    signature,
  },
  owner:     API_KEY,
  orderType: "GTC",
  postOnly:  false,
});

console.log("Body:", body.slice(0, 200));

const ts  = Math.floor(Date.now() / 1000);
const sig = await buildPolyHmacSignature(API_SEC, ts, "POST", "/order", body);

try {
  const res = await axios.post("https://clob.polymarket.com/order", body, {
    headers: {
      "POLY_API_KEY": API_KEY, "POLY_SIGNATURE": sig, "POLY_TIMESTAMP": `${ts}`,
      "POLY_PASSPHRASE": API_PASS, "POLY_ADDRESS": account.address, "Content-Type": "application/json",
    },
  });
  console.log("✅ ACCEPTED:", res.status, JSON.stringify(res.data));
} catch(e: any) {
  console.log("❌ REJECTED:", e?.response?.status, JSON.stringify(e?.response?.data));
}
