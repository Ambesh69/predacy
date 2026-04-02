import "dotenv/config";
import { createServer } from "node:http";
import { createPublicClient, http, fallback, parseAbiItem, recoverMessageAddress, encodeFunctionData } from "viem";
import { polygon, polygonAmoy } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { createWalletClient } from "viem";
import { BatchProcessor, BATCH_VAULT_ABI, type RelayerConfig, type RequeueResult } from "./batchProcessor.js";
import { ZKClaimProver } from "./zkClaimProver.js";
import { ProxyWalletManager } from "./proxyWalletManager.js";

// ── Environment ───────────────────────────────────────────────────────────────
const missingVars = ["VAULT_ADDRESS", "RELAYER_PRIVATE_KEY"].filter((v) => !process.env[v]);

// CHAIN_ID: 137 = Polygon mainnet, 80002 = Polygon Amoy (default)
const chainId = parseInt(process.env.CHAIN_ID ?? "80002");
const chain   = chainId === polygon.id ? polygon : polygonAmoy;

const baseConfig = {
  // polygon-rpc.com routes through 1rpc.io (same "tenant disabled" restrictions on eth_getLogs).
  // polygon.drpc.org is a free public RPC that supports eth_getLogs without an API key.
  rpcUrl:            process.env.RPC_URL ?? (chainId === polygon.id
    ? "https://polygon.drpc.org"
    : "https://rpc-amoy.polygon.technology/"),
  chainId,
  vaultAddress:      (process.env.VAULT_ADDRESS      ?? "0x0000000000000000000000000000000000000000") as `0x${string}`,
  relayerPrivateKey: (process.env.RELAYER_PRIVATE_KEY ?? "0x0000000000000000000000000000000000000000000000000000000000000001") as `0x${string}`,
  redisUrl:          process.env.REDIS_URL,
  polymarket: {
    apiKey:          process.env.POLYMARKET_API_KEY        ?? "",
    apiSecret:       process.env.POLYMARKET_API_SECRET     ?? "",
    apiPassphrase:   process.env.POLYMARKET_API_PASSPHRASE ?? "",
    // EIP-712 order signing key. Must be the key that owns the Polymarket API key.
    // Falls back to RELAYER_PRIVATE_KEY if not set.
    signerPrivateKey: (process.env.POLYMARKET_SIGNER_KEY ?? process.env.RELAYER_PRIVATE_KEY) as `0x${string}` | undefined,
    // Polymarket proxy wallet (maker address). Visible in polymarket.com → Builder Codes → Address.
    // Must be set for CLOB order placement to work (maker ≠ signer EOA).
    proxyWallet: process.env.POLYMARKET_PROXY_WALLET || undefined,
    // Builder API credentials — from polymarket.com/settings?tab=builder
    // Adds POLY_BUILDER_* headers to all CLOB orders for volume attribution + weekly rewards.
    builderKey:        process.env.POLYMARKET_BUILDER_KEY        || undefined,
    builderSecret:     process.env.POLYMARKET_BUILDER_SECRET     || undefined,
    builderPassphrase: process.env.POLYMARKET_BUILDER_PASSPHRASE || undefined,
  },
  batchWindowMs:  parseInt(process.env.BATCH_WINDOW_MS ?? "30000"),
  useRealZk:      process.env.USE_REAL_ZK?.trim().toLowerCase() === "true",
  // PublicInputAdapter address — required when USE_REAL_ZK=true.
  // Adapter converts BatchVault's 6 public inputs to the 37-input HonkVerifier format.
  adapterAddress: process.env.ADAPTER_ADDRESS
    ? (process.env.ADAPTER_ADDRESS as `0x${string}`)
    : undefined,
  usdcAddress: process.env.USDC_ADDRESS
    ? (process.env.USDC_ADDRESS as `0x${string}`)
    : (chainId === polygon.id
        ? "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174" // Polygon mainnet USDC.e
        : undefined),
  ctfAddress: process.env.CTF_ADDRESS
    ? (process.env.CTF_ADDRESS as `0x${string}`)
    : (chainId === polygon.id
        ? "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045" // Polygon mainnet ConditionalTokens
        : undefined),
};

const PORT = parseInt(process.env.PORT ?? "3001");

// ── Batch cap constants ────────────────────────────────────────────────────────
// Batch closes early when EITHER cap is hit — whichever comes first.
// MAX_BATCH_USD: max combined USDC notional per batch (prevents Polymarket price impact)
// MAX_BATCH_ORDERS: max order count per batch (limits proof complexity)
const MAX_BATCH_USD_MICRO = BigInt(
  Math.round(parseFloat(process.env.MAX_BATCH_USD ?? "5000") * 1_000_000),
); // default $5,000
const MAX_BATCH_ORDERS = parseInt(process.env.MAX_BATCH_ORDERS ?? "50");

// Optional pre-warm market from env (backward-compat with old MARKET_ID single-market setup)
const PRE_WARM_MARKET_ID = process.env.MARKET_ID
  ? (process.env.MARKET_ID as `0x${string}`)
  : null;

// ── Per-market state ───────────────────────────────────────────────────────────

interface MarketState {
  processor:            BatchProcessor;
  currentBatchId:       bigint | null;   // currently OPEN batch (accepting orders)
  settlingBatchId:      bigint | null;   // batch being proved/settled in background
  processingBatch:      boolean;
  openingBatch:         boolean;
  closingBatch:         boolean;
  settleFailures:       Map<string, number>;
  batchRunningUsdMicro: bigint;          // running USDC sum for current batch (6-dec)
  lastOrderSubmitAt:    number;          // unix-seconds: set just before each order tx; blocks idle-eviction during confirmation window
}

/** activeMarkets: marketId (lowercase hex) → MarketState */
const activeMarkets = new Map<string, MarketState>();

/** Reverse index: batchId.toString() → marketKey — find market state from any batch event */
const batchToMarket = new Map<string, string>();

/** Find market state from any batch ID (current or settling). */
function findMarketByBatchId(batchId: bigint): [MarketState, string] | [undefined, undefined] {
  const key = batchToMarket.get(batchId.toString());
  if (!key) return [undefined, undefined];
  const state = activeMarkets.get(key);
  if (!state) return [undefined, undefined];
  return [state, key];
}

function makeConfig(marketId: `0x${string}`): RelayerConfig {
  return { ...baseConfig, marketId };
}

function createMarketState(marketId: `0x${string}`): MarketState {
  return {
    processor:            new BatchProcessor(makeConfig(marketId)),
    currentBatchId:       null,
    settlingBatchId:      null,
    processingBatch:      false,
    openingBatch:         false,
    closingBatch:         false,
    settleFailures:       new Map(),
    batchRunningUsdMicro: 0n,
    lastOrderSubmitAt:    0,
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
    // v10: register NegRisk token IDs so vault distributes tradeable tokens
    try {
      await state.processor.ensureMarketTokenIds(marketId);
    } catch (err: any) {
      if (err?.message?.includes("Market not found")) {
        // Hard failure — market doesn't exist on Polymarket. Clean up and reject
        // the order so we don't waste MATIC on openBatch for a phantom market.
        activeMarkets.delete(key);
        throw new Error(`Unknown market: ${marketId}`);
      }
      // Transient Gamma API error — proceed with batch opening anyway.
      console.warn(`[Relayer] ensureMarketTokenIds for ${marketId} failed (non-fatal): ${err.message}`);
    }
    try {
      state.currentBatchId = await state.processor.openBatch(marketId);
      batchToMarket.set(state.currentBatchId.toString(), key);
      console.log(`[Relayer] Opened batch ${state.currentBatchId} for market ${marketId}`);
    } catch (err: any) {
      // openBatch reverts when a batch is already open for this market.
      // Alchemy/Polygon often strips the revert reason from the error (returns bare
      // "execution reverted"), so we can't reliably match on error message text.
      // Instead: always attempt to read the existing batch ID from chain first.
      // If a valid batch exists, recover it; otherwise treat as a real failure.
      try {
        const existingId = await publicClient.readContract({
          address: baseConfig.vaultAddress,
          abi:     BATCH_VAULT_ABI,
          functionName: "getCurrentBatchId",
          args:    [marketId],
        }) as bigint;
        if (existingId > 0n) {
          state.currentBatchId = existingId;
          batchToMarket.set(state.currentBatchId.toString(), key);
          console.log(`[Relayer] Recovered existing batch ${state.currentBatchId} for market ${marketId}`);
        } else {
          console.error(`[Relayer] openBatch for market ${marketId} failed, no existing batch:`, err.message);
          activeMarkets.delete(key);
          throw err;
        }
      } catch (inner: any) {
        if (inner === err) throw err; // re-throw original if inner is same error
        console.error(`[Relayer] openBatch for market ${marketId} failed:`, err.message);
        console.error(`[Relayer] Fallback getCurrentBatchId also failed:`, inner.message);
        activeMarkets.delete(key);
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

// ── Claim errors ABI ──────────────────────────────────────────────────────────
// Used for simulateContract pre-flight AND writeContract decoding on the claim path.
// Includes BatchVault custom errors + ClaimHonkVerifier errors that bubble up.
const CLAIM_ERRORS_ABI = [
  // BatchVault claim errors
  { name: "ZKProofInvalid",     type: "error", inputs: [] },
  { name: "CommitmentMismatch", type: "error", inputs: [] },
  { name: "AlreadyClaimed",     type: "error", inputs: [] },
  { name: "BatchNotSettled",    type: "error", inputs: [] },
  { name: "ClaimVerifierNotSet", type: "error", inputs: [] },
  { name: "NothingToClaim",     type: "error", inputs: [] },
  // ClaimHonkVerifier (N=262144) errors — same error names as BatchHonkVerifier
  { name: "ProofLengthWrongWithLogN", type: "error", inputs: [
    { name: "logN",           type: "uint256" },
    { name: "actualLength",   type: "uint256" },
    { name: "expectedLength", type: "uint256" },
  ]},
  { name: "PublicInputsLengthWrong",   type: "error", inputs: [] },
  { name: "SumcheckFailed",            type: "error", inputs: [] },
  { name: "ShpleminiFailed",           type: "error", inputs: [] },
  { name: "GeminiChallengeInSubgroup", type: "error", inputs: [] },
  { name: "ConsistencyCheckFailed",    type: "error", inputs: [] },
];

// ── Async claim job store ─────────────────────────────────────────────────────
// POST /claim-proof returns a jobId immediately (ZK proof takes 60-90s on Railway).
// The actual proof + on-chain submission run in the background.
// Frontend polls GET /claim-proof/status?jobId=... until status is "done" or "error".
interface ClaimJobResult {
  txHash:        string;
  wrapDigest?:   string;
  wrappedToken?: string;
  ctfAddress?:   string;
  tokenAmount?:  string;
  wrapError?:    string;
}
interface ClaimJob {
  status:    "pending" | "done" | "error";
  result?:   ClaimJobResult;
  error?:    string;
  createdAt: number;
}
const claimJobs = new Map<string, ClaimJob>();
// Evict jobs older than 30 min to prevent unbounded memory growth
setInterval(() => {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [id, job] of claimJobs) {
    if (job.createdAt < cutoff) claimJobs.delete(id);
  }
}, 15 * 60 * 1000).unref();

// ── HTTP server ────────────────────────────────────────────────────────────────

const CORS_HEADERS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Signature",
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
    const markets: Record<string, { batchId: string | null; settlingBatchId: string | null; status: string }> = {};
    for (const [key, state] of activeMarkets) {
      markets[key] = {
        batchId:         state.currentBatchId?.toString() ?? null,
        settlingBatchId: state.settlingBatchId?.toString() ?? null,
        status:          state.processingBatch ? "settling"
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
  //   { marketId, batchId, signer, side, amount, limitPrice, salt,
  //     commitment, signature, nonce, deadline }
  //   side: 0=YES_BUY, 1=YES_SELL, 2=NO_BUY, 3=NO_SELL (v8, replaces isBuy bool)
  //   → relayer calls commit*OrderFor() on-chain; only relayer address visible
  //
  // Legacy path — omit `signature`:
  //   { marketId, batchId, trader, side, amount, limitPrice, salt }
  //   → trader already committed on-chain; relayer just stores order details
  if (req.method === "POST" && req.url === "/order") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      try {
        const data = JSON.parse(body);
        const { marketId, batchId, side, amount, limitPrice, salt } = data;

        if (!marketId) {
          send(400, { error: "Missing required field: marketId (Polymarket condition ID)" });
          return;
        }
        if (batchId === undefined || side === undefined || !amount || !limitPrice || !salt) {
          send(400, { error: "Missing fields: batchId, side, amount, limitPrice, salt" });
          return;
        }
        if (missingVars.length > 0) {
          send(503, { error: "Relayer not configured — set VAULT_ADDRESS and RELAYER_PRIVATE_KEY" });
          return;
        }

        // Ensure market exists and has an open batch (on-demand)
        const state = await ensureMarket(marketId as `0x${string}`);
        const { processor } = state;

        const sideNum = Number(side); // 0=YES_BUY, 1=YES_SELL, 2=NO_BUY, 3=NO_SELL
        if (sideNum < 0 || sideNum > 3 || !Number.isInteger(sideNum)) {
          send(400, { error: "Invalid side — must be 0 (YES_BUY), 1 (YES_SELL), 2 (NO_BUY), or 3 (NO_SELL)" });
          return;
        }
        const order = {
          trader:     (data.signer ?? data.trader) as `0x${string}`,
          side:       sideNum,
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
          // Stamp in-flight time BEFORE submitting — prevents the idle-eviction check
          // from racing during tx confirmation (commitmentCount is still 0 on-chain
          // while the tx is pending, which would otherwise trigger eviction).
          state.lastOrderSubmitAt = Math.floor(Date.now() / 1000);

          // SELL orders (YES_SELL=1, NO_SELL=3): tokens pre-deposited on-chain
          const isSellSide = sideNum === 1 || sideNum === 3;
          if (isSellSide) {
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
            // Buy order: parse EIP-3009 TransferAuth (required for EIP-3009 settlement)
            let transferAuth = undefined;
            if (data.transferAuth) {
              const ta = data.transferAuth;
              transferAuth = {
                from:        (ta.from ?? signer) as `0x${string}`, // ephemeral wallet address
                validAfter:  BigInt(ta.validAfter  ?? "0"),
                validBefore: BigInt(ta.validBefore ?? "0"),
                nonce:       (ta.nonce ?? ("0x" + "0".repeat(64))) as `0x${string}`,
                v:           Number(ta.v ?? 0),
                r:           (ta.r ?? ("0x" + "0".repeat(64))) as `0x${string}`,
                s:           (ta.s ?? ("0x" + "0".repeat(64))) as `0x${string}`,
              };
            } else {
              console.warn(`[Relayer] Buy order from ${signer} has no transferAuth — settlement will fail if this order fills`);
            }

            // Parse pre-signed requeue authorizations (optional, buy orders only).
            // Frontend pre-signs 2 CommitOrder sigs with nonce+1 and nonce+2 at submission time.
            // If this order is excluded at clearing, the relayer uses these to auto-requeue
            // the order into the next batch — zero extra UX friction for the user.
            let requeueAuths = undefined;
            if (Array.isArray(data.requeueAuths) && data.requeueAuths.length > 0) {
              requeueAuths = data.requeueAuths.map((ra: any) => ({
                ephemeral: ra.ephemeral as `0x${string}`,
                nonce:     BigInt(ra.nonce),
                deadline:  BigInt(ra.deadline),
                signature: ra.signature as `0x${string}`,
              }));
              console.log(`[Relayer] Stored ${requeueAuths.length} requeue auth(s) for order from ${signer}`);
            }

            const orderWithRequeue = requeueAuths ? { ...order, requeueAuths } : order;
            await processor.submitCommitmentFor(
              BigInt(batchId),
              orderWithRequeue,
              commitment        as `0x${string}`,
              signer            as `0x${string}`,
              BigInt(nonce),
              BigInt(deadline),
              data.signature    as `0x${string}`,
              transferAuth,
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

        const actualBatchId = state.currentBatchId ?? BigInt(batchId);
        const orders = await processor.orderCount(actualBatchId);

        // Re-ensure market is tracked after tx confirmation — the poll loop may have
        // evicted it while we awaited the on-chain tx (commitmentCount was 0 during
        // the confirmation window, triggering the idle-eviction check).
        // NOTE: with the lastOrderSubmitAt guard above this should rarely happen, but
        // we keep this fallback path and now immediately seal if the window has elapsed.
        const mktKey = (marketId as string).toLowerCase();
        if (!activeMarkets.has(mktKey)) {
          ensureMarket(marketId as `0x${string}`)
            .then((reState) => {
              console.log(`[Relayer] Re-registered evicted market ${marketId} — batch ${reState.currentBatchId}`);
              // Batch window was already exceeded (that's why it was evicted) so seal now
              // rather than waiting up to another poll interval for the loop to catch it.
              if (orders > 0 && reState.currentBatchId !== null &&
                  !reState.closingBatch && !reState.processingBatch) {
                console.log(`[Relayer] Sealing re-registered batch ${reState.currentBatchId} immediately (window overdue)`);
                sealBatch(reState, marketId as `0x${string}`, mktKey)
                  .catch((e: any) => console.error(`[Relayer] sealBatch (eviction-recover, ${mktKey}) failed:`, e.message));
              }
            })
            .catch((e: any) => console.error(`[Relayer] Re-registration failed for ${marketId}:`, e.message));
        }

        // Return the ACTUAL on-chain batchId (not the one from the request body,
        // which may be stale/0 when the client submits before its first poll).
        send(200, { ok: true, batchId: actualBatchId.toString(), orders });

        // ── Batch cap check: early close if USD or order count cap is hit ──────
        // Increment running USD for this batch and check both caps.
        // We fire-and-forget sealBatch so the response has already been sent.
        state.batchRunningUsdMicro += BigInt(amount);
        const capHitUsd    = state.batchRunningUsdMicro >= MAX_BATCH_USD_MICRO;
        const capHitOrders = orders >= MAX_BATCH_ORDERS;
        if ((capHitUsd || capHitOrders) && !state.closingBatch && !state.processingBatch && state.currentBatchId !== null) {
          const reason = capHitUsd
            ? `$${(Number(state.batchRunningUsdMicro) / 1e6).toFixed(2)} >= $${Number(MAX_BATCH_USD_MICRO) / 1e6} USD cap`
            : `${orders} >= ${MAX_BATCH_ORDERS} orders cap`;
          console.log(`[Relayer] Batch ${state.currentBatchId} (${marketId}) cap hit: ${reason} — early close`);
          sealBatch(state, marketId as `0x${string}`, mktKey)
            .catch((e) => console.error(`[Relayer] Early close error (${marketId}):`, (e as any).message));
        }

        // ── Wallet history: store compact summary for cross-device access ──────
        // Keyed by walletAddress (real connected wallet) + commitment hash.
        // Separate from per-batch order store; 90-day TTL; non-blocking.
        const walletAddr = (data.walletAddress as string | undefined)?.toLowerCase();
        if (walletAddr && /^0x[0-9a-f]{40}$/.test(walletAddr) && data.commitment) {
          saveWalletHistoryEntry(walletAddr, {
            commitment:     (data.commitment as string).toLowerCase(),
            batchId:        actualBatchId.toString(),
            side:           sideNum,
            amount:         String(amount),
            limitPrice:     String(limitPrice),
            salt:           String(salt),
            marketId:       String(marketId),
            marketQuestion: (data.marketQuestion as string | null) ?? null,
            timestamp:      Date.now(),
          }).catch(() => {});
        }
      } catch (e: any) {
        send(400, { error: e.message });
      }
    });
    return;
  }

  // GET /claim-proof/status?jobId=...
  //
  // Poll the status of an async /claim-proof job.
  // Returns: { status: "pending"|"done"|"error", txHash?, wrapDigest?, wrappedToken?,
  //            ctfAddress?, tokenAmount?, wrapError?, error? }
  if (req.method === "GET" && req.url?.startsWith("/claim-proof/status")) {
    const jobId = new URL(req.url, "http://localhost").searchParams.get("jobId") ?? "";
    const job = claimJobs.get(jobId);
    if (!job) {
      send(404, { error: "Job not found — may have expired (30 min TTL) or job ID is invalid" });
      return;
    }
    send(200, {
      status: job.status,
      ...(job.result ?? {}),
      ...(job.error ? { error: job.error } : {}),
    });
    return;
  }

  // POST /claim-proof
  //
  // ZK claim: user sends their order preimage; relayer builds Merkle path,
  // generates ZK proof, calls claimWithProof() on-chain.
  //
  // Body: { batchId, marketId, side, amount, limitPrice, salt, recipient,
  //         proxyWallet?, ctfTokenId? }
  //   side: 0=YES_BUY, 1=YES_SELL, 2=NO_BUY, 3=NO_SELL (v8)
  //   proxyWallet: if set, tokens go to this ProxyWallet address
  //   ctfTokenId:  CTF ERC-1155 tokenId for the YES or NO outcome (decimal string)
  //
  // Response: { ok: true, jobId }   ← returns IMMEDIATELY (ZK proof is async)
  //   Poll GET /claim-proof/status?jobId=... until status is "done" or "error".
  //   On "done": { status, txHash, wrapDigest?, wrappedToken?, ctfAddress?, tokenAmount? }
  //
  // Privacy: the relayer submits claimWithProof() as msg.sender — neither the
  // user's address nor which specific order is being claimed appears on-chain.
  // Payout goes to `recipient` (chosen by the user; can be a fresh address).
  if (req.method === "POST" && req.url === "/claim-proof") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      try {
        const data = JSON.parse(body);
        const { batchId, marketId, side, amount, limitPrice, salt, recipient,
                proxyWallet, ctfTokenId } = data;

        if (!batchId || !marketId || side === undefined || !amount || !limitPrice || !salt || !recipient) {
          send(400, { error: "Missing fields: batchId, marketId, side, amount, limitPrice, salt, recipient" });
          return;
        }
        if (missingVars.length > 0) {
          send(503, { error: "Relayer not configured — set VAULT_ADDRESS and RELAYER_PRIVATE_KEY" });
          return;
        }

        // Create async job — respond immediately to avoid Railway HTTP proxy timeout.
        // (ZK proof generation takes 60-90 seconds; Railway drops idle connections at ~60s)
        const jobId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
        claimJobs.set(jobId, { status: "pending", createdAt: Date.now() });
        send(202, { ok: true, jobId });

        // Process proof in background — res is already closed, result stored in claimJobs
        (async () => {
          try {
            const batchIdBig    = BigInt(batchId);
            const amountBig     = BigInt(amount);
            const limitPriceBig = BigInt(limitPrice);

            // 1. Fetch settled batch info from chain
            const batchRaw = await publicClient.readContract({
              address:      baseConfig.vaultAddress,
              abi:          BATCH_VAULT_ABI,
              functionName: "getBatch",
              args:         [batchIdBig],
            }) as {
              status: number;
              clearingPrice: bigint;
              claimMerkleRoot: `0x${string}`;
              commitmentCount: bigint;
            };

            // v9 BatchStatus: OPEN=0, SETTLING=1, LOCKED=2, SETTLED=3
            if (batchRaw.status !== 3 /* SETTLED */) {
              claimJobs.set(jobId, {
                status: "error",
                error:  `Batch ${batchId} is not yet settled (status=${batchRaw.status})`,
                createdAt: Date.now(),
              });
              return;
            }

            // 2. Fetch all commitment hashes from chain
            const commitmentCount = Number(batchRaw.commitmentCount);
            const allCommitments: `0x${string}`[] = [];
            for (let i = 0; i < commitmentCount; i++) {
              const c = await publicClient.readContract({
                address:      baseConfig.vaultAddress,
                abi:          BATCH_VAULT_ABI,
                functionName: "getCommitment",
                args:         [batchIdBig, BigInt(i)],
              }) as { hash: `0x${string}`; amount: bigint; claimed: boolean };
              allCommitments.push(c.hash);
            }

            // 3. Generate ZK claim proof
            const { OrderSide } = await import("./types.js");
            const prover = new ZKClaimProver(baseConfig.useRealZk ?? false);
            const { proof, publicInputs } = await prover.generateProof({
              batchId:         batchIdBig,
              claimMerkleRoot: batchRaw.claimMerkleRoot,
              clearingPrice:   batchRaw.clearingPrice,
              marketId:        marketId  as `0x${string}`,
              side:            Number(side) as typeof OrderSide[keyof typeof OrderSide], // 0-3
              amount:          amountBig,
              limitPrice:      limitPriceBig,
              salt:            salt      as `0x${string}`,
              allCommitments,
              recipient:       recipient as `0x${string}`,
            });

            // 4. Submit claimWithProof() on-chain (relayer is msg.sender — no trader address leaked)
            //
            // Pre-flight simulation: surfaces ZKProofInvalid / CommitmentMismatch / etc.
            // before spending gas. Uses unlimited gas (eth_call) so heavy ZK verify works.
            console.log(`[Relayer] Simulating claimWithProof for batch ${batchId}...`);
            try {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              await (publicClient as any).simulateContract({
                address:      baseConfig.vaultAddress,
                abi:          [...BATCH_VAULT_ABI, ...CLAIM_ERRORS_ABI],
                functionName: "claimWithProof",
                args:         [batchIdBig, proof, publicInputs],
                account:      walletClientGlobal.account!.address,
              });
              console.log(`[Relayer] claimWithProof simulation passed ✓ — sending tx`);
            } catch (simErr: unknown) {
              const e = simErr as any;
              const errName  = e?.cause?.data?.errorName ?? e?.cause?.reason ?? e?.shortMessage;
              const errArgs  = e?.cause?.data?.args;
              const fallback = e?.message ?? String(simErr);
              const detail   = errName
                ? (errArgs ? `${errName}(${errArgs.join(", ")})` : errName)
                : fallback;
              console.error(`[Relayer] claimWithProof simulation FAILED: ${detail}`);
              throw new Error(`claimWithProof would revert: ${detail}`, { cause: simErr });
            }

            // Explicit gas: ClaimHonkVerifier (N=262144) is compute-heavy — eth_estimateGas
            // can choke on it just like the batch HonkVerifier (N=524288).
            // 8M gas at 500 gwei = 4 MATIC max reservation, well within relayer balance.
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const txHash = await (walletClientGlobal.writeContract as (p: any) => Promise<`0x${string}`>)({
              address:      baseConfig.vaultAddress,
              abi:          [...BATCH_VAULT_ABI, ...CLAIM_ERRORS_ABI],
              functionName: "claimWithProof",
              args:         [batchIdBig, proof, publicInputs],
              gas:                  8_000_000n,          // explicit — bypass eth_estimateGas
              maxPriorityFeePerGas: 100_000_000_000n,   // 100 gwei
              maxFeePerGas:         300_000_000_000n,   // 300 gwei — 8M × 300 gwei = 2.4 MATIC
            });

            // Wait up to 120 s for the receipt. If polling times out the tx is already
            // in-flight and the nullifier will be set on-chain — treat as submitted-OK.
            try {
              await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 120_000 });
            } catch (receiptErr: any) {
              const msg: string = receiptErr?.message ?? "";
              if (msg.includes("could not be found") || msg.includes("not be processed")) {
                console.warn(`[Relayer] claimWithProof receipt timeout for ${txHash} — tx submitted, treating as done`);
              } else {
                throw receiptErr; // real error (e.g. revert) — propagate to outer catch
              }
            }
            console.log(`[Relayer] claimWithProof tx: ${txHash} (batch ${batchId}, recipient ${recipient})`);

            // 5. If ProxyWallet + CTF token ID provided, build wrap digest for the frontend to sign.
            //    Relayer deploys WrappedCTFToken if not already deployed (relayer pays gas).
            //    The actual wrap is executed via POST /wrap-execute after the frontend signs.
            const pwm = getProxyWalletManager();
            if (proxyWallet && ctfTokenId && pwm && baseConfig.ctfAddress) {
              try {
                const ctfTokenIdBig = BigInt(ctfTokenId);
                const sideNum = Number(side);

                // Ensure ProxyWallet is deployed (deploying it here is fine since tokens
                // were sent to it by claimWithProof — they'd be stuck if wallet not deployed).
                await pwm.ensureDeployed(proxyWallet as `0x${string}`);

                // Deploy WrappedCTFToken wrapper for this positionId if needed.
                const tokenName   = (sideNum === 0) ? "wYES" : "wNO";
                const tokenSymbol = tokenName;
                const wrappedToken = await pwm.ensureWrapper(ctfTokenIdBig, tokenName, tokenSymbol);

                // Read ProxyWallet's actual token balance (exact amount received from claim).
                const tokenBalance = await publicClient.readContract({
                  address:      baseConfig.ctfAddress,
                  abi:          CTF_BALANCE_ABI,
                  functionName: "balanceOf",
                  args:         [proxyWallet as `0x${string}`, ctfTokenIdBig],
                }) as bigint;

                if (tokenBalance === 0n) {
                  // Order wasn't filled (limit below clearing price) — no tokens to wrap.
                  console.log(`[Relayer] ProxyWallet ${proxyWallet} has 0 tokens — skip wrap digest`);
                  claimJobs.set(jobId, { status: "done", result: { txHash }, createdAt: Date.now() });
                  return;
                }

                // Build the 2-call wrap batch digest for the frontend to sign.
                const wrapDigest = await pwm.buildWrapDigest(
                  proxyWallet  as `0x${string}`,
                  baseConfig.ctfAddress,
                  wrappedToken,
                  tokenBalance,
                );

                console.log(`[Relayer] wrap digest ready for proxy ${proxyWallet}: ${tokenBalance} tokens`);
                claimJobs.set(jobId, {
                  status: "done",
                  result: {
                    txHash,
                    wrapDigest,
                    wrappedToken,
                    ctfAddress:  baseConfig.ctfAddress,
                    tokenAmount: tokenBalance.toString(),
                  },
                  createdAt: Date.now(),
                });
              } catch (wrapErr: any) {
                // Non-fatal: claim succeeded, wrap setup failed. Frontend can retry /wrap-execute later.
                console.error("[Relayer] wrap digest setup failed (claim OK):", wrapErr?.message ?? wrapErr);
                claimJobs.set(jobId, {
                  status: "done",
                  result: { txHash, wrapError: wrapErr?.message ?? "Wrap setup failed" },
                  createdAt: Date.now(),
                });
              }
              return;
            }

            claimJobs.set(jobId, { status: "done", result: { txHash }, createdAt: Date.now() });
          } catch (e: any) {
            console.error("[Relayer] /claim-proof background job error:", e?.message ?? e);
            claimJobs.set(jobId, {
              status: "error",
              error:  e?.message ?? "Claim proof failed",
              createdAt: Date.now(),
            });
          }
        })();
      } catch (e: any) {
        // Only reached for synchronous errors (JSON parse failure, etc.) before job was created
        console.error("[Relayer] /claim-proof error:", e?.message ?? e);
        send(400, { error: e?.message ?? "Claim proof failed" });
      }
    });
    return;
  }

  // POST /wrap-execute
  //
  // Execute the 2-call wrap batch (CTF.setApprovalForAll + WrappedCTFToken.wrap) on behalf
  // of a ProxyWallet. Alice signs the wrap digest returned by /claim-proof; the relayer
  // submits the batchExecuteWithSig tx (pays MATIC — Alice never needs gas).
  //
  // Body: { proxyWallet, wrappedToken, ctfAddress, tokenAmount, wrapSig }
  // Response: { ok: true, wrapTxHash }
  if (req.method === "POST" && req.url === "/wrap-execute") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      try {
        const data = JSON.parse(body);
        const { proxyWallet, wrappedToken, ctfAddress, tokenAmount, wrapSig } = data;

        if (!proxyWallet || !wrappedToken || !ctfAddress || !tokenAmount || !wrapSig) {
          send(400, { error: "Missing fields: proxyWallet, wrappedToken, ctfAddress, tokenAmount, wrapSig" });
          return;
        }

        const pwm = getProxyWalletManager();
        if (!pwm) {
          send(503, { error: "ProxyWalletManager not configured — set PROXY_WALLET_FACTORY and WRAPPED_CTF_FACTORY" });
          return;
        }

        const wrapTxHash = await pwm.submitWrapBatch(
          proxyWallet  as `0x${string}`,
          ctfAddress   as `0x${string}`,
          wrappedToken as `0x${string}`,
          BigInt(tokenAmount),
          wrapSig      as `0x${string}`,
        );

        console.log(`[Relayer] wrap batch tx: ${wrapTxHash} (proxy ${proxyWallet})`);
        send(200, { ok: true, wrapTxHash });
      } catch (e: any) {
        console.error("[Relayer] /wrap-execute error:", e?.message ?? e);
        send(400, { error: e?.message ?? "Wrap execution failed" });
      }
    });
    return;
  }

  // POST /proxy-transfer
  // Transfer CTF ERC-1155 tokens from a ProxyWallet to any recipient.
  // The owner (ephemeral EOA) signs a single-call meta-tx digest offline;
  // the relayer submits ProxyWallet.executeWithSig() and pays MATIC gas.
  //
  // Body: { proxyWallet, to, tokenId, amount, sig }
  //   proxyWallet: ProxyWallet contract address holding the tokens
  //   to:          recipient address (user's main wallet)
  //   tokenId:     CTF ERC-1155 positionId (decimal string)
  //   amount:      token amount (decimal string, use balanceOf for exact value)
  //   sig:         65-byte ECDSA signature from ephemeral EOA over the digest:
  //                keccak256(abi.encode(nonce, chainId, proxyWallet, ctfAddress, 0, keccak256(calldata)))
  //                signed with signMessage (eth_sign prefix, not EIP-712)
  if (req.method === "POST" && req.url === "/proxy-transfer") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      try {
        const data = JSON.parse(body);
        const { proxyWallet, to, tokenId, amount, sig, ephemeralAddress } = data;

        if (!proxyWallet || !to || !tokenId || !amount || !sig) {
          send(400, { error: "Missing fields: proxyWallet, to, tokenId, amount, sig" });
          return;
        }

        const ctfAddress = baseConfig.ctfAddress;
        if (!ctfAddress) {
          send(503, { error: "CTF_ADDRESS not configured on relayer" });
          return;
        }

        // Deploy ProxyWallet if not already deployed (relayer pays MATIC).
        // The owner signed a nonce=0 digest — a fresh deploy starts at nonce 0.
        const pwm = getProxyWalletManager();
        if (pwm && ephemeralAddress) {
          await pwm.ensureDeployed(ephemeralAddress as `0x${string}`);
        }

        // Idempotency guard: if the ProxyWallet's token balance is already 0, a prior
        // request (possibly concurrent or a receipt-timeout retry) already transferred
        // the tokens.  Return success immediately so the frontend clears the position.
        const CTF_BALANCE_ABI = [{
          name: "balanceOf", type: "function" as const,
          inputs: [{ name: "account", type: "address" }, { name: "id", type: "uint256" }],
          outputs: [{ name: "", type: "uint256" }], stateMutability: "view",
        }] as const;
        const currentBalance = await publicClient.readContract({
          address:      ctfAddress as `0x${string}`,
          abi:          CTF_BALANCE_ABI,
          functionName: "balanceOf",
          args:         [proxyWallet as `0x${string}`, BigInt(tokenId)],
        }) as bigint;
        if (currentBalance === 0n) {
          console.log(`[Relayer] proxy-transfer: ${proxyWallet} balance=0 — already transferred`);
          send(200, { ok: true, alreadyTransferred: true });
          return;
        }

        // Build CTF.safeTransferFrom(proxyWallet, to, tokenId, amount, "0x") calldata
        const CTF_SAFE_TRANSFER_ABI = [{
          name: "safeTransferFrom",
          type: "function" as const,
          inputs: [
            { name: "from",   type: "address" },
            { name: "to",     type: "address" },
            { name: "id",     type: "uint256" },
            { name: "amount", type: "uint256" },
            { name: "data",   type: "bytes"   },
          ],
          outputs:         [],
          stateMutability: "nonpayable",
        }] as const;

        const calldata = encodeFunctionData({
          abi:          CTF_SAFE_TRANSFER_ABI,
          functionName: "safeTransferFrom",
          args: [
            proxyWallet as `0x${string}`,
            to          as `0x${string}`,
            BigInt(tokenId),
            BigInt(amount),
            "0x",
          ],
        });

        // Call ProxyWallet.executeWithSig(ctfAddress, 0, calldata, sig)
        // The contract verifies the ephemeral EOA signed the meta-tx digest.
        const EXECUTE_WITH_SIG_ABI = [{
          name:            "executeWithSig",
          type:            "function" as const,
          inputs:          [
            { name: "to",    type: "address" },
            { name: "value", type: "uint256" },
            { name: "data",  type: "bytes"   },
            { name: "sig",   type: "bytes"   },
          ],
          outputs:         [{ name: "result", type: "bytes" }],
          stateMutability: "nonpayable",
        }] as const;

        const { request } = await publicClient.simulateContract({
          address:      proxyWallet as `0x${string}`,
          abi:          EXECUTE_WITH_SIG_ABI,
          functionName: "executeWithSig",
          args:         [ctfAddress, 0n, calldata, sig as `0x${string}`],
          account:      walletClientGlobal.account,
        });
        const txHash = await walletClientGlobal.writeContract(request as any);
        // Wait up to 120 s for receipt. ALWAYS check receipt.status — a reverted tx
        // must return 400 so the frontend retains proxyWalletAddress and can retry.
        try {
          const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 120_000 });
          if (receipt.status === "reverted") {
            throw new Error(`executeWithSig reverted on-chain (tx ${txHash})`);
          }
        } catch (receiptErr: any) {
          const msg: string = receiptErr?.message ?? "";
          if (msg.includes("could not be found") || msg.includes("not be processed")) {
            // Timeout: tx submitted but not yet mined. Check if tokens actually moved.
            const postBalance = await publicClient.readContract({
              address:      ctfAddress as `0x${string}`,
              abi:          CTF_BALANCE_ABI,
              functionName: "balanceOf",
              args:         [proxyWallet as `0x${string}`, BigInt(tokenId)],
            }) as bigint;
            if (postBalance > 0n) {
              // Tokens still in ProxyWallet — tx didn't mine. Let frontend retry.
              throw new Error(`proxy-transfer tx ${txHash} timed out and tokens are still in ProxyWallet`);
            }
            console.warn(`[Relayer] proxy-transfer receipt timeout for ${txHash} — balance=0, tokens moved`);
          } else {
            throw receiptErr;
          }
        }

        console.log(
          `[Relayer] proxy-transfer: tokenId=${tokenId} amount=${amount} ` +
          `from ${proxyWallet} → ${to} tx: ${txHash}`
        );
        send(200, { ok: true, txHash });
      } catch (e: any) {
        console.error("[Relayer] /proxy-transfer error:", e?.message ?? e);
        send(400, { error: e?.message ?? "Transfer failed" });
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

  // POST /admin/recover-batch?batchId=N
  // Directly retrigger processBatch for a LOCKED/SETTLING batch by ID.
  // Use when the startup recovery scan misses a stuck batch.
  if (req.method === "POST" && req.url?.startsWith("/admin/recover-batch")) {
    const url     = new URL(req.url, "http://localhost");
    const batchId = url.searchParams.get("batchId");
    if (!batchId) { send(400, { error: "Missing query param: batchId" }); return; }
    const batchIdBig = BigInt(batchId);
    (async () => {
      try {
        const batchInfo = await publicClient.readContract({
          address: baseConfig.vaultAddress, abi: BATCH_VAULT_ABI,
          functionName: "getBatch", args: [batchIdBig],
        }) as { marketId: `0x${string}`; status: number };

        const LOCKED = 2, SETTLING = 1;
        if (batchInfo.status !== LOCKED && batchInfo.status !== SETTLING) {
          send(400, { error: `Batch ${batchId} status=${batchInfo.status} (not LOCKED/SETTLING)` });
          return;
        }

        const marketId = batchInfo.marketId;
        const key      = marketId.toLowerCase();
        let state = activeMarkets.get(key);
        if (!state) {
          state = createMarketState(marketId);
          state.currentBatchId  = batchIdBig;
          activeMarkets.set(key, state);
          batchToMarket.set(batchId, key);
        }
        if (state.processingBatch) {
          send(409, { error: `Batch ${batchId} is already being processed` });
          return;
        }
        // Un-flag as permanently failed so the poll doesn't skip it on future retries.
        permanentlyFailedBatches.delete(batchId);
        if (_failRedis) {
          _failRedis.srem("predacy:failed_batches", batchId).catch(() => {});
        }
        state.settlingBatchId = batchIdBig;
        state.processingBatch = true;
        const phaseLabel = batchInfo.status === LOCKED ? "LOCKED (CLOB retry)" : "SETTLING";
        console.log(`[Relayer] /admin/recover-batch: manually recovering ${phaseLabel} batch ${batchId} (cleared permanently-failed flag)`);
        send(200, { ok: true, batchId, status: phaseLabel });
        state.processor.processBatch(batchIdBig)
          .then(() => {
            state!.settleFailures.delete(batchId);
            console.log(`[Relayer] /admin/recover-batch: batch ${batchId} settled ✓`);
          })
          .catch(async (err) => { await onSettleFail(state!, key, batchIdBig, err); })
          .finally(() => { state!.processingBatch = false; state!.settlingBatchId = null; });
      } catch (e: any) {
        send(500, { error: e.message });
      }
    })();
    return;
  }

  // GET /history/:walletAddress
  // Returns order summaries for a wallet. Requires a one-time EIP-191 signature
  // over a fixed message to prove the requester controls the wallet.
  // Frontend signs once per device, stores in localStorage — no re-prompts ever.
  //
  // Header:
  //   X-Signature : EIP-191 personal_sign of "Predacy: authorize history access for {wallet}"
  if (req.method === "GET" && req.url?.startsWith("/history/")) {
    const walletAddr = req.url.slice(9).toLowerCase(); // strip leading /history/
    if (!/^0x[0-9a-f]{40}$/.test(walletAddr)) {
      send(400, { error: "Invalid wallet address" });
      return;
    }
    (async () => {
      try {
        // ── Auth: verify one-time ownership signature ─────────────────────────
        const sigHeader = req.headers["x-signature"] as string | undefined;
        if (!sigHeader) {
          send(401, { error: "Missing X-Signature header" });
          return;
        }
        const message   = `Predacy: authorize history access for ${walletAddr}`;
        const recovered = await recoverMessageAddress({ message, signature: sigHeader as `0x${string}` });
        if (recovered.toLowerCase() !== walletAddr) {
          send(401, { error: "Signature does not match wallet address" });
          return;
        }
        // ── Fetch from Redis ─────────────────────────────────────────────────
        const r = await getHistoryRedis();
        if (!r) { send(200, { orders: [] }); return; }
        const raw = await r.hgetall(`predacy:wallet-history:${walletAddr}`) as Record<string, string> | null;
        const orders = raw
          ? Object.values(raw).map((v) => JSON.parse(v) as Record<string, unknown>)
          : [];
        // Newest first
        orders.sort((a, b) => ((b.timestamp as number) ?? 0) - ((a.timestamp as number) ?? 0));
        send(200, { orders });
      } catch (e: any) {
        send(500, { error: e.message });
      }
    })();
    return;
  }

  // GET /batch-status?marketId=0x...
  // Returns running USD + order count for the current open batch.
  // Used by the frontend BatchTimer to show a capacity progress bar.
  if (req.method === "GET" && req.url?.startsWith("/batch-status")) {
    const url      = new URL(req.url, "http://localhost");
    const marketId = url.searchParams.get("marketId");
    if (!marketId) { send(400, { error: "Missing query param: marketId" }); return; }
    const key      = marketId.toLowerCase();
    const mktState = activeMarkets.get(key);
    if (!mktState || mktState.currentBatchId === null) {
      send(404, { error: "Market not active — send an order first to open a batch" }); return;
    }
    (async () => {
      try {
        const orderCount = await mktState.processor.orderCount(mktState.currentBatchId!);
        send(200, {
          batchId:    mktState.currentBatchId!.toString(),
          runningUsd: Number(mktState.batchRunningUsdMicro) / 1_000_000,
          maxUsd:     Number(MAX_BATCH_USD_MICRO) / 1_000_000,
          maxOrders:  MAX_BATCH_ORDERS,
          orderCount,
        });
      } catch (e: any) {
        send(500, { error: e.message });
      }
    })();
    return;
  }

  // GET /order-status/:commitment
  // Returns requeue status for a given commitment hash.
  // Frontend polls this after order submission to detect auto-requeue and permanent failure.
  //
  // Response:
  //   { found: false }                                                — no event yet (order still pending)
  //   { found: true, status: 'requeued', fromBatch, toBatch, remainingAuths, timestamp }
  //   { found: true, status: 'failed',   fromBatch, remainingAuths, timestamp }
  if (req.method === "GET" && req.url?.startsWith("/order-status/")) {
    const commitment = req.url.slice("/order-status/".length).toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(commitment)) {
      send(400, { error: "Invalid commitment — expected 0x-prefixed 32-byte hex string" });
      return;
    }
    getRequeueStatus(commitment)
      .then((record) => {
        if (!record) { send(200, { found: false }); return; }
        send(200, { found: true, ...record });
      })
      .catch((e: any) => send(500, { error: e?.message ?? "Internal error" }));
    return;
  }

  send(404, { error: "Not found" });
});

server.listen(PORT, () => {
  console.log(`[Relayer] HTTP server on :${PORT}`);
  console.log(`[Relayer]   GET  /health                               — liveness check`);
  console.log(`[Relayer]   POST /warm                                 — pre-open a batch for a market (fire-and-forget)`);
  console.log(`[Relayer]   POST /order                                — submit off-chain order details (include marketId)`);
  console.log(`[Relayer]   GET  /order-status/:commitment             — requeue/failure status for a commitment (frontend polling)`);
  console.log(`[Relayer]   GET  /history/:walletAddress              — cross-device order history (indexed by real wallet)`);
  console.log(`[Relayer]   POST /claim-proof                          — generate ZK claim proof and submit claimWithProof()`);
  console.log(`[Relayer]   POST /admin/force-advance?marketId=0x...   — skip stuck SETTLING batch`);
});

// ── Startup log ───────────────────────────────────────────────────────────────
console.log("[Relayer] Starting Predacy relayer (multi-market mode)...");
console.log(`[Relayer] Vault:   ${baseConfig.vaultAddress}`);
console.log(`[Relayer] Chain:   ${chainId === polygon.id ? "Polygon" : "Polygon Amoy"}`);
console.log(`[Relayer] Window:  ${baseConfig.batchWindowMs / 1000}s (early-close: $${Number(MAX_BATCH_USD_MICRO) / 1e6} USD or ${MAX_BATCH_ORDERS} orders)`);
console.log(`[Relayer] ZK mode: ${baseConfig.useRealZk ? "REAL (HonkVerifier)" : "MOCK (prototype)"} (USE_REAL_ZK=${JSON.stringify(process.env.USE_REAL_ZK ?? null)})`);

if (missingVars.length > 0) {
  console.error(`[Relayer] ⚠ Missing env vars: ${missingVars.join(", ")} — add them in Railway Variables tab`);
}

// ── Event polling + batch lifecycle (only when fully configured) ──────────────
// Uses getLogs polling instead of watchContractEvent — the public Amoy RPC is
// load-balanced, so eth_newFilter / eth_getFilterChanges fails with "filter not
// found" when requests hit different backend servers. getLogs is stateless.

// Build a fallback transport so transient dRPC errors (500, 410 GRPC, etc.) automatically
// retry on the next endpoint. Mirrors the same pattern used inside BatchProcessor.
const _MAINNET_FALLBACKS = [
  "https://polygon-bor-rpc.publicnode.com", // reliable, already used by frontend
  "https://rpc.ankr.com/polygon",           // reliable, already used by frontend
  "https://polygon.drpc.org",               // keep as last resort
];
const _buildTransport = () => {
  if (chain.id === polygon.id) {
    const extras = _MAINNET_FALLBACKS.filter((u) => u !== baseConfig.rpcUrl);
    return fallback([http(baseConfig.rpcUrl), ...extras.map((u) => http(u))], { rank: false });
  }
  return http(baseConfig.rpcUrl);
};

const publicClient = createPublicClient({
  chain,
  transport: _buildTransport(),
});

// Global wallet client — shared by /claim-proof and /wrap-execute endpoints.
const relayerAccount = privateKeyToAccount(baseConfig.relayerPrivateKey);
const walletClientGlobal = createWalletClient({
  chain,
  transport: _buildTransport(),
  account:   relayerAccount,
});

// CTF ABI fragment for balanceOf — used to read ProxyWallet token balance after claim.
const CTF_BALANCE_ABI = [{
  name:            "balanceOf",
  type:            "function" as const,
  inputs:          [{ name: "account", type: "address" }, { name: "id", type: "uint256" }],
  outputs:         [{ name: "", type: "uint256" }],
  stateMutability: "view",
}] as const;

// Lazy singleton ProxyWalletManager — initialised on first use if env vars are present.
let _proxyWalletManager: ProxyWalletManager | null = null;
function getProxyWalletManager(): ProxyWalletManager | null {
  const factoryAddress  = process.env.PROXY_WALLET_FACTORY  as `0x${string}` | undefined;
  const wrappedCtfFactory = process.env.WRAPPED_CTF_FACTORY as `0x${string}` | undefined;
  const ctfAddress      = baseConfig.ctfAddress;
  if (!factoryAddress || !wrappedCtfFactory || !ctfAddress) return null;
  if (!_proxyWalletManager) {
    _proxyWalletManager = new ProxyWalletManager({
      factoryAddress,
      wrappedCtfFactory,
      ctfAddress,
      walletClient: walletClientGlobal,
      publicClient,
      chainId: baseConfig.chainId,
    });
    console.log("[Relayer] ProxyWalletManager initialised");
  }
  return _proxyWalletManager;
}

const BATCH_OPENED_EVENT = parseAbiItem(
  "event BatchOpened(uint256 indexed batchId, bytes32 indexed marketId, uint256 openedAt)",
);
const BATCH_CLOSED_EVENT = parseAbiItem(
  "event BatchClosed(uint256 indexed batchId, uint256 commitmentCount)",
);
const BATCH_SETTLED_EVENT = parseAbiItem(
  "event BatchSettled(uint256 indexed batchId, uint256 clearingPrice, uint256 filledYesBuyVol, uint256 filledNoBuyVol, uint256 filledYesSellQty, uint256 filledNoSellQty, uint256 splitQty, uint256 mergeQty)",
);

let fromBlock = 0n;
let _pollLogErrCount = 0;

// ── Permanent failure tracking ─────────────────────────────────────────────────
// Batches that can never be settled (e.g. commitment hash computed with wrong
// marketId). Persisted to Redis so they survive relayer restarts.
const permanentlyFailedBatches = new Set<string>();
let _failRedis: any = null;

async function initFailedBatchesStore(): Promise<void> {
  if (!baseConfig.redisUrl) return;
  try {
    const { default: Redis } = await import("ioredis");
    _failRedis = new Redis(baseConfig.redisUrl, { maxRetriesPerRequest: 3, lazyConnect: true });
    await _failRedis.connect();
    const members: string[] = await _failRedis.smembers("predacy:failed_batches");
    for (const m of members) permanentlyFailedBatches.add(m);
    if (members.length > 0) {
      console.log(`[Relayer] Loaded ${members.length} permanently-failed batch(es) from Redis: ${members.join(", ")}`);
    }
  } catch (err) {
    console.warn("[Relayer] Could not load failed-batches from Redis (non-fatal):", (err as any)?.message);
    _failRedis = null;
  }
}

// ── Wallet history store ──────────────────────────────────────────────────────
// Separate Redis connection for wallet-indexed order summaries.
// Keyed as `predacy:wallet-history:{walletAddress}` (hash of commitment → JSON).
// 90-day TTL so users can access history from any device long-term.

let _historyRedis: any = null;

async function getHistoryRedis(): Promise<any | null> {
  if (!baseConfig.redisUrl) return null;
  if (_historyRedis) return _historyRedis;
  const { default: Redis } = await import("ioredis");
  _historyRedis = new Redis(baseConfig.redisUrl, { maxRetriesPerRequest: 3, lazyConnect: true });
  _historyRedis.on("error", (e: Error) => console.error("[HistoryRedis] Error:", e.message));
  await _historyRedis.connect();
  return _historyRedis;
}

interface WalletHistoryEntry {
  commitment:     string;
  batchId:        string;
  side:           number;  // OrderSide: 0=YES_BUY, 1=YES_SELL, 2=NO_BUY, 3=NO_SELL (v8)
  amount:         string;
  limitPrice:     string;
  salt:           string;
  marketId:       string;
  marketQuestion: string | null;
  timestamp:      number;
}

async function saveWalletHistoryEntry(walletAddr: string, entry: WalletHistoryEntry): Promise<void> {
  const r = await getHistoryRedis();
  if (!r) return;
  const hKey = `predacy:wallet-history:${walletAddr}`;
  await r.hset(hKey, entry.commitment, JSON.stringify(entry));
  await r.expire(hKey, 90 * 24 * 3600); // 90-day TTL
}

// ── Requeue status store ──────────────────────────────────────────────────────
// Lightweight per-commitment event log so the frontend can poll for requeue events.
// Key: predacy:requeue-status:{commitment_lowercase}
// Value: JSON — latest status event for this commitment
// TTL: 30 days (order lifecycle ends long before that)

export interface RequeueStatusRecord {
  status:         "requeued" | "failed";   // 'failed' = no_auths (permanently dropped)
  fromBatch:      string;
  toBatch?:       string;                  // present when status='requeued'
  remainingAuths: number;
  timestamp:      number;
}

async function saveRequeueStatuses(results: RequeueResult[]): Promise<void> {
  const r = await getHistoryRedis();
  if (!r || results.length === 0) return;

  const pipeline = r.pipeline();
  for (const res of results) {
    if (res.status !== "requeued" && res.status !== "no_auths") continue;
    const record: RequeueStatusRecord = {
      status:         res.status === "requeued" ? "requeued" : "failed",
      fromBatch:      res.fromBatchId.toString(),
      toBatch:        res.toBatchId?.toString(),
      remainingAuths: res.remainingAuths,
      timestamp:      Date.now(),
    };
    const key = `predacy:requeue-status:${res.commitment.toLowerCase()}`;
    pipeline.set(key, JSON.stringify(record));
    pipeline.expire(key, 30 * 24 * 3600); // 30-day TTL
  }
  await pipeline.exec();
}

async function getRequeueStatus(commitment: string): Promise<RequeueStatusRecord | null> {
  const r = await getHistoryRedis();
  if (!r) return null;
  const raw = await r.get(`predacy:requeue-status:${commitment.toLowerCase()}`);
  if (!raw) return null;
  try { return JSON.parse(raw) as RequeueStatusRecord; } catch { return null; }
}

async function markPermanentlyFailed(batchId: bigint): Promise<void> {
  const id = batchId.toString();
  permanentlyFailedBatches.add(id);
  if (_failRedis) {
    await _failRedis.sadd("predacy:failed_batches", id).catch(() => {});
  }
  console.warn(`[Relayer] Batch ${batchId} marked permanently failed — will not retry across restarts`);
}

async function onSettleFail(state: MarketState, marketKey: string, batchId: bigint, err: unknown) {
  const key = batchId.toString();
  const msg = (err as any)?.message ?? String(err);

  // UNRESOLVABLE means the order data is irrecoverable (wrong commitment hash,
  // Redis data lost, etc.). Don't waste retries — mark immediately and skip.
  const isUnresolvable = msg.includes("UNRESOLVABLE");
  const n   = (state.settleFailures.get(key) ?? 0) + 1;
  state.settleFailures.set(key, n);
  console.error(`[Relayer] processBatch ${batchId} (market ${marketKey}) failed (attempt ${n}/3):`, msg);

  if (n >= 3 || isUnresolvable) {
    // Before permanently failing, do a final on-chain status check.
    // If lockFunds mined AFTER the receipt-check timeout, the batch will be LOCKED even
    // though processBatch thinks it failed.  Rescue it by re-triggering processBatch
    // (which will skip lockFunds and proceed to CLOB + settleBatch) instead of abandoning.
    if (!isUnresolvable) {
      try {
        const batchInfo = await publicClient.readContract({
          address: baseConfig.vaultAddress,
          abi:     BATCH_VAULT_ABI,
          functionName: "getBatch",
          args:    [batchId],
        }) as { status: number };
        const LOCKED = 2;
        if (batchInfo.status === LOCKED) {
          console.warn(
            `[Relayer] Batch ${batchId} is LOCKED on-chain (lockFunds mined after receipt timeout) — ` +
            `rescuing: will skip lockFunds and proceed to settleBatch`,
          );
          state.settleFailures.delete(key);
          if (!state.processingBatch) {
            state.processingBatch = true;
            state.settlingBatchId = batchId;
            state.processor.processBatch(batchId)
              .then(() => { state.settleFailures.delete(key); })
              .catch(async (rescueErr) => { await onSettleFail(state, marketKey, batchId, rescueErr); })
              .finally(() => { state.processingBatch = false; state.settlingBatchId = null; });
          }
          return;
        }
      } catch (checkErr: any) {
        console.warn(`[Relayer] Final status check for batch ${batchId} failed (continuing to permanently fail):`, checkErr.message);
      }
    }

    console.warn(`[Relayer] Batch ${batchId} giving up after ${n} attempt(s) — force-opening next batch`);
    await markPermanentlyFailed(batchId);
    state.settleFailures.delete(key);
    if (!state.openingBatch) {
      state.openingBatch = true;
      const marketId = marketKey as `0x${string}`;
      try {
        state.currentBatchId = await state.processor.openBatch(marketId);
        batchToMarket.set(state.currentBatchId.toString(), marketKey);
        console.log(`[Relayer] Force-opened batch ${state.currentBatchId} (skipped unresolvable ${batchId})`);
      } catch (e: any) {
        // Same pattern as ensureMarket: Alchemy strips revert reasons, so don't rely on message text.
        try {
          const existingId = await publicClient.readContract({
            address: baseConfig.vaultAddress,
            abi:     BATCH_VAULT_ABI,
            functionName: "getCurrentBatchId",
            args:    [marketId],
          }) as bigint;
          if (existingId > 0n) {
            state.currentBatchId = existingId;
            batchToMarket.set(state.currentBatchId.toString(), marketKey);
            console.log(`[Relayer] Next batch already open: ${state.currentBatchId}`);
          } else {
            console.error("[Relayer] openBatch (force-skip) failed:", e);
          }
        } catch (inner: any) {
          console.error("[Relayer] openBatch (force-skip) failed:", e);
          console.error("[Relayer] Fallback getCurrentBatchId also failed:", inner.message);
        }
      } finally { state.openingBatch = false; }
    }
  }
}

/**
 * Seal the current batch for a market (timer expiry OR cap hit) and pipeline
 * the next one. Safe to fire-and-forget from the /order handler.
 *
 * Flow: closeBatch() → openBatch() (pipeline) → processBatch() (background)
 */
async function sealBatch(state: MarketState, marketId: `0x${string}`, marketKey: string): Promise<void> {
  if (state.closingBatch || state.processingBatch || state.currentBatchId === null) return;
  state.closingBatch         = true;
  state.batchRunningUsdMicro = 0n;   // reset for the next batch
  const closingId = state.currentBatchId;

  try {
    await state.processor.closeBatch();
  } catch (err) {
    console.error(`[Relayer] sealBatch closeBatch (${marketKey}) failed:`, err);
    state.closingBatch = false;
    return;
  }

  // Pipeline: open next batch immediately so new orders don't have to wait
  state.openingBatch = true;
  try {
    state.currentBatchId = await state.processor.openBatch(marketId);
    batchToMarket.set(state.currentBatchId.toString(), marketKey);
    console.log(`[Relayer] Opened batch ${state.currentBatchId} for market ${marketKey} (pipelined)`);
  } catch (err: any) {
    if (err.message?.includes("batch already open")) {
      state.currentBatchId = await publicClient.readContract({
        address:      baseConfig.vaultAddress,
        abi:          BATCH_VAULT_ABI,
        functionName: "getCurrentBatchId",
        args:         [marketId],
      }) as bigint;
      batchToMarket.set(state.currentBatchId.toString(), marketKey);
      console.log(`[Relayer] Next batch already open: ${state.currentBatchId} (market ${marketKey})`);
    } else {
      console.error(`[Relayer] openBatch (pipeline, ${marketKey}) failed:`, err);
    }
  } finally {
    state.openingBatch = false;
    state.closingBatch = false;
  }

  // Settle old batch in background — ZK proof generation is non-blocking
  if (!state.processingBatch) {
    state.processingBatch = true;
    state.settlingBatchId = closingId;
    console.log(`[Relayer] Settling batch ${closingId} (market ${marketKey}) in background`);
    state.processor.processBatch(closingId)
      .then(async ({ excludedOrders }) => {
        state.settleFailures.delete(closingId.toString());
        // Auto-requeue excluded buy orders into the newly-opened batch.
        // Each excluded order carries pre-signed CommitOrder sigs (nonce+1, nonce+2)
        // signed by the ephemeral wallet at submission time — no user interaction needed.
        if (excludedOrders.length > 0) {
          console.log(`[Relayer] Auto-requeueing ${excludedOrders.length} excluded order(s) for market ${marketKey}`);
          const results = await state.processor.requeueExcludedOrders(excludedOrders, closingId);
          // Persist status for frontend polling (GET /order-status/:commitment)
          saveRequeueStatuses(results).catch(() => {});
        }
      })
      .catch((err) => onSettleFail(state, marketKey, closingId, err))
      .finally(() => { state.processingBatch = false; state.settlingBatchId = null; });
  }
}

const poll = async () => {
  if (missingVars.length > 0) return;
  try {
    const toBlock = (await publicClient.getBlockNumber()) - 2n; // avoid dRPC "Unknown block" (code 26) for chain-tip blocks
    if (toBlock < fromBlock) return;

    let closedLogs: any[]  = [];
    let settledLogs: any[] = [];
    try {
      [closedLogs, settledLogs] = await Promise.all([
        publicClient.getLogs({ address: baseConfig.vaultAddress, event: BATCH_CLOSED_EVENT,  fromBlock, toBlock }),
        publicClient.getLogs({ address: baseConfig.vaultAddress, event: BATCH_SETTLED_EVENT, fromBlock, toBlock }),
      ]);
      fromBlock = toBlock + 1n;
      _pollLogErrCount = 0;
    } catch (logErr: any) {
      _pollLogErrCount++;
      if (_pollLogErrCount === 1 || _pollLogErrCount % 12 === 0) {
        console.error(`[Relayer] getLogs failed (${_pollLogErrCount}×), blocks ${fromBlock}–${toBlock}:`, logErr?.shortMessage ?? logErr);
      } else {
        console.warn(`[Relayer] getLogs failed (${_pollLogErrCount}×) — retrying next poll`);
      }
      // Fall through to status-based polling below
    }

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

        const OPEN = 0, SETTLING = 1, LOCKED = 2, SETTLED = 3;

        if (batchInfo.status === OPEN) {
          const nowSec    = Math.floor(Date.now() / 1000);
          const windowSec = baseConfig.batchWindowMs / 1000;

          // Evict idle markets: OPEN for > 2× window with zero orders AND no in-flight
          // order tx.  The lastOrderSubmitAt guard prevents evicting a market whose
          // commitmentCount is still 0 on-chain while a commitSellOrderFor / commitOrderFor
          // tx is pending — without it the poll loop races the tx confirmation window and
          // evicts the market just before the first order lands, leaving the batch stuck OPEN.
          const recentSubmit = nowSec <= state.lastOrderSubmitAt + windowSec;
          if (batchInfo.commitmentCount === 0n && nowSec >= Number(batchInfo.openedAt) + windowSec * 2 && !recentSubmit) {
            console.log(`[Relayer] Evicting idle market ${marketKey} — no orders in ${windowSec * 2}s`);
            activeMarkets.delete(marketKey);
            continue;
          }

          // Auto-close once window has elapsed AND there's at least one order
          if (nowSec >= Number(batchInfo.openedAt) + windowSec && batchInfo.commitmentCount > 0n) {
            console.log(`[Relayer] Batch ${state.currentBatchId} (market ${marketKey}) window expired (${batchInfo.commitmentCount} orders) — closing`);
            sealBatch(state, marketKey as `0x${string}`, marketKey)
              .catch((err) => console.error(`[Relayer] sealBatch (timer, ${marketKey}) failed:`, (err as any).message));
          }
        } else if (batchInfo.status === SETTLING) {
          // Fallback: batch found SETTLING without a background promise (edge case / stale state)
          const settlingId = state.currentBatchId!;

          // Skip permanently failed batches — they can never be settled
          if (permanentlyFailedBatches.has(settlingId.toString())) continue;

          state.processingBatch = true;
          state.settlingBatchId = settlingId;
          console.log(`[Relayer] Batch ${settlingId} (market ${marketKey}) is SETTLING — processing`);
          state.processor.processBatch(settlingId)
            .then(async ({ excludedOrders }) => {
              state.settleFailures.delete(settlingId.toString());
              if (excludedOrders.length > 0) {
                console.log(`[Relayer] Auto-requeueing ${excludedOrders.length} excluded order(s) for market ${marketKey}`);
                const results = await state.processor.requeueExcludedOrders(excludedOrders, settlingId);
                saveRequeueStatuses(results).catch(() => {});
              }
            })
            .catch((err) => onSettleFail(state, marketKey, settlingId, err))
            .finally(() => { state.processingBatch = false; state.settlingBatchId = null; });
        } else if (batchInfo.status === LOCKED) {
          // LOCKED = between lockFunds() and settleBatch() — two-phase settlement in progress.
          // The event-driven path (BatchProcessor) is handling it; nothing to do here.
          void LOCKED; // suppress unused-var warning
        } else if (batchInfo.status === SETTLED && !state.openingBatch) {
          // Batch settled but event was missed — open next batch directly
          state.openingBatch = true;
          console.log(`[Relayer] Batch ${state.currentBatchId} (market ${marketKey}) SETTLED (event missed) — opening next batch`);
          const marketId = marketKey as `0x${string}`;
          try {
            state.currentBatchId = await state.processor.openBatch(marketId);
            batchToMarket.set(state.currentBatchId.toString(), marketKey);
          } catch (err: any) {
            if (err.message?.includes("batch already open")) {
              state.currentBatchId = await publicClient.readContract({
                address: baseConfig.vaultAddress,
                abi:     BATCH_VAULT_ABI,
                functionName: "getCurrentBatchId",
                args:    [marketId],
              }) as bigint;
              batchToMarket.set(state.currentBatchId.toString(), marketKey);
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
      const [targetState, targetKey] = findMarketByBatchId(batchId);
      if (!targetState || !targetKey) {
        console.warn(`[Relayer] BatchClosed ${batchId} — no matching active market, skipping`);
        continue;
      }
      if (targetState.processingBatch) {
        // Already settling in background (pipelined) — no-op
        console.log(`[Relayer] BatchClosed ${batchId} (market ${targetKey}) — already settling (pipelined), skipping`);
        continue;
      }
      // Fallback: not yet settling (e.g. pipeline openBatch step failed) — start now
      targetState.processingBatch = true;
      targetState.settlingBatchId = batchId;
      console.log(`[Relayer] BatchClosed ${batchId} (market ${targetKey}, ${log.args.commitmentCount} orders) — settling`);
      targetState.processor.processBatch(batchId)
        .then(() => { targetState!.settleFailures.delete(batchId.toString()); })
        .catch((err) => onSettleFail(targetState!, targetKey!, batchId, err))
        .finally(() => { targetState!.processingBatch = false; targetState!.settlingBatchId = null; });
    }

    // ── BatchSettled → open next batch (non-pipelined fallback only) ─────────
    for (const log of settledLogs) {
      const batchId = log.args.batchId as bigint;
      const [targetState, targetKey] = findMarketByBatchId(batchId);
      batchToMarket.delete(batchId.toString()); // clean up reverse index

      if (!targetState || !targetKey) {
        console.warn(`[Relayer] BatchSettled ${batchId} — no matching active market`);
        continue;
      }

      // Pipelined: next batch already opened at closeBatch time — nothing to do
      if (targetState.currentBatchId !== batchId) {
        console.log(`[Relayer] BatchSettled ${batchId} (market ${targetKey}) — next batch ${targetState.currentBatchId} already open`);
        continue;
      }

      // Non-pipelined fallback (e.g. restart recovery): currentBatchId === batchId → open next batch
      if (targetState.openingBatch) continue;
      console.log(`[Relayer] BatchSettled ${batchId} (market ${targetKey}) — opening next batch`);
      targetState.openingBatch = true;
      const marketId = targetKey as `0x${string}`;
      try {
        targetState.currentBatchId = await targetState.processor.openBatch(marketId);
        batchToMarket.set(targetState.currentBatchId.toString(), targetKey);
      } catch (err: any) {
        console.error(`[Relayer] openBatch (post-settle event, market ${targetKey}) failed:`, err);
        if (err.message?.includes("batch already open")) {
          targetState.currentBatchId = await publicClient.readContract({
            address: baseConfig.vaultAddress,
            abi:     BATCH_VAULT_ABI,
            functionName: "getCurrentBatchId",
            args:    [marketId],
          }) as bigint;
          batchToMarket.set(targetState.currentBatchId.toString(), targetKey);
        } else {
          await new Promise((r) => setTimeout(r, 5_000));
          try {
            targetState.currentBatchId = await targetState.processor.openBatch(marketId);
            batchToMarket.set(targetState.currentBatchId.toString(), targetKey);
          } catch (e) { console.error(`[Relayer] openBatch retry (market ${targetKey}) failed:`, e); }
        }
      } finally { targetState.openingBatch = false; }
    }
  } catch (err) {
    console.error("[Relayer] poll error:", err);
  }
};

// ── Startup recovery: re-process any SETTLING batches from before restart ──────
/**
 * getLogs in chunks to avoid public-RPC block-range limits.
 * Handles Alchemy free-tier (10-block max) and public RPCs (~2000 blocks) automatically.
 * On range-too-large errors: halves chunk size down to MIN_CHUNK, then retries with delay.
 * On 503/transient errors: waits 2s and retries once before throwing.
 */
const MIN_CHUNK = 10n;
async function getLogsChunked(
  params: Omit<Parameters<typeof publicClient.getLogs>[0], "fromBlock" | "toBlock">,
  fromBlock: bigint,
  toBlock:   bigint,
  chunkSize  = 2_000n, // start generous; auto-halves on range errors down to MIN_CHUNK
) {
  const all: Awaited<ReturnType<typeof publicClient.getLogs>> = [];
  let from = fromBlock;
  let currentChunk = chunkSize;
  while (from <= toBlock) {
    const end = from + currentChunk - 1n < toBlock ? from + currentChunk - 1n : toBlock;
    try {
      const chunk = await publicClient.getLogs({ ...params, fromBlock: from, toBlock: end });
      all.push(...chunk);
      from = end + 1n;
      // Brief pause when using small chunks to avoid Alchemy free-tier rate limits
      if (currentChunk <= MIN_CHUNK) await new Promise(r => setTimeout(r, 60));
    } catch (err: unknown) {
      const msg = String(err);
      const isRangeErr = msg.includes("range") || msg.includes("limit") || msg.includes("exceed") ||
                         (msg.includes("400") && !msg.includes("503"));
      const isTransient = msg.includes("503") || msg.includes("502") || msg.includes("Unable to complete");
      const isRateLimit = msg.includes("429") || msg.includes("rate") || msg.includes("too many");
      if (isRangeErr && currentChunk > MIN_CHUNK) {
        // Halve chunk size and retry this window (don't advance `from`)
        currentChunk = currentChunk / 2n < MIN_CHUNK ? MIN_CHUNK : currentChunk / 2n;
        continue;
      } else if (isTransient || isRateLimit) {
        // Brief backoff for transient gateway errors or rate limits, then retry same window
        const delay = isRateLimit ? 5_000 : 2_000;
        await new Promise(r => setTimeout(r, delay));
        continue;
      } else {
        throw err;
      }
    }
  }
  return all;
}

// Scans BatchClosed events from the last ~70 h and finds any that never emitted
// BatchSettled. For each one, reconstructs the MarketState and retriggers
// processBatch() so users' USDC isn't stuck after a Railway redeploy.

// VAULT_DEPLOYED_BLOCK: optional env var to limit getLogs scans to since-deployment.
// Without it, scans the last 50 000 blocks (~28 h on mainnet). With it, scans from
// the deployment block — much fewer RPC calls, critical for Alchemy free-tier users.
const VAULT_DEPLOYED_BLOCK = process.env.VAULT_DEPLOYED_BLOCK
  ? BigInt(process.env.VAULT_DEPLOYED_BLOCK)
  : null;

async function recoverSettlingBatches() {
  if (missingVars.length > 0) return;
  console.log("[Relayer] Scanning for SETTLING/LOCKED batches to recover...");
  try {
    const toBlock  = await publicClient.getBlockNumber();
    // ~50 000 blocks ≈ 28 h on Polygon mainnet (2 s/block).
    // Set VAULT_DEPLOYED_BLOCK env var to limit scan to since-deployment (much faster
    // on Alchemy free-tier which allows only 10 blocks per getLogs request).
    const defaultFrom = toBlock > 50_000n ? toBlock - 50_000n : 0n;
    const scanFrom    = VAULT_DEPLOYED_BLOCK && VAULT_DEPLOYED_BLOCK > defaultFrom
      ? VAULT_DEPLOYED_BLOCK
      : defaultFrom;
    console.log(`[Relayer] Settling scan: blocks ${scanFrom}→${toBlock} (${toBlock - scanFrom} blocks)`);

    const [closedLogs, settledLogs] = await Promise.all([
      getLogsChunked({ address: baseConfig.vaultAddress, event: BATCH_CLOSED_EVENT  }, scanFrom, toBlock),
      getLogsChunked({ address: baseConfig.vaultAddress, event: BATCH_SETTLED_EVENT }, scanFrom, toBlock),
    ]) as [
      Array<{ args: { batchId?: bigint; commitmentCount?: bigint } }>,
      Array<{ args: { batchId?: bigint } }>,
    ];

    const settledIds = new Set(settledLogs.map((l) => (l.args.batchId as bigint).toString()));
    // Sort descending so newest batch wins when multiple SETTLING batches share a market key.
    // Older stuck batches (e.g. batch 25 with expired Redis data) get skipped via activeMarkets.has().
    const unsettled  = closedLogs
      .filter((l) => !settledIds.has((l.args.batchId as bigint).toString()))
      .sort((a, b) => ((b.args.batchId as bigint) > (a.args.batchId as bigint) ? 1 : -1));

    if (unsettled.length === 0) {
      console.log("[Relayer] No SETTLING/LOCKED batches found — clean startup");
      return;
    }
    console.log(`[Relayer] Found ${unsettled.length} SETTLING batch(es) to recover`);

    for (const log of unsettled) {
      const batchId = log.args.batchId as bigint;
      try {
        // Skip batches that are known to be unresolvable
        if (permanentlyFailedBatches.has(batchId.toString())) {
          console.log(`[Relayer] Batch ${batchId} is permanently failed — skipping recovery`);
          continue;
        }

        const batchInfo = await publicClient.readContract({
          address:      baseConfig.vaultAddress,
          abi:          BATCH_VAULT_ABI,
          functionName: "getBatch",
          args:         [batchId],
        }) as { marketId: `0x${string}`; status: number };

        // Accept both SETTLING (1) and LOCKED (2) — processBatch handles both.
        // LOCKED means lockFunds succeeded but CLOB/settleBatch failed; processBatch
        // will skip Phase 1 and retry the CLOB buy + settleBatch.
        if (batchInfo.status !== 1 /* SETTLING */ && batchInfo.status !== 2 /* LOCKED */) {
          console.log(`[Relayer] Batch ${batchId} status=${batchInfo.status} (not SETTLING/LOCKED) — skipping`);
          continue;
        }

        const marketId = batchInfo.marketId;
        const key      = marketId.toLowerCase();
        if (activeMarkets.has(key)) continue; // already tracked

        const state = createMarketState(marketId);
        state.currentBatchId  = batchId;
        state.settlingBatchId = batchId;
        state.processingBatch = true;
        activeMarkets.set(key, state);
        batchToMarket.set(batchId.toString(), key);
        const phaseLabel = batchInfo.status === 2 ? "LOCKED (CLOB retry)" : "SETTLING";
        console.log(`[Relayer] Recovering ${phaseLabel} batch ${batchId} for market ${marketId}`);

        // Trigger settlement immediately in background
        state.processor.processBatch(batchId)
          .then(() => {
            state.settleFailures.delete(batchId.toString());
            console.log(`[Relayer] Recovery: settled batch ${batchId} (market ${marketId})`);
          })
          .catch(async (err) => { await onSettleFail(state, key, batchId, err); })
          .finally(() => { state.processingBatch = false; state.settlingBatchId = null; });
      } catch (err) {
        console.error(`[Relayer] Recovery: failed to inspect batch ${batchId}:`, err);
      }
    }
  } catch (err) {
    console.error("[Relayer] recoverSettlingBatches failed:", err);
  }
}

// ── Startup recovery: re-register any markets with OPEN (but expired) batches ──
// Scans BatchOpened events, removes those that have a BatchClosed, and re-adds
// each remaining market to activeMarkets so the poll loop closes & settles them.
// This means any market a user has ever traded is automatically recovered on
// restart — no MARKET_ID env var or manual /warm call required.

async function recoverOpenBatches() {
  if (missingVars.length > 0) return;
  console.log("[Relayer] Scanning for OPEN batches to recover...");
  try {
    const toBlock     = await publicClient.getBlockNumber();
    const defaultFrom = toBlock > 50_000n ? toBlock - 50_000n : 0n;
    const scanFrom    = VAULT_DEPLOYED_BLOCK && VAULT_DEPLOYED_BLOCK > defaultFrom
      ? VAULT_DEPLOYED_BLOCK
      : defaultFrom;
    console.log(`[Relayer] Open scan: blocks ${scanFrom}→${toBlock} (${toBlock - scanFrom} blocks)`);

    const [openedLogs, closedLogs] = await Promise.all([
      getLogsChunked({ address: baseConfig.vaultAddress, event: BATCH_OPENED_EVENT }, scanFrom, toBlock),
      getLogsChunked({ address: baseConfig.vaultAddress, event: BATCH_CLOSED_EVENT }, scanFrom, toBlock),
    ]) as [
      Array<{ args: { batchId?: bigint; marketId?: `0x${string}`; openedAt?: bigint } }>,
      Array<{ args: { batchId?: bigint; commitmentCount?: bigint } }>,
    ];

    const closedIds = new Set(closedLogs.map((l) => (l.args.batchId as bigint).toString()));
    // Keep only batches that were opened but never closed = still OPEN
    const stillOpen = openedLogs.filter((l) => !closedIds.has((l.args.batchId as bigint).toString()));

    if (stillOpen.length === 0) {
      console.log("[Relayer] No OPEN batches to recover");
      return;
    }

    console.log(`[Relayer] Found ${stillOpen.length} OPEN batch(es) to recover`);
    for (const log of stillOpen) {
      const batchId  = log.args.batchId  as bigint;
      const marketId = log.args.marketId as `0x${string}`;
      const key      = marketId.toLowerCase();

      if (activeMarkets.has(key)) continue; // already tracked (e.g. by recoverSettlingBatches)

      // Confirm on-chain status is still OPEN (0)
      const batchInfo = await publicClient.readContract({
        address:      baseConfig.vaultAddress,
        abi:          BATCH_VAULT_ABI,
        functionName: "getBatch",
        args:         [batchId],
      }) as { status: number };

      if (batchInfo.status !== 0 /* OPEN */) {
        console.log(`[Relayer] Batch ${batchId} status=${batchInfo.status} — skipping`);
        continue;
      }

      const state = createMarketState(marketId);
      state.currentBatchId = batchId;
      activeMarkets.set(key, state);
      batchToMarket.set(batchId.toString(), key);
      console.log(`[Relayer] Recovered OPEN batch ${batchId} for market ${marketId}`);
    }
  } catch (err) {
    console.error("[Relayer] recoverOpenBatches failed:", err);
  }
}

// Startup: set fromBlock, recover SETTLING + OPEN batches, pre-warm MARKET_ID if set, then begin polling
(async () => {
  try {
    fromBlock = await publicClient.getBlockNumber();
  } catch {
    fromBlock = 0n;
  }

  // Load permanently-failed batch IDs from Redis BEFORE scanning for SETTLING batches
  await initFailedBatchesStore();

  // v7.3+: ensure CTF setApprovalForAll(vault, true) + USDC approve(vault, max) are set once.
  // Required for relayer-intermediary settlement (pre-buy YES, provide USDC for net-sell).
  if (missingVars.length === 0 && baseConfig.chainId === polygon.id) {
    const tempProcessor = new BatchProcessor({ ...baseConfig, marketId: "0x0000000000000000000000000000000000000000000000000000000000000000" as `0x${string}` });
    try {
      await tempProcessor.ensureApprovals();
    } catch (err: any) {
      console.warn(`[Relayer] ensureApprovals failed (non-fatal — check CTF/USDC approval manually):`, err.message);
    }

    // v10: register NegRisk token IDs for each pre-configured market.
    // Ensures the vault distributes tradeable NegRisk tokens (not locked standard CTF tokens).
    if (PRE_WARM_MARKET_ID) {
      const mktProcessor = new BatchProcessor({ ...baseConfig, marketId: PRE_WARM_MARKET_ID });
      try {
        await mktProcessor.ensureMarketTokenIds(PRE_WARM_MARKET_ID);
      } catch (err: any) {
        console.warn(`[Relayer] ensureMarketTokenIds failed for ${PRE_WARM_MARKET_ID} (non-fatal):`, err.message);
      }
    }
  }

  // Escape hatch: RECOVER_BATCH_ID=2 forces a specific stuck SETTLING/LOCKED batch to be
  // retried immediately — runs BEFORE the slow getLogs scan so it fires within ~2s of startup
  // regardless of how long the scan takes or what HTTP requests arrive mid-scan.
  const RECOVER_BATCH_ID_ENV = process.env.RECOVER_BATCH_ID;
  if (missingVars.length === 0 && RECOVER_BATCH_ID_ENV) {
    const forceBatchId = BigInt(RECOVER_BATCH_ID_ENV);
    console.log(`[Relayer] RECOVER_BATCH_ID=${forceBatchId} — force-recovering batch immediately...`);
    try {
      const batchInfo = await publicClient.readContract({
        address:      baseConfig.vaultAddress,
        abi:          BATCH_VAULT_ABI,
        functionName: "getBatch",
        args:         [forceBatchId],
      }) as { marketId: `0x${string}`; status: number };

      // Accept SETTLING (1) and LOCKED (2) — processBatch handles both.
      if (batchInfo.status !== 1 && batchInfo.status !== 2) {
        console.log(`[Relayer] RECOVER_BATCH_ID: batch ${forceBatchId} status=${batchInfo.status} (not SETTLING/LOCKED) — skipping`);
      } else {
        if (permanentlyFailedBatches.has(forceBatchId.toString())) {
          console.log(`[Relayer] RECOVER_BATCH_ID: clearing permanently-failed flag for batch ${forceBatchId}`);
          permanentlyFailedBatches.delete(forceBatchId.toString());
          if (_failRedis) {
            await _failRedis.srem("predacy:failed_batches", forceBatchId.toString()).catch(() => {});
          }
        }
        const marketId   = batchInfo.marketId;
        const key        = marketId.toLowerCase();
        const phaseLabel = batchInfo.status === 2 ? "LOCKED" : "SETTLING";
        // activeMarkets is empty at this point (runs before scans) — always creates fresh state.
        const state = createMarketState(marketId);
        state.currentBatchId  = forceBatchId;
        state.settlingBatchId = forceBatchId;
        state.processingBatch = true;
        activeMarkets.set(key, state);
        batchToMarket.set(forceBatchId.toString(), key);
        console.log(`[Relayer] RECOVER_BATCH_ID: recovering ${phaseLabel} batch ${forceBatchId} for market ${marketId}`);
        state.processor.processBatch(forceBatchId)
          .then(() => { console.log(`[Relayer] RECOVER_BATCH_ID: settled batch ${forceBatchId}`); })
          .catch(async (err) => { await onSettleFail(state, key, forceBatchId, err); })
          .finally(() => { state.processingBatch = false; state.settlingBatchId = null; });
      }
    } catch (err) {
      console.error(`[Relayer] RECOVER_BATCH_ID: failed to recover batch ${forceBatchId}:`, err);
    }
  }

  // Start polling immediately — don't block on recovery scans.
  // recoverSettlingBatches / recoverOpenBatches run in the background; both
  // check activeMarkets.has(key) before inserting, so there are no races.
  setInterval(poll, 5_000);
  console.log("[Relayer] Polling every 5 s (multi-market mode) — recovery scans running in background");

  // Recovery scans: fire-and-forget so they don't delay the first poll tick.
  recoverSettlingBatches().catch((err: any) =>
    console.error("[Relayer] recoverSettlingBatches failed:", err.message));
  recoverOpenBatches().catch((err: any) =>
    console.error("[Relayer] recoverOpenBatches failed:", err.message));

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
})();
