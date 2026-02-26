import "dotenv/config";
import { createServer } from "node:http";
import { createPublicClient, http } from "viem";
import { polygon, polygonAmoy } from "viem/chains";
import { BatchProcessor, BATCH_VAULT_ABI } from "./batchProcessor.js";

// ── Environment ───────────────────────────────────────────────────────────────
// Check for required vars up-front but don't exit — the HTTP server always
// starts so Railway's healthcheck always gets a response.
const missingVars = ["VAULT_ADDRESS", "RELAYER_PRIVATE_KEY"].filter((v) => !process.env[v]);

// CHAIN_ID: 137 = Polygon mainnet, 80002 = Polygon Amoy (default)
const chainId = parseInt(process.env.CHAIN_ID ?? "80002");
const chain   = chainId === polygon.id ? polygon : polygonAmoy;

const config = {
  rpcUrl:            process.env.RPC_URL ?? (chainId === polygon.id
    ? "https://polygon-rpc.com/"
    : "https://rpc-amoy.polygon.technology/"),
  chainId,
  vaultAddress:      (process.env.VAULT_ADDRESS      ?? "0x0000000000000000000000000000000000000000") as `0x${string}`,
  relayerPrivateKey: (process.env.RELAYER_PRIVATE_KEY ?? "0x0000000000000000000000000000000000000000000000000000000000000001") as `0x${string}`,
  polymarket: {
    apiKey:        process.env.POLYMARKET_API_KEY        ?? "",
    apiSecret:     process.env.POLYMARKET_API_SECRET     ?? "",
    apiPassphrase: process.env.POLYMARKET_API_PASSPHRASE ?? "",
  },
  batchWindowMs: parseInt(process.env.BATCH_WINDOW_MS ?? "30000"),
};

const MARKET_ID = (process.env.MARKET_ID ?? "0x" + "0".repeat(64)) as `0x${string}`;
const PORT      = parseInt(process.env.PORT ?? "3001");

// Only instantiate BatchProcessor when fully configured (private key required)
const processor = missingVars.length === 0 ? new BatchProcessor(config) : null;

// ── HTTP server ───────────────────────────────────────────────────────────────
// Always starts — healthcheck responds even when env vars are missing.
let currentBatchId: bigint | null = null;

const server = createServer((req, res) => {
  const send = (status: number, body: object) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };

  // GET /health
  if (req.method === "GET" && req.url === "/health") {
    send(missingVars.length === 0 ? 200 : 503, {
      ok:           missingVars.length === 0,
      missing:      missingVars,
      vault:        config.vaultAddress,
      market:       MARKET_ID,
      currentBatch: currentBatchId?.toString() ?? null,
    });
    return;
  }

  // POST /order — { batchId, trader, isBuy, amount, limitPrice, salt }
  if (req.method === "POST" && req.url === "/order") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        const data = JSON.parse(body);
        const { batchId, trader, isBuy, amount, limitPrice, salt } = data;

        if (batchId === undefined || !trader || isBuy === undefined || !amount || !limitPrice || !salt) {
          send(400, { error: "Missing fields: batchId, trader, isBuy, amount, limitPrice, salt" });
          return;
        }
        if (!processor) {
          send(503, { error: "Relayer not configured — set VAULT_ADDRESS and RELAYER_PRIVATE_KEY" });
          return;
        }

        processor.receiveOrder(BigInt(batchId), {
          trader:     trader     as `0x${string}`,
          isBuy:      Boolean(isBuy),
          amount:     BigInt(amount),
          limitPrice: BigInt(limitPrice),
          salt:       salt       as `0x${string}`,
        });

        send(200, { ok: true, batchId: batchId.toString(), orders: processor.orderCount(BigInt(batchId)) });
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
  console.log(`[Relayer]   GET  /health — liveness check`);
  console.log(`[Relayer]   POST /order  — submit off-chain order details`);
});

// ── Startup log ───────────────────────────────────────────────────────────────
console.log("[Relayer] Starting Predacy relayer on Polygon Amoy...");
console.log(`[Relayer] Vault:   ${config.vaultAddress}`);
console.log(`[Relayer] Market:  ${MARKET_ID}`);
console.log(`[Relayer] Window:  ${config.batchWindowMs / 1000}s`);

if (missingVars.length > 0) {
  console.error(`[Relayer] ⚠ Missing env vars: ${missingVars.join(", ")} — add them in Railway Variables tab`);
}

// ── Event watching + batch lifecycle (only when fully configured) ─────────────
if (processor) {
  const publicClient = createPublicClient({
    chain,
    transport: http(config.rpcUrl, { retryCount: 3 }),
    pollingInterval: 4_000,
  });

  let processingBatch = false;
  let openingBatch    = false;

  // BatchClosed → settle
  publicClient.watchContractEvent({
    address:   config.vaultAddress,
    abi:       BATCH_VAULT_ABI,
    eventName: "BatchClosed",
    onLogs: async (logs) => {
      for (const log of logs) {
        const batchId = log.args.batchId as bigint;
        if (processingBatch) { console.log(`[Relayer] BatchClosed ${batchId} — already settling`); continue; }
        processingBatch = true;
        console.log(`[Relayer] BatchClosed ${batchId} (${log.args.commitmentCount} orders) — settling`);
        try   { await processor.processBatch(batchId); }
        catch (err) { console.error(`[Relayer] processBatch ${batchId} failed:`, err); }
        finally { processingBatch = false; }
      }
    },
    onError: (err) => console.error("[Relayer] BatchClosed watch error:", err),
  });

  // BatchSettled → open next batch
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
          console.error("[Relayer] openBatch failed:", err);
          await new Promise((r) => setTimeout(r, 5_000));
          try   { currentBatchId = await processor.openBatch(MARKET_ID); }
          catch (e) { console.error("[Relayer] openBatch retry failed:", e); }
        } finally { openingBatch = false; }
      }
    },
    onError: (err) => console.error("[Relayer] BatchSettled watch error:", err),
  });

  // Open first batch on startup
  (async () => {
    try {
      currentBatchId = await processor.openBatch(MARKET_ID);
      console.log(`[Relayer] First batch ${currentBatchId} is open — accepting orders`);
    } catch (err: any) {
      console.warn(`[Relayer] openBatch on startup failed: ${err.message}`);
      console.warn("[Relayer] Continuing — will pick up existing batch from chain events");
    }
  })();
}
