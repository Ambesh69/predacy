import "dotenv/config";
import { privateKeyToAccount } from "viem/accounts";
import { hashTypedData, recoverTypedDataAddress } from "viem";
import { ExchangeOrderBuilder } from "@polymarket/clob-client/dist/order-utils/exchange.order.builder.js";
import { createWalletClient, http } from "viem";
import { polygon } from "viem/chains";

const PK = (process.env.RELAYER_PRIVATE_KEY ?? "") as `0x${string}`;
const CTF_EXCHANGE = "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E" as const;
const ZERO = "0x0000000000000000000000000000000000000000" as `0x${string}`;
const TOKEN_ID = "41583919731714354912849507182398941127545694257513505398713274521520484370640";

const account = privateKeyToAccount(PK);
const walletClient = createWalletClient({ account, chain: polygon, transport: http() });

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

const SALT = 1741234567890n;  // Fixed salt for comparison

// Method 1: Manual (what testPoly1271.ts does)
for (const domainName of ["CTF Exchange", "Polymarket CTF Exchange"]) {
  const domain = { name: domainName, version: "1" as const, chainId: 137, verifyingContract: CTF_EXCHANGE };
  const msg = {
    salt: SALT, maker: account.address, signer: account.address, taker: ZERO,
    tokenId: BigInt(TOKEN_ID), makerAmount: 10_000_000n, takerAmount: 12_500_000n,
    expiration: 0n, nonce: 0n, feeRateBps: 0n, side: 0, signatureType: 0,
  } as const;
  const hash = hashTypedData({ domain, types: ORDER_TYPES, primaryType: "Order", message: msg });
  const sig = await account.signTypedData({ domain, types: ORDER_TYPES, primaryType: "Order", message: msg });
  const recovered = await recoverTypedDataAddress({ domain, types: ORDER_TYPES, primaryType: "Order", message: msg, signature: sig });
  console.log(`\nManual "${domainName}":`);
  console.log("  Hash:", hash);
  console.log("  Sig:", sig.slice(0, 20) + "...");
  console.log("  Recovered:", recovered);
  console.log("  Match:", recovered.toLowerCase() === account.address.toLowerCase());
}

// Method 2: ExchangeOrderBuilder (what clob-client does)
const builder = new ExchangeOrderBuilder(CTF_EXCHANGE, 137, walletClient);
const orderData = {
  maker: account.address, taker: "0x0000000000000000000000000000000000000000",
  tokenId: TOKEN_ID, makerAmount: "10000000", takerAmount: "12500000",
  side: 0, feeRateBps: "0", nonce: "0", expiration: "0", signatureType: 0,
};
const clobOrder = await builder.buildSignedOrder(orderData as any);
const clobTypedData = builder.buildOrderTypedData(clobOrder as any);
const clobHash = builder.buildOrderHash(clobTypedData);
console.log("\nExchangeOrderBuilder:");
console.log("  Domain name:", clobTypedData.domain.name);
console.log("  Salt type:", typeof clobOrder.salt, "value:", clobOrder.salt);
console.log("  Hash:", clobHash);
console.log("  Sig:", clobOrder.signature.slice(0, 20) + "...");
