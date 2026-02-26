import "dotenv/config";
import { BatchProcessor } from "./batchProcessor.js";

/**
 * Predacy Relayer
 *
 * Lifecycle:
 *  - Opens a new batch every BATCH_WINDOW seconds
 *  - Accepts order details via an HTTP API (POST /order)
 *  - Processes (closes + settles) each batch after it closes
 *
 * Environment variables (see .env.example):
 *   RPC_URL            - Polygon RPC endpoint
 *   VAULT_ADDRESS      - Deployed BatchVault contract address
 *   RELAYER_PRIVATE_KEY - Relayer's wallet private key
 *   POLYMARKET_API_KEY
 *   POLYMARKET_API_SECRET
 *   POLYMARKET_API_PASSPHRASE
 *   MARKET_ID          - Polymarket condition ID to trade (bytes32 hex)
 *   BATCH_WINDOW_MS    - Batch duration in ms (default: 30000)
 */

const config = {
  rpcUrl: process.env.RPC_URL ?? "https://polygon-rpc.com",
  vaultAddress: (process.env.VAULT_ADDRESS ?? "0x0000000000000000000000000000000000000000") as `0x${string}`,
  relayerPrivateKey: (process.env.RELAYER_PRIVATE_KEY ?? "") as `0x${string}`,
  polymarket: {
    apiKey: process.env.POLYMARKET_API_KEY ?? "",
    apiSecret: process.env.POLYMARKET_API_SECRET ?? "",
    apiPassphrase: process.env.POLYMARKET_API_PASSPHRASE ?? "",
  },
  batchWindowMs: parseInt(process.env.BATCH_WINDOW_MS ?? "30000"),
};

const MARKET_ID = (process.env.MARKET_ID ?? "0x" + "0".repeat(64)) as `0x${string}`;

const processor = new BatchProcessor(config);

async function runBatchCycle() {
  try {
    const batchId = await processor.openBatch(MARKET_ID);
    console.log(`[Relayer] Batch ${batchId} open — accepting orders for ${config.batchWindowMs / 1000}s`);

    // Wait for batch window to close
    await new Promise((resolve) => setTimeout(resolve, config.batchWindowMs));

    await processor.processBatch(batchId);
  } catch (err) {
    console.error("[Relayer] Batch cycle error:", err);
  }
}

console.log("[Relayer] Starting Predacy batch relayer...");
console.log(`[Relayer] Vault: ${config.vaultAddress}`);
console.log(`[Relayer] Market: ${MARKET_ID}`);
console.log(`[Relayer] Batch window: ${config.batchWindowMs / 1000}s`);

// Run continuously
(async () => {
  while (true) {
    await runBatchCycle();
  }
})();
