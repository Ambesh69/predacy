/**
 * Generates Polymarket CLOB L2 API credentials for the relayer wallet.
 *
 * Uses @polymarket/clob-client with a viem WalletClient (the library checks
 * for signTypedData function — ethers wallets don't work with newer versions).
 *
 * Run:
 *   cd relayer && npx tsx scripts/generateClobApiKey.ts
 *
 * Then paste the output into Railway env vars:
 *   POLYMARKET_API_KEY, POLYMARKET_API_SECRET, POLYMARKET_API_PASSPHRASE
 *
 * Required env vars: RELAYER_PRIVATE_KEY
 */

import "dotenv/config";
import { ClobClient } from "@polymarket/clob-client";
import { createWalletClient, http } from "viem";
import { polygon } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

const PK = (process.env.RELAYER_PRIVATE_KEY ?? "") as `0x${string}`;
if (!PK || PK === "0x") {
  console.error("Missing RELAYER_PRIVATE_KEY");
  process.exit(1);
}

const account = privateKeyToAccount(PK);
console.log(`Generating CLOB API key for wallet: ${account.address}\n`);

const walletClient = createWalletClient({
  account,
  chain: polygon,
  transport: http("https://polygon-rpc.com/"),
});

const client = new ClobClient("https://clob.polymarket.com", 137, walletClient);
// deriveApiKey retrieves existing key; createApiKey fails if one already exists
const creds = await client.deriveApiKey(0);

console.log("Success! Set these in Railway:\n");
console.log(`POLYMARKET_API_KEY=${creds.key}`);
console.log(`POLYMARKET_API_SECRET=${creds.secret}`);
console.log(`POLYMARKET_API_PASSPHRASE=${creds.passphrase}`);
console.log();
console.log("Note: Also confirm POLYMARKET_PROXY_WALLET is set to");
console.log("the proxy wallet shown at polymarket.com → Builder Settings → Address.");
