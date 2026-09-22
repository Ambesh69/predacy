/**
 * testPoly1271.ts — Probe whether Polymarket CLOB API accepts POLY_1271 (signatureType=3) orders
 * where maker = vault contract address (not the relayer EOA).
 *
 * Tests two orders:
 *   1. CONTROL: signatureType=0 (EOA), maker=relayer EOA  → should work if API key is valid
 *   2. KEY TEST: signatureType=3 (POLY_1271), maker=vault → tells us if vault-as-maker is viable
 *
 * Run:  cd relayer && npx tsx scripts/testPoly1271.ts --live
 *
 * Required env: RELAYER_PRIVATE_KEY
 */

import "dotenv/config";
import axios from "axios";
import { buildPolyHmacSignature } from "@polymarket/clob-client/dist/signing/hmac.js";
import { ExchangeOrderBuilder } from "@polymarket/clob-client/dist/order-utils/exchange.order.builder.js";
import { generateOrderSalt } from "@polymarket/clob-client/dist/order-utils/utils.js";
import { orderToJson } from "@polymarket/clob-client/dist/utilities.js";
import { createL2Headers } from "@polymarket/clob-client/dist/headers/index.js";
import { privateKeyToAccount } from "viem/accounts";
import { createWalletClient, http } from "viem";
import { polygon } from "viem/chains";

// ── Config ────────────────────────────────────────────────────────────────────

const CLOB_API = "https://clob.polymarket.com";

// Polygon mainnet exchange addresses
const EXCHANGE     = "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E" as const; // standard CTFExchange
const NEG_RISK_EX  = "0xC5d563A36AE78145C45a50134d48A1215220f80a" as const; // negRisk exchange

const PK       = (process.env.RELAYER_PRIVATE_KEY ?? "") as `0x${string}`;
const API_KEY  = process.env.POLYMARKET_API_KEY        || "";
const API_SEC  = process.env.POLYMARKET_API_SECRET     || "";
const API_PASS = process.env.POLYMARKET_API_PASSPHRASE || "";

// Mainnet BatchVault v8 (must have code deployed for POLY_1271 isValidSignature check)
const VAULT  = (process.env.VAULT_ADDRESS ?? "0x44Ed1EA9b420d3B954b5779Eed6CED1deFd1cf21") as `0x${string}`;
const ZERO   = "0x0000000000000000000000000000000000000000" as `0x${string}`;

// Active Chelsea EPL YES market (negRisk market)
const TOKEN_ID = process.env.TEST_TOKEN_ID
  ?? "41583919731714354912849507182398941127545694257513505398713274521520484370640";

// BUY order: size=10 YES tokens at price=0.80
// ClobClient formula: makerAmount = size*price*1e6, takerAmount = size*1e6
const SIZE        = 10;   // YES tokens to buy
const PRICE       = 0.80; // USDC per YES token
const MAKER_AMOUNT = String(Math.round(SIZE * PRICE * 1e6));  // "8000000" (8 USDC)
const TAKER_AMOUNT = String(Math.round(SIZE * 1e6));          // "10000000" (10 YES tokens)

if (!PK || !API_KEY || !API_SEC || !API_PASS || process.argv[2] !== "--live") {
  throw new Error("Set CLOB credentials and RELAYER_PRIVATE_KEY, then pass --live to post an order");
}

const account = privateKeyToAccount(PK);
const walletClient = createWalletClient({
  account, chain: polygon, transport: http("https://polygon-rpc.com/"),
});
const creds = { key: API_KEY, secret: API_SEC, passphrase: API_PASS };

// ── Determine exchange address (negRisk or standard) ──────────────────────────

const negRiskRes = await axios.get(`${CLOB_API}/neg-risk?token_id=${TOKEN_ID}`).catch(() => null);
const isNegRisk  = negRiskRes?.data?.neg_risk === true;
const EXCHANGE_ADDR = isNegRisk ? NEG_RISK_EX : EXCHANGE;

console.log("Relayer EOA:", account.address);
console.log("Vault (maker for POLY_1271):", VAULT);
console.log("Token ID:", TOKEN_ID.slice(0, 16) + "…");
console.log("NegRisk market:", isNegRisk, "→ exchange:", EXCHANGE_ADDR);
console.log(`Order: BUY ${SIZE} YES tokens for ${(Number(MAKER_AMOUNT)/1e6).toFixed(2)} USDC`);
console.log();

// ── Build + submit order ──────────────────────────────────────────────────────

const DOMAIN_TYPED = {
  name: "Polymarket CTF Exchange", version: "1", chainId: 137,
  verifyingContract: EXCHANGE_ADDR,
} as const;

const ORDER_TYPES = {
  Order: [
    { name: "salt",          type: "uint256" },
    { name: "maker",         type: "address" },
    { name: "signer",        type: "address" },
    { name: "taker",         type: "address" },
    { name: "tokenId",       type: "uint256" },
    { name: "makerAmount",   type: "uint256" },
    { name: "takerAmount",   type: "uint256" },
    { name: "expiration",    type: "uint256" },
    { name: "nonce",         type: "uint256" },
    { name: "feeRateBps",    type: "uint256" },
    { name: "side",          type: "uint8"   },
    { name: "signatureType", type: "uint8"   },
  ],
} as const;

async function submitOrder(opts: {
  label:         string;
  maker:         `0x${string}`;
  signer:        `0x${string}`;
  signatureType: number;
}): Promise<boolean> {

  let salt: string;
  let signature: string;

  if (opts.signatureType === 0 && opts.signer === account.address) {
    // CONTROL path: use ExchangeOrderBuilder exactly as ClobClient does
    const builder = new ExchangeOrderBuilder(EXCHANGE_ADDR, 137, walletClient);
    const signed = await builder.buildSignedOrder({
      maker: opts.maker, signer: opts.signer, taker: ZERO, tokenId: TOKEN_ID,
      makerAmount: MAKER_AMOUNT, takerAmount: TAKER_AMOUNT,
      side: 0, feeRateBps: "0", nonce: "0", expiration: "0",
      signatureType: opts.signatureType,
    } as any);
    salt = signed.salt;
    signature = signed.signature!;
  } else {
    // POLY_1271 path: sign manually — ExchangeOrderBuilder rejects signer ≠ walletClient address
    salt = generateOrderSalt();
    signature = await walletClient.signTypedData({
      account,
      domain: DOMAIN_TYPED,
      types:  ORDER_TYPES,
      primaryType: "Order",
      message: {
        salt:          salt,
        maker:         opts.maker,
        signer:        opts.signer,
        taker:         ZERO,
        tokenId:       TOKEN_ID,
        makerAmount:   MAKER_AMOUNT,
        takerAmount:   TAKER_AMOUNT,
        expiration:    "0",
        nonce:         "0",
        feeRateBps:    "0",
        side:          0,
        signatureType: opts.signatureType,
      } as any,
    });
  }

  // Build JSON body using ClobClient's orderToJson format (deferExec first, side before expiration)
  const payload = {
    deferExec: false,
    order: {
      salt:          Number(BigInt(salt)),
      maker:         opts.maker,
      signer:        opts.signer,
      taker:         ZERO,
      tokenId:       TOKEN_ID,
      makerAmount:   MAKER_AMOUNT,
      takerAmount:   TAKER_AMOUNT,
      side:          "BUY",
      expiration:    "0",
      nonce:         "0",
      feeRateBps:    "0",
      signatureType: opts.signatureType,
      signature,
    },
    owner:     API_KEY,
    orderType: "GTC",
    postOnly:  false,
  };
  const body = JSON.stringify(payload);

  // Build L2 auth headers using ClobClient's function
  const l2Args = { method: "POST", requestPath: "/order", body };
  const headers = await createL2Headers(walletClient, creds, l2Args) as any;
  headers["Content-Type"]  = "application/json";
  headers["User-Agent"]    = "@polymarket/clob-client";
  headers["Accept"]        = "*/*";
  headers["Connection"]    = "keep-alive";

  console.log(`─── ${opts.label} ───`);
  console.log("    signatureType:", opts.signatureType,
    `(${opts.signatureType === 0 ? "EOA" : "POLY_1271"})`);
  console.log("    maker:", opts.maker);
  console.log("    exchange:", EXCHANGE_ADDR);

  try {
    const res = await axios.post(`${CLOB_API}/order`, body, { headers });
    console.log("    ✅ ACCEPTED —", res.status, JSON.stringify(res.data));
    return true;
  } catch (e: any) {
    const status = e?.response?.status;
    const data   = e?.response?.data;
    const errMsg: string = data?.error ?? "";
    // "not enough balance" means sig + auth both valid (relayer just has no USDC on mainnet)
    if (status === 400 && errMsg.includes("not enough balance")) {
      console.log("    ✅ SIGNATURE VALID — balance check passed API, rejected for: no USDC.");
      console.log("      (Expected on mainnet — relayer wallet has no USDC)");
      return true;
    }
    console.log("    ❌ REJECTED —", status, JSON.stringify(data));
    if (!e?.response) console.log("    Error:", e?.message ?? String(e));
    return false;
  }
}

// ── Run tests ─────────────────────────────────────────────────────────────────

const controlOk = await submitOrder({
  label:         "Test 1 CONTROL: signatureType=0 EOA, maker=relayer EOA",
  maker:         account.address,
  signer:        account.address,
  signatureType: 0,
});
console.log();

// Test 2a: signer = vault (on-chain POLY_1271 requirement: signer == maker)
const poly1271Ok = await submitOrder({
  label:         "Test 2a KEY TEST: signatureType=3, maker=vault, signer=vault",
  maker:         VAULT,
  signer:        VAULT,
  signatureType: 3,
});
console.log();

// Test 2b: signer = relayer EOA (API key holder) — API might accept this variant
await submitOrder({
  label:         "Test 2b KEY TEST: signatureType=3, maker=vault, signer=relayer EOA",
  maker:         VAULT,
  signer:        account.address,
  signatureType: 3,
});
console.log();

// ── Summary ───────────────────────────────────────────────────────────────────

console.log("═══════════════════════════════════════════════════════");
if (poly1271Ok) {
  console.log("  ✅ POLY_1271 IS viable. Proceed with v7.4 impl.");
  console.log("     Vault is CLOB maker, uses its own USDC.");
  console.log("     Zero relayer capital required!");
} else if (!controlOk) {
  console.log("  ⚠️  Control (EOA) also failed — check format or API key.");
} else {
  console.log("  ❌ POLY_1271 rejected by off-chain CLOB API.");
  console.log("     On-chain contract supports it; API does not.");
  console.log("     → Email builder@polymarket.com for operator/partnership.");
}
console.log("═══════════════════════════════════════════════════════");
