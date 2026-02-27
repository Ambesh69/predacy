import "dotenv/config";
import { createServer } from "node:http";
import { createPublicClient, http, parseAbiItem } from "viem";
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
  redisUrl:          process.env.REDIS_URL,   // Optional — in-memory fallback if not set
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

const CORS_HEADERS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const server = createServer((req, res) => {
  const send = (status: number, body: object) => {
    res.writeHead(status, { "Content-Type": "application/json", ...CORS_HEADERS });
    res.end(JSON.stringify(body));
  };

  // OPTIONS preflight (browser sends this before every cross-origin POST)
  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

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

  // POST /order
  //
  // Privacy path (recommended) — include `signature`, `commitment`, `nonce`, `deadline`:
  //   { batchId, signer, isBuy, amount, limitPrice, salt,
  //     commitment, signature, nonce, deadline }
  //   → relayer calls commitOrderFor() on-chain; only relayer address visible
  //
  // Legacy path — omit `signature`:
  //   { batchId, trader, isBuy, amount, limitPrice, salt }
  //   → trader already committed on-chain; relayer just stores order details
  if (req.method === "POST" && req.url === "/order") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      try {
        const data = JSON.parse(body);
        const { batchId, isBuy, amount, limitPrice, salt } = data;

        if (batchId === undefined || isBuy === undefined || !amount || !limitPrice || !salt) {
          send(400, { error: "Missing fields: batchId, isBuy, amount, limitPrice, salt" });
          return;
        }
        if (!processor) {
          send(503, { error: "Relayer not configured — set VAULT_ADDRESS and RELAYER_PRIVATE_KEY" });
          return;
        }

        const order = {
          trader:     (data.signer ?? data.trader) as `0x${string}`,
          isBuy:      Boolean(isBuy),
          amount:     BigInt(amount),
          limitPrice: BigInt(limitPrice),
          salt:       salt as `0x${string}`,
        };

        if (data.signature) {
          // ── Privacy path: relay commitment on-chain ────────────────────
          const { signer, commitment, nonce, deadline } = data;
          if (!signer || !commitment || nonce === undefined || !deadline) {
            send(400, { error: "Privacy path requires: signer, commitment, nonce, deadline, signature" });
            return;
          }
          if (data.isSell) {
            // Sell order: YES token deposit — calls commitSellOrderFor
            await processor.submitSellCommitmentFor(
              BigInt(batchId),
              order,
              commitment        as `0x${string}`,
              signer            as `0x${string}`,
              BigInt(nonce),
              BigInt(deadline),
              data.signature    as `0x${string}`,
            );
          } else {
            // Buy order: USDC deposit — calls commitOrderFor
            await processor.submitCommitmentFor(
              BigInt(batchId),
              order,
              commitment        as `0x${string}`,
              signer            as `0x${string}`,
              BigInt(nonce),
              BigInt(deadline),
              data.signature    as `0x${string}`,
            );
          }
        } else {
          // ── Legacy path: trader already committed on-chain ─────────────
          if (!data.trader) {
            send(400, { error: "Legacy path requires: trader" });
            return;
          }
          await processor.receiveOrder(BigInt(batchId), order);
        }

        const orders = await processor.orderCount(BigInt(batchId));
        send(200, { ok: true, batchId: batchId.toString(), orders });
      } catch (e: any) {
        send(400, { error: e.message });
      }
    });
    return;
  }

  // POST /admin/force-advance
  // Force-opens the next batch immediately, abandoning any stuck SETTLING batch.
  // openBatch() only blocks for OPEN batches (contract check), so this works even
  // when the current batch is at SETTLING. Useful when processBatch is failing
  // permanently (UNRESOLVABLE) and you don't want to wait for the 3-attempt auto-skip.
  if (req.method === "POST" && req.url === "/admin/force-advance") {
    if (!processor) {
      send(503, { error: "Relayer not configured" });
      return;
    }
    (async () => {
      try {
        const prevBatchId = currentBatchId;
        const newBatchId  = await processor!.openBatch(MARKET_ID);
        currentBatchId    = newBatchId;
        console.log(`[Relayer] /admin/force-advance: opened batch ${newBatchId} (prev: ${prevBatchId})`);
        send(200, {
          ok:          true,
          prevBatchId: prevBatchId?.toString() ?? null,
          newBatchId:  newBatchId.toString(),
        });
      } catch (e: any) {
        // 409 = batch is still OPEN (can't force-advance a running batch)
        const status = e.message?.includes("batch already open") ? 409 : 500;
        send(status, { error: e.message });
      }
    })();
    return;
  }

  send(404, { error: "Not found" });
});

server.listen(PORT, () => {
  console.log(`[Relayer] HTTP server on :${PORT}`);
  console.log(`[Relayer]   GET  /health        — liveness check`);
  console.log(`[Relayer]   POST /order         — submit off-chain order details`);
  console.log(`[Relayer]   POST /admin/force-advance — skip stuck SETTLING batch`);
});

// ── Startup log ───────────────────────────────────────────────────────────────
console.log("[Relayer] Starting Predacy relayer on Polygon Amoy...");
console.log(`[Relayer] Vault:   ${config.vaultAddress}`);
console.log(`[Relayer] Market:  ${MARKET_ID}`);
console.log(`[Relayer] Window:  ${config.batchWindowMs / 1000}s`);

if (missingVars.length > 0) {
  console.error(`[Relayer] ⚠ Missing env vars: ${missingVars.join(", ")} — add them in Railway Variables tab`);
}

// ── Event polling + batch lifecycle (only when fully configured) ──────────────
// Uses getLogs polling instead of watchContractEvent — the public Amoy RPC is
// load-balanced, so eth_newFilter / eth_getFilterChanges fails with "filter not
// found" when requests hit different backend servers. getLogs is stateless and
// works with any RPC.
if (processor) {
  const publicClient = createPublicClient({
    chain,
    transport: http(config.rpcUrl, { retryCount: 3 }),
  });

  let processingBatch = false;
  let openingBatch    = false;
  let closingBatch    = false;

  // Track consecutive settlement failures per batch.
  // After 3 failures (all UNRESOLVABLE — contract would always revert) we
  // force-open the next batch so the lifecycle isn't blocked forever.
  const settleFailures = new Map<string, number>();

  const onSettleFail = async (batchId: bigint, err: unknown) => {
    const key = batchId.toString();
    const n   = (settleFailures.get(key) ?? 0) + 1;
    settleFailures.set(key, n);
    console.error(`[Relayer] processBatch ${batchId} failed (attempt ${n}/3):`, (err as any)?.message ?? err);

    if (n >= 3) {
      console.warn(`[Relayer] Batch ${batchId} UNRESOLVABLE after ${n} attempts — force-opening next batch`);
      settleFailures.delete(key);
      if (!openingBatch) {
        openingBatch = true;
        try {
          currentBatchId = await processor!.openBatch(MARKET_ID);
          console.log(`[Relayer] Force-opened batch ${currentBatchId} (skipped unresolvable ${batchId})`);
        } catch (e: any) {
          if (e.message?.includes("batch already open")) {
            currentBatchId = await publicClient.readContract({
              address: config.vaultAddress,
              abi:     BATCH_VAULT_ABI,
              functionName: "currentBatchId",
            }) as bigint;
            console.log(`[Relayer] Next batch already open: ${currentBatchId}`);
          } else {
            console.error("[Relayer] openBatch (force-skip) failed:", e);
          }
        } finally { openingBatch = false; }
      }
    }
  };

  // Event ABI items for getLogs
  const BATCH_CLOSED_EVENT = parseAbiItem(
    "event BatchClosed(uint256 indexed batchId, uint256 commitmentCount)",
  );
  const BATCH_SETTLED_EVENT = parseAbiItem(
    "event BatchSettled(uint256 indexed batchId, uint256 clearingPrice, uint256 totalBuyVolume, uint256 totalSellVolume, uint256 netBuyAmount, uint256 yesTokensReceived)",
  );

  // fromBlock advances each poll — initialised to current head before polling starts
  let fromBlock = 0n;

  const poll = async () => {
    try {
      const toBlock = await publicClient.getBlockNumber();
      if (toBlock < fromBlock) return; // no new blocks since last poll

      const [closedLogs, settledLogs] = await Promise.all([
        publicClient.getLogs({ address: config.vaultAddress, event: BATCH_CLOSED_EVENT,  fromBlock, toBlock }),
        publicClient.getLogs({ address: config.vaultAddress, event: BATCH_SETTLED_EVENT, fromBlock, toBlock }),
      ]);

      fromBlock = toBlock + 1n; // advance cursor past the range we just scanned

      // Batch lifecycle management: read current batch status once per poll tick
      if (currentBatchId !== null && !closingBatch && !processingBatch) {
        try {
          const batchInfo = await publicClient.readContract({
            address: config.vaultAddress,
            abi:     BATCH_VAULT_ABI,
            functionName: "getBatch",
            args:    [currentBatchId],
          }) as { status: number; openedAt: bigint; commitmentCount: bigint };

          const OPEN = 0, SETTLING = 1, SETTLED = 2;

          if (batchInfo.status === OPEN) {
            // Auto-close once the window has elapsed (with or without orders).
            // Closing an empty batch costs ~0.004 MATIC but keeps the timer live.
            const nowSec    = Math.floor(Date.now() / 1000);
            const windowSec = config.batchWindowMs / 1000;
            if (nowSec >= Number(batchInfo.openedAt) + windowSec) {
              closingBatch = true;
              console.log(`[Relayer] Batch ${currentBatchId} window expired (${batchInfo.commitmentCount} orders) — closing`);
              try   { await processor.closeBatch(); }
              catch (err) { console.error("[Relayer] closeBatch failed:", err); }
              finally { closingBatch = false; }
            }
          } else if (batchInfo.status === SETTLING) {
            // Batch closed but not yet settled — process it (handles relayer restarts
            // and the case where processBatch() exited early on a previous run)
            processingBatch = true;
            console.log(`[Relayer] Batch ${currentBatchId} is SETTLING — processing`);
            try {
              await processor.processBatch(currentBatchId);
              settleFailures.delete(currentBatchId.toString()); // clear on success
            } catch (err) {
              await onSettleFail(currentBatchId, err);
            } finally { processingBatch = false; }
          } else if (batchInfo.status === SETTLED && !openingBatch) {
            // Batch is fully settled but the BatchSettled event was missed because
            // fromBlock advanced past it while processBatch was awaiting the tx receipt
            // (setInterval fires concurrent poll ticks during the ~20-30s wait).
            // Directly open the next batch here instead of relying on the event.
            openingBatch = true;
            console.log(`[Relayer] Batch ${currentBatchId} SETTLED (event missed) — opening next batch`);
            try {
              currentBatchId = await processor.openBatch(MARKET_ID);
            } catch (err: any) {
              if (err.message?.includes("batch already open")) {
                currentBatchId = await publicClient.readContract({
                  address: config.vaultAddress,
                  abi:     BATCH_VAULT_ABI,
                  functionName: "currentBatchId",
                }) as bigint;
                console.log(`[Relayer] Next batch already open: ${currentBatchId}`);
              } else {
                console.error("[Relayer] openBatch (post-settle recovery) failed:", err);
              }
            } finally { openingBatch = false; }
          }
        } catch { /* RPC hiccup — retry next poll */ }
      }

      // BatchClosed → settle
      for (const log of closedLogs) {
        const batchId = log.args.batchId as bigint;
        if (processingBatch) { console.log(`[Relayer] BatchClosed ${batchId} — already settling, skipping`); continue; }
        processingBatch = true;
        console.log(`[Relayer] BatchClosed ${batchId} (${log.args.commitmentCount} orders) — settling`);
        try {
          await processor.processBatch(batchId);
          settleFailures.delete(batchId.toString()); // clear on success
        } catch (err) {
          await onSettleFail(batchId, err);
        } finally { processingBatch = false; }
      }

      // BatchSettled → open next batch
      for (const log of settledLogs) {
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
    } catch (err) {
      console.error("[Relayer] poll error:", err);
      // Don't advance fromBlock on error — retry the same range next tick
    }
  };

  // Startup: set fromBlock, open first batch (or recover existing), then begin polling loop
  (async () => {
    try {
      fromBlock      = await publicClient.getBlockNumber();
      currentBatchId = await processor.openBatch(MARKET_ID);
      console.log(`[Relayer] First batch ${currentBatchId} is open — accepting orders`);
    } catch (err: any) {
      if (err.message?.includes("batch already open")) {
        // A batch was already open (e.g. relayer restarted mid-window) — read it from chain
        try {
          currentBatchId = await publicClient.readContract({
            address: config.vaultAddress,
            abi:     BATCH_VAULT_ABI,
            functionName: "currentBatchId",
          }) as bigint;
          console.log(`[Relayer] Recovered existing batch ${currentBatchId} — accepting orders`);
        } catch (e: any) {
          console.warn(`[Relayer] Could not read currentBatchId: ${e.message}`);
        }
      } else {
        console.warn(`[Relayer] openBatch on startup failed: ${err.message}`);
        console.warn("[Relayer] Continuing — will pick up existing batch from chain events");
      }
      // Ensure fromBlock is set even when openBatch failed
      if (fromBlock === 0n) {
        try { fromBlock = await publicClient.getBlockNumber(); } catch { fromBlock = 0n; }
      }
    }
    setInterval(poll, 5_000);
    console.log("[Relayer] Polling for BatchClosed / BatchSettled every 5 s");
  })();
}
