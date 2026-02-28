import "dotenv/config";
import { createServer } from "node:http";
import { createPublicClient, http, parseAbiItem } from "viem";
import { polygon, polygonAmoy } from "viem/chains";
import { BatchProcessor, BATCH_VAULT_ABI, type RelayerConfig } from "./batchProcessor.js";

// ── Environment ───────────────────────────────────────────────────────────────
const missingVars = ["VAULT_ADDRESS", "RELAYER_PRIVATE_KEY"].filter((v) => !process.env[v]);

// CHAIN_ID: 137 = Polygon mainnet, 80002 = Polygon Amoy (default)
const chainId = parseInt(process.env.CHAIN_ID ?? "80002");
const chain   = chainId === polygon.id ? polygon : polygonAmoy;

const baseConfig = {
  rpcUrl:            process.env.RPC_URL ?? (chainId === polygon.id
    ? "https://polygon-rpc.com/"
    : "https://rpc-amoy.polygon.technology/"),
  chainId,
  vaultAddress:      (process.env.VAULT_ADDRESS      ?? "0x0000000000000000000000000000000000000000") as `0x${string}`,
  relayerPrivateKey: (process.env.RELAYER_PRIVATE_KEY ?? "0x0000000000000000000000000000000000000000000000000000000000000001") as `0x${string}`,
  redisUrl:          process.env.REDIS_URL,
  polymarket: {
    apiKey:        process.env.POLYMARKET_API_KEY        ?? "",
    apiSecret:     process.env.POLYMARKET_API_SECRET     ?? "",
    apiPassphrase: process.env.POLYMARKET_API_PASSPHRASE ?? "",
  },
  batchWindowMs: parseInt(process.env.BATCH_WINDOW_MS ?? "30000"),
};

const PORT = parseInt(process.env.PORT ?? "3001");

// Optional pre-warm market from env (backward-compat with old MARKET_ID single-market setup)
const PRE_WARM_MARKET_ID = process.env.MARKET_ID
  ? (process.env.MARKET_ID as `0x${string}`)
  : null;

// ── Per-market state ───────────────────────────────────────────────────────────

interface MarketState {
  processor:      BatchProcessor;
  currentBatchId: bigint | null;
  processingBatch: boolean;
  openingBatch:    boolean;
  closingBatch:    boolean;
  settleFailures:  Map<string, number>;
}

/** activeMarkets: marketId (lowercase hex) → MarketState */
const activeMarkets = new Map<string, MarketState>();

function makeConfig(marketId: `0x${string}`): RelayerConfig {
  return { ...baseConfig, marketId };
}

function createMarketState(marketId: `0x${string}`): MarketState {
  return {
    processor:       new BatchProcessor(makeConfig(marketId)),
    currentBatchId:  null,
    processingBatch: false,
    openingBatch:    false,
    closingBatch:    false,
    settleFailures:  new Map(),
  };
}

/** Ensure a market is tracked and has an open batch. Returns the MarketState. */
async function ensureMarket(marketId: `0x${string}`): Promise<MarketState> {
  const key = marketId.toLowerCase();

  if (!activeMarkets.has(key)) {
    const state = createMarketState(marketId);
    // Set openingBatch = true BEFORE adding to map so concurrent callers wait
    state.openingBatch = true;
    activeMarkets.set(key, state);
    console.log(`[Relayer] New market ${marketId} — opening on-demand batch`);
    try {
      state.currentBatchId = await state.processor.openBatch(marketId);
      console.log(`[Relayer] Opened batch ${state.currentBatchId} for market ${marketId}`);
    } catch (err: any) {
      if (err.message?.includes("batch already open")) {
        // A batch was already open (relayer restart or concurrent /warm) — read from chain
        state.currentBatchId = await publicClient.readContract({
          address: baseConfig.vaultAddress,
          abi:     BATCH_VAULT_ABI,
          functionName: "getCurrentBatchId",
          args:    [marketId],
        }) as bigint;
        console.log(`[Relayer] Recovered existing batch ${state.currentBatchId} for market ${marketId}`);
      } else {
        console.error(`[Relayer] openBatch for market ${marketId} failed:`, err);
        activeMarkets.delete(key); // Clean up failed state
        throw err;
      }
    } finally {
      state.openingBatch = false;
    }
  }

  // If a concurrent call is still running openBatch, wait for it to finish
  const state = activeMarkets.get(key)!;
  if (state.openingBatch) {
    console.log(`[Relayer] Market ${marketId} batch still opening — waiting...`);
    while (state.openingBatch) await new Promise((r) => setTimeout(r, 100));
    if (state.currentBatchId === null) throw new Error(`openBatch failed for market ${marketId}`);
  }

  return state;
}

// ── HTTP server ────────────────────────────────────────────────────────────────

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

  // OPTIONS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  // GET /health
  if (req.method === "GET" && req.url === "/health") {
    const markets: Record<string, { batchId: string | null; status: string }> = {};
    for (const [key, state] of activeMarkets) {
      markets[key] = {
        batchId: state.currentBatchId?.toString() ?? null,
        status:  state.processingBatch ? "settling"
               : state.closingBatch    ? "closing"
               : state.openingBatch    ? "opening"
               : "open",
      };
    }
    send(missingVars.length === 0 ? 200 : 503, {
      ok:      missingVars.length === 0,
      missing: missingVars,
      vault:   baseConfig.vaultAddress,
      markets,
    });
    return;
  }

  // POST /order
  //
  // Privacy path (recommended) — include `signature`, `commitment`, `nonce`, `deadline`:
  //   { marketId, batchId, signer, isBuy, amount, limitPrice, salt,
  //     commitment, signature, nonce, deadline }
  //   → relayer calls commitOrderFor() on-chain; only relayer address visible
  //
  // Legacy path — omit `signature`:
  //   { marketId, batchId, trader, isBuy, amount, limitPrice, salt }
  //   → trader already committed on-chain; relayer just stores order details
  if (req.method === "POST" && req.url === "/order") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      try {
        const data = JSON.parse(body);
        const { marketId, batchId, isBuy, amount, limitPrice, salt } = data;

        if (!marketId) {
          send(400, { error: "Missing required field: marketId (Polymarket condition ID)" });
          return;
        }
        if (batchId === undefined || isBuy === undefined || !amount || !limitPrice || !salt) {
          send(400, { error: "Missing fields: batchId, isBuy, amount, limitPrice, salt" });
          return;
        }
        if (!missingVars.length === false) {
          send(503, { error: "Relayer not configured — set VAULT_ADDRESS and RELAYER_PRIVATE_KEY" });
          return;
        }

        // Ensure market exists and has an open batch (on-demand)
        const state = await ensureMarket(marketId as `0x${string}`);
        const { processor } = state;

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

  // POST /warm — pre-open a batch for a market before the first order arrives.
  // Responds 202 immediately; batch opens in the background.
  if (req.method === "POST" && req.url === "/warm") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        const { marketId } = JSON.parse(body);
        if (!marketId) { send(400, { error: "Missing marketId" }); return; }
        const key = (marketId as string).toLowerCase();
        if (activeMarkets.has(key)) {
          // Already tracked — nothing to do
          send(200, { ok: true, alreadyOpen: true });
          return;
        }
        // Fire-and-forget: don't await so the response goes out instantly
        ensureMarket(marketId as `0x${string}`).catch((err) =>
          console.warn(`[Relayer] /warm background openBatch failed for ${marketId}:`, err.message),
        );
        send(202, { ok: true, warming: true });
      } catch { send(400, { error: "Invalid JSON" }); }
    });
    return;
  }

  // POST /admin/force-advance?marketId=0x...
  // Force-opens the next batch for a given market, abandoning any stuck SETTLING batch.
  if (req.method === "POST" && req.url?.startsWith("/admin/force-advance")) {
    const url      = new URL(req.url, "http://localhost");
    const marketId = url.searchParams.get("marketId") as `0x${string}` | null;
    if (!marketId) {
      send(400, { error: "Missing query param: marketId" });
      return;
    }
    const key = marketId.toLowerCase();
    if (!activeMarkets.has(key)) {
      send(404, { error: `Market ${marketId} is not currently active` });
      return;
    }
    const state = activeMarkets.get(key)!;
    (async () => {
      try {
        const prevBatchId = state.currentBatchId;
        const newBatchId  = await state.processor.openBatch(marketId);
        state.currentBatchId = newBatchId;
        console.log(`[Relayer] /admin/force-advance(${marketId}): opened batch ${newBatchId} (prev: ${prevBatchId})`);
        send(200, {
          ok:          true,
          marketId,
          prevBatchId: prevBatchId?.toString() ?? null,
          newBatchId:  newBatchId.toString(),
        });
      } catch (e: any) {
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
  console.log(`[Relayer]   GET  /health                               — liveness check`);
  console.log(`[Relayer]   POST /warm                                 — pre-open a batch for a market (fire-and-forget)`);
  console.log(`[Relayer]   POST /order                                — submit off-chain order details (include marketId)`);
  console.log(`[Relayer]   POST /admin/force-advance?marketId=0x...   — skip stuck SETTLING batch`);
});

// ── Startup log ───────────────────────────────────────────────────────────────
console.log("[Relayer] Starting Predacy relayer (multi-market mode)...");
console.log(`[Relayer] Vault:   ${baseConfig.vaultAddress}`);
console.log(`[Relayer] Chain:   ${chainId === polygon.id ? "Polygon" : "Polygon Amoy"}`);
console.log(`[Relayer] Window:  ${baseConfig.batchWindowMs / 1000}s`);

if (missingVars.length > 0) {
  console.error(`[Relayer] ⚠ Missing env vars: ${missingVars.join(", ")} — add them in Railway Variables tab`);
}

// ── Event polling + batch lifecycle (only when fully configured) ──────────────
// Uses getLogs polling instead of watchContractEvent — the public Amoy RPC is
// load-balanced, so eth_newFilter / eth_getFilterChanges fails with "filter not
// found" when requests hit different backend servers. getLogs is stateless.

const publicClient = createPublicClient({
  chain,
  transport: http(baseConfig.rpcUrl, { retryCount: 3 }),
});

const BATCH_CLOSED_EVENT = parseAbiItem(
  "event BatchClosed(uint256 indexed batchId, uint256 commitmentCount)",
);
const BATCH_SETTLED_EVENT = parseAbiItem(
  "event BatchSettled(uint256 indexed batchId, uint256 clearingPrice, uint256 totalBuyVolume, uint256 totalSellVolume, uint256 netBuyAmount, uint256 yesTokensReceived)",
);

let fromBlock = 0n;

async function onSettleFail(state: MarketState, marketKey: string, batchId: bigint, err: unknown) {
  const key = batchId.toString();
  const n   = (state.settleFailures.get(key) ?? 0) + 1;
  state.settleFailures.set(key, n);
  console.error(`[Relayer] processBatch ${batchId} (market ${marketKey}) failed (attempt ${n}/3):`, (err as any)?.message ?? err);

  if (n >= 3) {
    console.warn(`[Relayer] Batch ${batchId} UNRESOLVABLE after ${n} attempts — force-opening next batch`);
    state.settleFailures.delete(key);
    if (!state.openingBatch) {
      state.openingBatch = true;
      const marketId = marketKey as `0x${string}`;
      try {
        state.currentBatchId = await state.processor.openBatch(marketId);
        console.log(`[Relayer] Force-opened batch ${state.currentBatchId} (skipped unresolvable ${batchId})`);
      } catch (e: any) {
        if (e.message?.includes("batch already open")) {
          state.currentBatchId = await publicClient.readContract({
            address: baseConfig.vaultAddress,
            abi:     BATCH_VAULT_ABI,
            functionName: "getCurrentBatchId",
            args:    [marketId],
          }) as bigint;
          console.log(`[Relayer] Next batch already open: ${state.currentBatchId}`);
        } else {
          console.error("[Relayer] openBatch (force-skip) failed:", e);
        }
      } finally { state.openingBatch = false; }
    }
  }
}

const poll = async () => {
  if (missingVars.length > 0) return;
  try {
    const toBlock = await publicClient.getBlockNumber();
    if (toBlock < fromBlock) return;

    const [closedLogs, settledLogs] = await Promise.all([
      publicClient.getLogs({ address: baseConfig.vaultAddress, event: BATCH_CLOSED_EVENT,  fromBlock, toBlock }),
      publicClient.getLogs({ address: baseConfig.vaultAddress, event: BATCH_SETTLED_EVENT, fromBlock, toBlock }),
    ]);

    fromBlock = toBlock + 1n;

    // ── Per-market status checks ─────────────────────────────────────────────
    for (const [marketKey, state] of activeMarkets) {
      if (state.currentBatchId === null || state.closingBatch || state.processingBatch) continue;
      try {
        const batchInfo = await publicClient.readContract({
          address: baseConfig.vaultAddress,
          abi:     BATCH_VAULT_ABI,
          functionName: "getBatch",
          args:    [state.currentBatchId],
        }) as { status: number; openedAt: bigint; commitmentCount: bigint };

        const OPEN = 0, SETTLING = 1, SETTLED = 2;

        if (batchInfo.status === OPEN) {
          const nowSec    = Math.floor(Date.now() / 1000);
          const windowSec = baseConfig.batchWindowMs / 1000;

          // Evict idle markets: OPEN for > 2× window with zero orders — stop polling them
          if (batchInfo.commitmentCount === 0n && nowSec >= Number(batchInfo.openedAt) + windowSec * 2) {
            console.log(`[Relayer] Evicting idle market ${marketKey} — no orders in ${windowSec * 2}s`);
            activeMarkets.delete(marketKey);
            continue;
          }

          // Auto-close once window has elapsed AND there's at least one order
          if (nowSec >= Number(batchInfo.openedAt) + windowSec && batchInfo.commitmentCount > 0n) {
            state.closingBatch = true;
            console.log(`[Relayer] Batch ${state.currentBatchId} (market ${marketKey}) window expired (${batchInfo.commitmentCount} orders) — closing`);
            try   { await state.processor.closeBatch(); }
            catch (err) { console.error(`[Relayer] closeBatch (market ${marketKey}) failed:`, err); }
            finally { state.closingBatch = false; }
          }
        } else if (batchInfo.status === SETTLING) {
          state.processingBatch = true;
          console.log(`[Relayer] Batch ${state.currentBatchId} (market ${marketKey}) is SETTLING — processing`);
          try {
            await state.processor.processBatch(state.currentBatchId);
            state.settleFailures.delete(state.currentBatchId.toString());
          } catch (err) {
            await onSettleFail(state, marketKey, state.currentBatchId, err);
          } finally { state.processingBatch = false; }
        } else if (batchInfo.status === SETTLED && !state.openingBatch) {
          // Batch settled but event was missed — open next batch directly
          state.openingBatch = true;
          console.log(`[Relayer] Batch ${state.currentBatchId} (market ${marketKey}) SETTLED (event missed) — opening next batch`);
          const marketId = marketKey as `0x${string}`;
          try {
            state.currentBatchId = await state.processor.openBatch(marketId);
          } catch (err: any) {
            if (err.message?.includes("batch already open")) {
              state.currentBatchId = await publicClient.readContract({
                address: baseConfig.vaultAddress,
                abi:     BATCH_VAULT_ABI,
                functionName: "getCurrentBatchId",
                args:    [marketId],
              }) as bigint;
              console.log(`[Relayer] Next batch already open: ${state.currentBatchId} (market ${marketKey})`);
            } else {
              console.error(`[Relayer] openBatch (post-settle recovery, market ${marketKey}) failed:`, err);
            }
          } finally { state.openingBatch = false; }
        }
      } catch { /* RPC hiccup — retry next poll */ }
    }

    // ── BatchClosed → settle ─────────────────────────────────────────────────
    for (const log of closedLogs) {
      const batchId = log.args.batchId as bigint;
      // Identify which market this batch belongs to
      let targetState: MarketState | undefined;
      let targetKey:   string | undefined;
      for (const [key, state] of activeMarkets) {
        if (state.currentBatchId === batchId) { targetState = state; targetKey = key; break; }
      }
      if (!targetState || !targetKey) {
        console.warn(`[Relayer] BatchClosed ${batchId} — no matching active market, skipping`);
        continue;
      }
      if (targetState.processingBatch) {
        console.log(`[Relayer] BatchClosed ${batchId} (market ${targetKey}) — already settling, skipping`);
        continue;
      }
      targetState.processingBatch = true;
      console.log(`[Relayer] BatchClosed ${batchId} (market ${targetKey}, ${log.args.commitmentCount} orders) — settling`);
      try {
        await targetState.processor.processBatch(batchId);
        targetState.settleFailures.delete(batchId.toString());
      } catch (err) {
        await onSettleFail(targetState, targetKey, batchId, err);
      } finally { targetState.processingBatch = false; }
    }

    // ── BatchSettled → open next batch ───────────────────────────────────────
    for (const log of settledLogs) {
      const batchId = log.args.batchId as bigint;
      let targetState: MarketState | undefined;
      let targetKey:   string | undefined;
      for (const [key, state] of activeMarkets) {
        if (state.currentBatchId === batchId) { targetState = state; targetKey = key; break; }
      }
      if (!targetState || !targetKey) {
        console.warn(`[Relayer] BatchSettled ${batchId} — no matching active market`);
        continue;
      }
      if (targetState.openingBatch) continue;
      console.log(`[Relayer] BatchSettled ${batchId} (market ${targetKey}) — opening next batch`);
      targetState.openingBatch = true;
      const marketId = targetKey as `0x${string}`;
      try {
        targetState.currentBatchId = await targetState.processor.openBatch(marketId);
      } catch (err: any) {
        console.error(`[Relayer] openBatch (post-settle event, market ${targetKey}) failed:`, err);
        await new Promise((r) => setTimeout(r, 5_000));
        try   { targetState.currentBatchId = await targetState.processor.openBatch(marketId); }
        catch (e) { console.error(`[Relayer] openBatch retry (market ${targetKey}) failed:`, e); }
      } finally { targetState.openingBatch = false; }
    }
  } catch (err) {
    console.error("[Relayer] poll error:", err);
  }
};

// ── Startup recovery: re-process any SETTLING batches from before restart ──────
// Scans BatchClosed events from the last ~70 h and finds any that never emitted
// BatchSettled. For each one, reconstructs the MarketState and retriggers
// processBatch() so users' USDC isn't stuck after a Railway redeploy.

async function recoverSettlingBatches() {
  if (missingVars.length > 0) return;
  console.log("[Relayer] Scanning for SETTLING batches to recover...");
  try {
    const toBlock  = await publicClient.getBlockNumber();
    // ~50 000 blocks ≈ 70 h on Amoy (5 s/block) / 28 h on Polygon mainnet (2 s/block)
    const scanFrom = toBlock > 50_000n ? toBlock - 50_000n : 0n;

    const [closedLogs, settledLogs] = await Promise.all([
      publicClient.getLogs({ address: baseConfig.vaultAddress, event: BATCH_CLOSED_EVENT,  fromBlock: scanFrom, toBlock }),
      publicClient.getLogs({ address: baseConfig.vaultAddress, event: BATCH_SETTLED_EVENT, fromBlock: scanFrom, toBlock }),
    ]);

    const settledIds = new Set(settledLogs.map((l) => (l.args.batchId as bigint).toString()));
    const unsettled  = closedLogs.filter((l) => !settledIds.has((l.args.batchId as bigint).toString()));

    if (unsettled.length === 0) {
      console.log("[Relayer] No SETTLING batches found — clean startup");
      return;
    }
    console.log(`[Relayer] Found ${unsettled.length} SETTLING batch(es) to recover`);

    for (const log of unsettled) {
      const batchId = log.args.batchId as bigint;
      try {
        const batchInfo = await publicClient.readContract({
          address:      baseConfig.vaultAddress,
          abi:          BATCH_VAULT_ABI,
          functionName: "getBatch",
          args:         [batchId],
        }) as { marketId: `0x${string}`; status: number };

        if (batchInfo.status !== 1 /* SETTLING */) {
          console.log(`[Relayer] Batch ${batchId} status=${batchInfo.status} (not SETTLING) — skipping`);
          continue;
        }

        const marketId = batchInfo.marketId;
        const key      = marketId.toLowerCase();
        if (activeMarkets.has(key)) continue; // already tracked

        const state = createMarketState(marketId);
        state.currentBatchId  = batchId;
        state.processingBatch = true;
        activeMarkets.set(key, state);
        console.log(`[Relayer] Recovering SETTLING batch ${batchId} for market ${marketId}`);

        // Trigger settlement immediately in background
        state.processor.processBatch(batchId)
          .then(() => {
            state.settleFailures.delete(batchId.toString());
            console.log(`[Relayer] Recovery: settled batch ${batchId} (market ${marketId})`);
          })
          .catch(async (err) => { await onSettleFail(state, key, batchId, err); })
          .finally(() => { state.processingBatch = false; });
      } catch (err) {
        console.error(`[Relayer] Recovery: failed to inspect batch ${batchId}:`, err);
      }
    }
  } catch (err) {
    console.error("[Relayer] recoverSettlingBatches failed:", err);
  }
}

// Startup: set fromBlock, recover SETTLING batches, pre-warm MARKET_ID if set, then begin polling
(async () => {
  try {
    fromBlock = await publicClient.getBlockNumber();
  } catch {
    fromBlock = 0n;
  }

  await recoverSettlingBatches();

  if (missingVars.length === 0 && PRE_WARM_MARKET_ID) {
    console.log(`[Relayer] Pre-warming market ${PRE_WARM_MARKET_ID} (MARKET_ID env var)`);
    try {
      await ensureMarket(PRE_WARM_MARKET_ID);
      console.log(`[Relayer] Pre-warm complete — batch ${activeMarkets.get(PRE_WARM_MARKET_ID.toLowerCase())?.currentBatchId} is open`);
    } catch (err: any) {
      console.warn(`[Relayer] Pre-warm for ${PRE_WARM_MARKET_ID} failed: ${err.message}`);
    }
  } else if (missingVars.length > 0) {
    console.log("[Relayer] Env vars missing — skipping pre-warm, HTTP server still available");
  } else {
    console.log("[Relayer] No MARKET_ID env var — markets will be opened on-demand when first order arrives");
  }

  setInterval(poll, 5_000);
  console.log("[Relayer] Polling every 5 s (multi-market mode)");
})();
