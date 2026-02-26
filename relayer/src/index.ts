import "dotenv/config";
import { createServer } from "node:http";
import { createPublicClient, http } from "viem";
import { polygonAmoy } from "viem/chains";
import { BatchProcessor, BATCH_VAULT_ABI } from "./batchProcessor.js";

// ── Environment ───────────────────────────────────────────────────────────────
const required = ["VAULT_ADDRESS", "RELAYER_PRIVATE_KEY"];
for (const v of required) {
  if (!process.env[v]) {
    console.error(`[Relayer] Missing required env var: ${v}`);
    process.exit(1);
  }
}

const config = {
  rpcUrl:            process.env.RPC_URL ?? "https://rpc-amoy.polygon.technology/",
  vaultAddress:      process.env.VAULT_ADDRESS as `0x${string}`,
  relayerPrivateKey: process.env.RELAYER_PRIVATE_KEY as `0x${string}`,
  polymarket: {
    apiKey:        process.env.POLYMARKET_API_KEY        ?? "",
    apiSecret:     process.env.POLYMARKET_API_SECRET     ?? "",
    apiPassphrase: process.env.POLYMARKET_API_PASSPHRASE ?? "",
  },
  batchWindowMs: parseInt(process.env.BATCH_WINDOW_MS ?? "30000"),
};

const MARKET_ID = (process.env.MARKET_ID ?? "0x" + "0".repeat(64)) as `0x${string}`;
const PORT      = parseInt(process.env.PORT ?? "3001");

// ── BatchProcessor ────────────────────────────────────────────────────────────
const processor = new BatchProcessor(config);

// ── HTTP server ───────────────────────────────────────────────────────────────
// POST /order  — trader sends off-chain order details after committing on-chain
// GET  /health — liveness check
let currentBatchId: bigint | null = null;

const server = createServer((req, res) => {
  const send = (status: number, body: object) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };

  // ── GET /health ─────────────────────────────────────────────────────────────
  if (req.method === "GET" && req.url === "/health") {
    send(200, {
      ok:            true,
      vault:         config.vaultAddress,
      market:        MARKET_ID,
      currentBatch:  currentBatchId?.toString() ?? null,
      batchWindowMs: config.batchWindowMs,
    });
    return;
  }

  // ── POST /order ─────────────────────────────────────────────────────────────
  // Body: { batchId, trader, isBuy, amount, limitPrice, salt }
  // All numeric fields should be passed as decimal strings (bigint-safe).
  if (req.method === "POST" && req.url === "/order") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        const data = JSON.parse(body);
        const { batchId, trader, isBuy, amount, limitPrice, salt } = data;

        if (
          batchId    === undefined ||
          !trader    ||
          isBuy      === undefined ||
          !amount    ||
          !limitPrice||
          !salt
        ) {
          send(400, { error: "Missing fields: batchId, trader, isBuy, amount, limitPrice, salt" });
          return;
        }

        processor.receiveOrder(BigInt(batchId), {
          trader:     trader     as `0x${string}`,
          isBuy:      Boolean(isBuy),
          amount:     BigInt(amount),
          limitPrice: BigInt(limitPrice),
          salt:       salt       as `0x${string}`,
        });

        send(200, {
          ok:      true,
          batchId: batchId.toString(),
          orders:  processor.orderCount(BigInt(batchId)),
        });
      } catch (e: any) {
        send(400, { error: e.message });
      }
    });
    return;
  }

  send(404, { error: "Not found" });
});

server.listen(PORT, () => {
  console.log(`[Relayer] HTTP server on :${PORT}`);
  console.log(`[Relayer]   POST /order  — submit off-chain order details`);
  console.log(`[Relayer]   GET  /health — liveness + current batch info`);
});

// ── Public client for event watching (polls every 4 s over HTTP) ─────────────
const publicClient = createPublicClient({
  chain: polygonAmoy,
  transport: http(config.rpcUrl, { retryCount: 3 }),
  pollingInterval: 4_000,
});

// ── State guards ──────────────────────────────────────────────────────────────
let processingBatch = false;
let openingBatch    = false;

// ── Watch BatchClosed → processBatch() ───────────────────────────────────────
publicClient.watchContractEvent({
  address:   config.vaultAddress,
  abi:       BATCH_VAULT_ABI,
  eventName: "BatchClosed",
  onLogs: async (logs) => {
    for (const log of logs) {
      const batchId = log.args.batchId as bigint;

      if (processingBatch) {
        console.log(`[Relayer] BatchClosed ${batchId} — already settling, queued`);
        continue;
      }

      processingBatch = true;
      console.log(`[Relayer] BatchClosed ${batchId} (${log.args.commitmentCount} orders) — settling`);

      try {
        await processor.processBatch(batchId);
      } catch (err) {
        console.error(`[Relayer] processBatch ${batchId} failed:`, err);
      } finally {
        processingBatch = false;
      }
    }
  },
  onError: (err) => console.error("[Relayer] BatchClosed watch error:", err),
});

// ── Watch BatchSettled → openBatch() (keep the cycle going) ──────────────────
publicClient.watchContractEvent({
  address:   config.vaultAddress,
  abi:       BATCH_VAULT_ABI,
  eventName: "BatchSettled",
  onLogs: async (logs) => {
    for (const log of logs) {
      console.log(`[Relayer] BatchSettled ${log.args.batchId} — opening next batch`);

      if (openingBatch) continue;
      openingBatch = true;

      try {
        currentBatchId = await processor.openBatch(MARKET_ID);
      } catch (err) {
        console.error("[Relayer] openBatch after settle failed:", err);
        // Retry once after 5 s
        await new Promise((r) => setTimeout(r, 5_000));
        try {
          currentBatchId = await processor.openBatch(MARKET_ID);
        } catch (retryErr) {
          console.error("[Relayer] openBatch retry failed:", retryErr);
        }
      } finally {
        openingBatch = false;
      }
    }
  },
  onError: (err) => console.error("[Relayer] BatchSettled watch error:", err),
});

// ── Startup ───────────────────────────────────────────────────────────────────
console.log("[Relayer] Starting Predacy relayer on Polygon Amoy...");
console.log(`[Relayer] Vault:   ${config.vaultAddress}`);
console.log(`[Relayer] Market:  ${MARKET_ID}`);
console.log(`[Relayer] Window:  ${config.batchWindowMs / 1000}s`);

(async () => {
  try {
    currentBatchId = await processor.openBatch(MARKET_ID);
    console.log(`[Relayer] First batch ${currentBatchId} is open — accepting orders`);
  } catch (err: any) {
    // Contract may already have an open batch from a previous run
    console.warn(`[Relayer] openBatch on startup failed: ${err.message}`);
    console.warn("[Relayer] Continuing — will pick up existing batch from chain events");
  }
})();
