"use client";

import { useState, useEffect, useCallback } from "react";
import { createPublicClient, http, keccak256, encodeAbiParameters } from "viem";
import { clsx } from "clsx";
import { BATCH_VAULT_ABI, BatchStatus, getContracts } from "@/lib/contracts";
import { ACTIVE_CHAIN } from "@/lib/chain";

const publicClient = createPublicClient({
  chain: ACTIVE_CHAIN,
  transport: http(),
});

// ── Types ─────────────────────────────────────────────────────────────────────

interface HistoricalPosition {
  batchId:        bigint;
  batchMarketId:  `0x${string}`;
  batchStatus:    BatchStatus;
  clearingPrice:  bigint;
  marketQuestion?: string;
  /** True when this is a sell commitment (not a buy-NO) */
  isSell?: boolean;
  position: {
    filledAmount: bigint;
    refundAmount: bigint;
    isBuy:        boolean;
    claimed:      boolean;
  };
  /** Number of YES tokens received (buy) or YES tokens sold (sell) — computed */
  shares?: number;
  /** True if the batch is still being settled by the relayer */
  settling?: boolean;
  /** True if the order was included in a settled batch but wasn't filled at clearing price */
  unfilled?: boolean;
  /** For unfilled buy orders: ephemeral wallet private key + address for USDC recovery */
  ephemeralKey?:     string;
  ephemeralAddress?: string;
  /** USDC amount that remains in the ephemeral wallet (for unfilled buys) */
  unfilledAmount?: bigint;
}

interface PositionsPanelProps {
  walletAddress:              `0x${string}`;
  marketId?:                  string;  // conditionId — filter positions to this market only
  currentBatchId:             bigint;
  currentBatchStatus:         BatchStatus;
  currentBatchClearingPrice:  bigint;  // needed to compute YES token count for close
  currentBatchCommitments:    Array<{ hash: `0x${string}`; amount?: bigint }>;
  onClaim:                    (batchId: bigint) => Promise<void>;
  onClosePosition?:           (yesAmount: bigint, clearingPrice: bigint) => void; // pre-fill sell form
  onMarketIdsFound?:          (ids: `0x${string}`[]) => void;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fUsdc(v: bigint) { return `$${(Number(v) / 1e6).toFixed(2)}`; }

/** YES token amount (6-decimal) that corresponds to a filled buy position. */
function computeYesAmount(filledAmount: bigint, clearingPrice: bigint): bigint {
  if (clearingPrice === 0n || filledAmount === 0n) return 0n;
  return filledAmount * 1_000_000n / clearingPrice;
}

function computeShares(filledAmount: bigint, clearingPrice: bigint): number {
  if (clearingPrice === 0n || filledAmount === 0n) return 0;
  return Number(filledAmount * 1_000_000n / clearingPrice) / 1_000_000;
}

function timeAgo(ts: number) {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60_000);
  if (mins < 1)  return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24)  return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

// ── Sub-components ────────────────────────────────────────────────────────────

function DirectionBadge({ isBuy, isSell }: { isBuy: boolean; isSell?: boolean }) {
  if (isSell) {
    return (
      <span className="text-[9px] tracking-widest uppercase px-1.5 py-0.5 border font-mono border-amber-500/40 text-amber-400 bg-amber-500/5">
        SELL
      </span>
    );
  }
  return (
    <span className={clsx(
      "text-[9px] tracking-widest uppercase px-1.5 py-0.5 border font-mono",
      isBuy
        ? "border-accent/30 text-accent bg-accent/5"
        : "border-danger/30 text-danger bg-danger/5",
    )}>
      {isBuy ? "YES" : "NO"}
    </span>
  );
}

function SkeletonRow() {
  return (
    <div className="px-4 py-3 border-b border-border/40 animate-pulse space-y-1.5">
      <div className="h-3 w-40 bg-surface/80 rounded" />
      <div className="h-2.5 w-24 bg-surface/60 rounded" />
    </div>
  );
}

// ── Position row (compact, fits in 340px panel) ───────────────────────────────
interface PositionRowProps {
  batchId:        bigint;
  position:       HistoricalPosition["position"];
  clearingPrice:  bigint;
  marketQuestion?: string;
  shares?:        number;
  onClaim:        (batchId: bigint) => Promise<void>;
  isClaiming:     boolean;
  claimError?:    string;
  isActive:       boolean;  // true = unclaimed settled; false = claimed (holding)
  isSell?:        boolean;  // true = sell order (shows SELL badge + SOLD ✓, no claim button)
  onClose?:       () => void; // pre-fills SELL form for this position
}

function PositionRow({
  batchId, position, clearingPrice, marketQuestion, shares,
  onClaim, isClaiming, claimError, isActive, isSell, onClose,
}: PositionRowProps) {

  const avgCents    = clearingPrice > 0n ? (Number(clearingPrice) / 1e4).toFixed(1) : "—";
  const filledUsdc  = Number(position.filledAmount) / 1e6;
  const sharesDisp  = shares != null ? shares.toFixed(1) : "—";

  return (
    <div className="px-4 py-3 border-b border-border/40 last:border-b-0 space-y-2">
      {/* Row header: direction badge + question */}
      <div className="flex items-start gap-2 min-w-0">
        <div className="flex-shrink-0 pt-px">
          <DirectionBadge isBuy={position.isBuy} isSell={isSell} />
        </div>
        <p className="text-[11px] text-text leading-snug line-clamp-2 min-w-0">
          {marketQuestion ?? `Batch #${batchId.toString()}`}
        </p>
      </div>

      {/* Metrics row */}
      <div className="flex items-center gap-3 flex-wrap text-[10px]">
        {clearingPrice > 0n && (
          <>
            <span className="text-muted-dim">avg <span className="text-text font-mono">{avgCents}¢</span></span>
            {shares != null && shares > 0 && (
              <span className="text-muted-dim"><span className="text-text font-mono">{sharesDisp}</span> shares</span>
            )}
            <span className="text-muted-dim">cost <span className="text-text font-mono">{fUsdc(position.filledAmount)}</span></span>
          </>
        )}
        {position.refundAmount > 0n && (
          <span className="text-muted-dim">refund <span className="text-text font-mono">{fUsdc(position.refundAmount)}</span></span>
        )}
      </div>

      {/* Action area — varies by order type and claim state */}
      {isSell ? (
        // Sell orders: USDC is paid out automatically in settleBatch — no claim step
        <span className="text-[9px] text-muted-dim tracking-widest uppercase">SOLD ✓</span>
      ) : isActive ? (
        // Buy order, unclaimed — show CLAIM POSITION button
        <div className="space-y-1">
          <button
            onClick={() => onClaim(batchId)}
            disabled={isClaiming}
            className="w-full py-1.5 border border-accent text-accent text-[10px] tracking-widest uppercase hover:bg-accent/5 transition-colors disabled:opacity-40"
          >
            {isClaiming ? (
              <span className="flex items-center justify-center gap-1.5">
                <span className="w-2.5 h-2.5 border border-current border-t-transparent rounded-full animate-spin" />
                CLAIMING…
              </span>
            ) : "CLAIM POSITION"}
          </button>
          {isClaiming && (
            <p className="text-[9px] text-muted-dim text-center">Generating ZK proof + awaiting tx (~20s)</p>
          )}
          {claimError && !isClaiming && (
            <p className="text-danger text-[10px]">{claimError}</p>
          )}
        </div>
      ) : (
        // Buy order, claimed — holding YES tokens, offer CLOSE POSITION
        <div className="space-y-1.5">
          <span className="text-[9px] text-accent/60 tracking-widest uppercase">CLAIMED ✓</span>
          {onClose && (
            <button
              onClick={onClose}
              className="w-full py-1.5 border border-border-bright text-muted text-[10px] tracking-widest uppercase hover:border-text/30 hover:text-text transition-colors"
            >
              CLOSE POSITION
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ── Activity row ──────────────────────────────────────────────────────────────
interface ActivityRowProps {
  batchId:        bigint;
  isBuy:          boolean;
  amount:         bigint;
  clearingPrice?: bigint;
  shares?:        number;
  marketQuestion?: string;
  timestamp?:     number;
  batchStatus?:   BatchStatus;
}

function ActivityRow({
  batchId, isBuy, amount, clearingPrice, shares, marketQuestion, timestamp, batchStatus,
}: ActivityRowProps) {
  const amountDisplay = isBuy
    ? fUsdc(amount)
    : `${(Number(amount) / 1e6).toFixed(2)} YES`;

  const sharesDisplay = clearingPrice && clearingPrice > 0n && isBuy && shares != null
    ? `${shares.toFixed(1)} shares`
    : null;

  return (
    <div className="px-4 py-3 border-b border-border/40 last:border-b-0 flex items-start gap-3">
      {/* Type badge */}
      <span className={clsx(
        "text-[9px] tracking-widest uppercase px-1.5 py-0.5 border font-mono flex-shrink-0 mt-0.5",
        isBuy
          ? "border-accent/30 text-accent bg-accent/5"
          : "border-danger/30 text-danger bg-danger/5",
      )}>
        {isBuy ? "BUY" : "SELL"}
      </span>

      {/* Market + batch */}
      <div className="flex-1 min-w-0 space-y-0.5">
        <p className="text-[11px] text-text leading-snug line-clamp-2">
          {marketQuestion ?? `Batch #${batchId.toString()}`}
        </p>
        {sharesDisplay && (
          <p className="text-[10px] text-muted-dim">{sharesDisplay}</p>
        )}
      </div>

      {/* Amount + time */}
      <div className="text-right flex-shrink-0 space-y-0.5">
        <p className="text-[11px] text-text font-mono tabular-nums">{amountDisplay}</p>
        <p className="text-[9px] text-muted-dim">
          {timestamp ? timeAgo(timestamp) : `#${batchId.toString()}`}
        </p>
        {batchStatus === BatchStatus.SETTLED && (
          <span className="text-[8px] text-muted-dim border border-border px-1">SETTLED</span>
        )}
      </div>
    </div>
  );
}

// ── Unfilled buy card (with ephemeral key recovery) ───────────────────────────

function UnfilledCard({ hp }: { hp: HistoricalPosition }) {
  const [copied, setCopied] = useState(false);

  const copyKey = async () => {
    if (!hp.ephemeralKey) return;
    await navigator.clipboard.writeText(hp.ephemeralKey);
    setCopied(true);
    setTimeout(() => setCopied(false), 2500);
  };

  const amountDisplay = hp.unfilledAmount != null
    ? `$${(Number(hp.unfilledAmount) / 1e6).toFixed(2)}`
    : null;

  return (
    <div className="px-4 py-3 border-b border-border/40">
      <div className="flex items-center gap-2 mb-1">
        <DirectionBadge isBuy={hp.position.isBuy} />
        <span className="text-[10px] text-muted tracking-widest uppercase">Not filled</span>
        <span className="text-[9px] text-muted-dim ml-auto">#{hp.batchId.toString()}</span>
      </div>

      {hp.marketQuestion && (
        <p className="text-[10px] text-text leading-snug line-clamp-2 mb-2">{hp.marketQuestion}</p>
      )}

      {hp.position.isBuy ? (
        <div className="space-y-2">
          <p className="text-[9px] text-muted-dim leading-snug">
            Your limit was below the batch clearing price.
            {amountDisplay && <> {amountDisplay} USDC remains in your ephemeral wallet.</>}
          </p>

          {hp.ephemeralKey && (
            <div className="space-y-1.5">
              {hp.ephemeralAddress && (
                <p className="text-[9px] text-muted-dim font-mono break-all">
                  <span className="text-muted">Address: </span>{hp.ephemeralAddress}
                </p>
              )}
              <button
                onClick={copyKey}
                className={clsx(
                  "w-full py-1.5 border text-[10px] tracking-widest uppercase transition-colors",
                  copied
                    ? "border-accent/50 text-accent/70 bg-accent/5"
                    : "border-border-bright text-muted hover:border-accent/50 hover:text-accent",
                )}
              >
                {copied ? "COPIED ✓" : "COPY RECOVERY KEY"}
              </button>
              <p className="text-[8px] text-muted-dim text-center leading-snug">
                Import this private key into MetaMask → sweep USDC back to your wallet
              </p>
            </div>
          )}
        </div>
      ) : (
        <p className="text-[9px] text-muted-dim">Sell order not filled — YES tokens returned.</p>
      )}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function PositionsPanel({
  walletAddress,
  marketId,
  currentBatchId,
  currentBatchStatus,
  currentBatchClearingPrice,
  currentBatchCommitments,
  onClaim,
  onClosePosition,
  onMarketIdsFound,
}: PositionsPanelProps) {
  const [historicalPositions, setHistoricalPositions] = useState<HistoricalPosition[]>([]);
  const [allStoredOrders,     setAllStoredOrders]     = useState<Array<{
    batchId: string; isBuy: boolean; amount: string; marketQuestion?: string;
    timestamp?: number; clearingPrice?: bigint; shares?: number; batchStatus?: BatchStatus;
  }>>([]);
  const [scanning,      setScanning]      = useState(false);
  const [claimingBatchId, setClaimingBatchId] = useState<bigint | null>(null);
  const [claimErrors,   setClaimErrors]   = useState<Record<string, string>>({});
  const [mainTab,       setMainTab]       = useState<"positions" | "activity">("positions");
  const [posTab,        setPosTab]        = useState<"active" | "closed">("active");

  // Current-batch position (fetched when settled)
  const [currentPosition, setCurrentPosition] = useState<{
    filledAmount: bigint; refundAmount: bigint; isBuy: boolean; claimed: boolean; isSell?: boolean;
  } | null>(null);

  // ── Fetch current batch position when settled ────────────────────────────────
  useEffect(() => {
    if (currentBatchStatus !== BatchStatus.SETTLED || currentBatchId === 0n) {
      setCurrentPosition(null);
      return;
    }
    let cancelled = false;
    const run = async () => {
      try {
        const storageKey  = `predacy:orders:${walletAddress.toLowerCase()}`;
        const stored: Array<{ commitment: string; batchId: string; isBuy?: boolean; isSell?: boolean }> =
          JSON.parse(localStorage.getItem(storageKey) ?? "[]");
        const myOrder = stored.find((o) => o.batchId === currentBatchId.toString());
        if (!myOrder) return;

        const contracts = getContracts(ACTIVE_CHAIN.id);
        const pos = await publicClient.readContract({
          address:      contracts.batchVault,
          abi:          BATCH_VAULT_ABI,
          functionName: "getPosition",
          args:         [currentBatchId, myOrder.commitment as `0x${string}`],
        }) as { filledAmount: bigint; refundAmount: bigint; isBuy: boolean; claimed: boolean };
        // Use localStorage isBuy (reliable) rather than contract isBuy to detect sells
        const isSellOrder = myOrder.isSell === true || myOrder.isBuy === false;
        if (!cancelled) setCurrentPosition({ ...pos, isSell: isSellOrder });
      } catch { /* RPC hiccup */ }
    };
    run();
    return () => { cancelled = true; };
  }, [currentBatchStatus, currentBatchId, walletAddress]);

  // ── Scan historical batches from localStorage ─────────────────────────────────
  const scanHistory = useCallback(async () => {
    setScanning(true);
    const contracts = getContracts(ACTIVE_CHAIN.id);
    const results: HistoricalPosition[] = [];

    let storedOrders: Array<{
      commitment: string; batchId: string; salt?: string; claimed?: boolean;
      isBuy: boolean; isSell?: boolean; amount: string; marketQuestion?: string; timestamp?: number;
      marketId?: string; ephemeralKey?: string; ephemeralAddress?: string;
    }> = [];
    const storageKey = `predacy:orders:${walletAddress.toLowerCase()}`;
    try {
      storedOrders = JSON.parse(localStorage.getItem(storageKey) ?? "[]");
      // ── Migration: any isBuy:false order is a sell (platform has no NO-buy orders).
      // Tag them with isSell:true so all downstream code can rely on the flag alone.
      const needsMigration = storedOrders.some((o) => !o.isBuy && !o.isSell);
      if (needsMigration) {
        storedOrders = storedOrders.map((o) => (!o.isBuy && !o.isSell) ? { ...o, isSell: true } : o);
        try { localStorage.setItem(storageKey, JSON.stringify(storedOrders)); } catch { /* ignore */ }
      }
    } catch { /* ignore */ }

    const historicalOrders = storedOrders
      .filter((o) => !marketId || o.marketId === marketId)
      .filter((o) => o.batchId !== currentBatchId.toString());

    // Keep raw order list for Activity tab (enriched below)
    const rawActivity: typeof allStoredOrders = historicalOrders.map((o) => ({
      batchId:       o.batchId,
      isBuy:         o.isBuy,
      amount:        o.amount,
      marketQuestion: o.marketQuestion,
      timestamp:     o.timestamp,
    }));

    await Promise.allSettled(
      historicalOrders.map(async (order) => {
        try {
          const id = BigInt(order.batchId);
          const [batchRaw, posRaw] = await Promise.all([
            publicClient.readContract({
              address:      contracts.batchVault,
              abi:          BATCH_VAULT_ABI,
              functionName: "getBatch",
              args:         [id],
            }) as Promise<{ status: number; marketId: `0x${string}`; clearingPrice: bigint }>,
            publicClient.readContract({
              address:      contracts.batchVault,
              abi:          BATCH_VAULT_ABI,
              functionName: "getPosition",
              args:         [id, order.commitment as `0x${string}`],
            }) as Promise<{ filledAmount: bigint; refundAmount: bigint; isBuy: boolean; claimed: boolean }>,
          ]);

          if (posRaw.filledAmount === 0n && posRaw.refundAmount === 0n) {
            // Enrich activity row
            const idx = rawActivity.findIndex((r) => r.batchId === order.batchId);
            if (idx >= 0) rawActivity[idx].batchStatus = batchRaw.status as BatchStatus;

            // Still add to results for SETTLING or SETTLED-but-unfilled states
            // so the user can see their order status instead of a blank panel.
            const bs = batchRaw.status as BatchStatus;
            if (bs === BatchStatus.SETTLING || bs === BatchStatus.SETTLED) {
              results.push({
                batchId:          id,
                batchMarketId:    batchRaw.marketId,
                batchStatus:      bs,
                clearingPrice:    batchRaw.clearingPrice ?? 0n,
                marketQuestion:   order.marketQuestion,
                isSell:           order.isSell === true || !order.isBuy,
                position: { filledAmount: 0n, refundAmount: 0n, isBuy: order.isBuy, claimed: false },
                shares:           0,
                settling:         bs === BatchStatus.SETTLING,
                unfilled:         bs === BatchStatus.SETTLED,
                ephemeralKey:     order.isBuy ? order.ephemeralKey     : undefined,
                ephemeralAddress: order.isBuy ? order.ephemeralAddress : undefined,
                unfilledAmount:   order.isBuy ? BigInt(order.amount)   : undefined,
              });
            }
            return;
          }

          // Check usedNullifiers for claimed state
          // Sell orders auto-settle (USDC sent in settleBatch) — they have no nullifier
          let claimed = posRaw.claimed || order.claimed === true;
          if (!claimed && order.salt && !order.isSell) {
            try {
              const nullifier = keccak256(
                encodeAbiParameters(
                  [{ type: "bytes32" }, { type: "uint256" }, { type: "bytes32" }],
                  [order.commitment as `0x${string}`, id, order.salt as `0x${string}`],
                )
              );
              claimed = await publicClient.readContract({
                address:      contracts.batchVault,
                abi:          BATCH_VAULT_ABI,
                functionName: "usedNullifiers",
                args:         [nullifier],
              }) as boolean;
              if (claimed) {
                try {
                  const sk = `predacy:orders:${walletAddress.toLowerCase()}`;
                  const all: Array<Record<string, unknown>> = JSON.parse(localStorage.getItem(sk) ?? "[]");
                  localStorage.setItem(sk, JSON.stringify(
                    all.map((o) => o.batchId === order.batchId ? { ...o, claimed: true } : o)
                  ));
                } catch { /* ignore */ }
              }
            } catch { /* leave as unclaimed */ }
          }

          const clearingPrice = batchRaw.clearingPrice ?? 0n;
          const shares = computeShares(posRaw.filledAmount, clearingPrice);

          // Enrich activity row
          const idx = rawActivity.findIndex((r) => r.batchId === order.batchId);
          if (idx >= 0) {
            rawActivity[idx].clearingPrice = clearingPrice;
            rawActivity[idx].shares        = shares;
            rawActivity[idx].batchStatus   = batchRaw.status as BatchStatus;
          }

          results.push({
            batchId:        id,
            batchMarketId:  batchRaw.marketId,
            batchStatus:    batchRaw.status as BatchStatus,
            clearingPrice,
            marketQuestion: order.marketQuestion,
            isSell:         order.isSell === true || !order.isBuy,
            position:       { ...posRaw, claimed },
            shares,
          });
        } catch { /* batch doesn't exist or RPC hiccup — skip */ }
      })
    );

    results.sort((a, b) => (a.batchId > b.batchId ? -1 : 1));
    setHistoricalPositions(results);
    setAllStoredOrders(rawActivity);
    setScanning(false);

    const uniqueMarketIds = [...new Set(results.map((r) => r.batchMarketId))];
    onMarketIdsFound?.(uniqueMarketIds);
  }, [currentBatchId, marketId, walletAddress, onMarketIdsFound]);

  useEffect(() => {
    scanHistory();
  }, [scanHistory]);

  // ── Re-scan periodically while any historical position is still settling ──────
  // scanHistory() runs once on mount and when currentBatchId changes. But if the
  // relayer tx hadn't landed yet when scanHistory ran, the batch stays `settling:
  // true` forever. This re-polls every 5 s until the batch reads as SETTLED.
  useEffect(() => {
    const hasSettling = historicalPositions.some((hp) => hp.settling);
    if (!hasSettling) return;
    const iv = setInterval(scanHistory, 5_000);
    return () => clearInterval(iv);
  }, [historicalPositions, scanHistory]);

  const handleClaim = async (batchId: bigint) => {
    setClaimingBatchId(batchId);
    const key = batchId.toString();
    setClaimErrors((prev) => { const n = { ...prev }; delete n[key]; return n; });
    try {
      await onClaim(batchId);
      if (batchId === currentBatchId) {
        setCurrentPosition((p) => p ? { ...p, claimed: true } : p);
      } else {
        setHistoricalPositions((prev) =>
          prev.map((hp) => hp.batchId === batchId
            ? { ...hp, position: { ...hp.position, claimed: true } }
            : hp
          )
        );
      }
      scanHistory();
    } catch (e: any) {
      if (e?.code !== 4001) {
        setClaimErrors((prev) => ({ ...prev, [key]: e.message ?? "Claim failed" }));
      }
    } finally {
      setClaimingBatchId(null);
    }
  };

  // ── Derived data ─────────────────────────────────────────────────────────────

  // Current batch: does the user have a sealed order this session?
  const hasCurrentOrder = currentBatchCommitments.length > 0;

  // Current batch position: settled and has a fill (claimed or unclaimed).
  // Shown in Active tab with claim button when unclaimed, "CLAIMED ✓" when claimed.
  const currentPositionVisible =
    currentBatchStatus === BatchStatus.SETTLED &&
    currentPosition !== null &&
    (currentPosition.filledAmount > 0n || currentPosition.refundAmount > 0n);

  // A current-batch sell should appear in Closed, not Active.
  // isSell is set reliably from localStorage (order.isSell || !order.isBuy) in the useEffect above.
  const currentIsSell = currentPositionVisible && currentPosition?.isSell === true;
  const currentPositionInActive = currentPositionVisible && !currentIsSell;
  const currentPositionInClosed = currentPositionVisible && currentIsSell;

  // Keep legacy alias used by a few downstream checks (unclaimed buy only)
  const currentIsActive = currentPositionInActive && !currentPosition?.claimed;

  // Current batch for Activity tab
  const currentForActivity = hasCurrentOrder ? currentBatchCommitments[0] : null;

  // Active = filled YES buy orders (claimed or unclaimed — user still holds YES tokens).
  // hp.isSell is derived from order.isSell||!order.isBuy so it correctly catches legacy sells.
  const activePositions = historicalPositions.filter(
    (hp) => hp.batchStatus === BatchStatus.SETTLED && !hp.unfilled && !hp.settling && !hp.isSell
  );
  // Pending = still being settled or not filled at clearing price
  const pendingPositions = historicalPositions.filter(
    (hp) => hp.settling || hp.unfilled
  );
  // Closed = settled sell orders (isSell is now reliably set for all sell entries).
  const closedPositions = historicalPositions.filter(
    (hp) => hp.batchStatus === BatchStatus.SETTLED && !hp.settling && hp.isSell
  );

  // Activity = all historical stored orders (newest first) + current if exists
  // already newest-first from localStorage

  // ── Render ───────────────────────────────────────────────────────────────────
  return (
    <div className="flex-1 flex flex-col overflow-hidden">

      {/* ── Top-level tabs ─────────────────────────────────────────────────── */}
      <div className="border-b border-border flex items-center px-1 flex-shrink-0">
        {(["positions", "activity"] as const).map((tab) => (
          <button
            key={tab}
            type="button"
            onClick={() => setMainTab(tab)}
            className={clsx(
              "px-3 py-2.5 text-[10px] tracking-widest uppercase transition-colors border-b-2",
              mainTab === tab
                ? "border-text/40 text-text"
                : "border-transparent text-muted hover:text-text",
            )}
          >
            {tab === "positions" ? "Positions" : "Activity"}
          </button>
        ))}
      </div>

      {/* ── POSITIONS TAB ──────────────────────────────────────────────────── */}
      {mainTab === "positions" && (
        <div className="flex-1 flex flex-col overflow-hidden">

          {/* Active / Closed sub-tabs */}
          <div className="border-b border-border/50 flex items-center px-4 gap-4 flex-shrink-0">
            {(["active", "closed"] as const).map((sub) => {
              const count = sub === "active"
                ? activePositions.length + pendingPositions.length + (currentPositionInActive ? 1 : 0)
                : closedPositions.length + (currentPositionInClosed ? 1 : 0);
              return (
                <button
                  key={sub}
                  type="button"
                  onClick={() => setPosTab(sub)}
                  className={clsx(
                    "py-2 text-[10px] tracking-widest uppercase transition-colors flex items-center gap-1.5",
                    posTab === sub ? "text-text" : "text-muted hover:text-text",
                  )}
                >
                  {sub === "active" ? "Active" : "Closed"}
                  {count > 0 && (
                    <span className={clsx(
                      "text-[8px] px-1 py-0.5 border tabular-nums",
                      posTab === sub ? "border-text/30 text-text" : "border-border text-muted-dim",
                    )}>{count}</span>
                  )}
                </button>
              );
            })}
          </div>

          {/* ── ACTIVE sub-tab ───────────────────────────────────────────── */}
          {posTab === "active" && (
          <div className="flex-1 overflow-y-auto">

              {/* Current batch status */}
              {currentBatchStatus === BatchStatus.OPEN && hasCurrentOrder && (
                <div className="px-4 py-3 border-b border-border/40 bg-accent/5">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />
                    <span className="text-[10px] text-accent tracking-widest uppercase">ORDER SEALED</span>
                    <span className="text-[9px] text-muted-dim ml-auto">Batch #{currentBatchId.toString()}</span>
                  </div>
                  <p className="text-[10px] text-muted-dim">Waiting for batch to close and settle…</p>
                </div>
              )}

              {currentBatchStatus === BatchStatus.SETTLING && hasCurrentOrder && (
                <div className="px-4 py-3 border-b border-border/40">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="w-2 h-2 border border-blue/60 border-t-transparent rounded-full animate-spin flex-shrink-0" />
                    <span className="text-[10px] text-blue/70 tracking-wide">Relayer computing clearing price…</span>
                  </div>
                  <p className="text-[9px] text-muted-dim">Usually takes 10–30 seconds</p>
                </div>
              )}

              {/* Current batch settled buy (claimed or unclaimed — stays in Active) */}
              {currentPositionInActive && currentPosition && (
                <PositionRow
                  batchId={currentBatchId}
                  position={currentPosition}
                  clearingPrice={0n}
                  onClaim={handleClaim}
                  isClaiming={claimingBatchId === currentBatchId}
                  claimError={claimErrors[currentBatchId.toString()]}
                  isActive={!currentPosition.claimed}
                  isSell={false}
                  onClose={
                    currentPosition.claimed && onClosePosition
                      ? () => onClosePosition(computeYesAmount(currentPosition.filledAmount, currentBatchClearingPrice), currentBatchClearingPrice)
                      : undefined
                  }
                />
              )}

              {/* Current batch settled but not filled */}
              {currentBatchStatus === BatchStatus.SETTLED && hasCurrentOrder &&
               currentPosition !== null &&
               currentPosition.filledAmount === 0n && currentPosition.refundAmount === 0n && (
                <div className="px-4 py-3 border-b border-border/40 bg-surface/40">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-[10px] text-muted tracking-widest uppercase">Order not filled</span>
                  </div>
                  <p className="text-[9px] text-muted-dim">
                    Your order was below the clearing price. USDC stays in your ephemeral wallet — recover via the private key stored in your browser.
                  </p>
                </div>
              )}

              {/* Settling / unfilled orders */}
              {!scanning && pendingPositions.map((hp) => (
                hp.settling ? (
                  <div key={hp.batchId.toString()} className="px-4 py-3 border-b border-border/40">
                    <div className="flex items-center gap-2 mb-1">
                      <DirectionBadge isBuy={hp.position.isBuy} />
                      <span className="w-2 h-2 border border-blue/60 border-t-transparent rounded-full animate-spin flex-shrink-0" />
                      <span className="text-[10px] text-blue/70 tracking-wide uppercase">Settling</span>
                      <span className="text-[9px] text-muted-dim ml-auto">#{hp.batchId.toString()}</span>
                    </div>
                    {hp.marketQuestion && (
                      <p className="text-[10px] text-text leading-snug line-clamp-2 mb-1">{hp.marketQuestion}</p>
                    )}
                    <p className="text-[9px] text-muted-dim">Relayer is settling this batch — usually 10–30 s</p>
                  </div>
                ) : (
                  <UnfilledCard key={hp.batchId.toString()} hp={hp} />
                )
              ))}

              {/* Historical active (unclaimed settled with fill) */}
              {scanning ? (
                <div>
                  <SkeletonRow />
                  <SkeletonRow />
                </div>
              ) : activePositions.length === 0 && pendingPositions.length === 0 && !currentIsActive && !hasCurrentOrder ? (
                <div className="px-4 py-8 text-center">
                  <p className="text-[11px] text-muted-dim">No active positions.</p>
                  <p className="text-[10px] text-muted-dim mt-1">
                    Place an order to get started, or check the Activity tab for history.
                  </p>
                </div>
              ) : (
                activePositions.map((hp) => (
                  <PositionRow
                    key={hp.batchId.toString()}
                    batchId={hp.batchId}
                    position={hp.position}
                    clearingPrice={hp.clearingPrice}
                    marketQuestion={hp.marketQuestion}
                    shares={hp.shares}
                    onClaim={handleClaim}
                    isClaiming={claimingBatchId === hp.batchId}
                    claimError={claimErrors[hp.batchId.toString()]}
                    isActive={!hp.position.claimed}
                    isSell={hp.isSell}
                    onClose={
                      !hp.isSell && hp.position.claimed && onClosePosition
                        ? () => onClosePosition(computeYesAmount(hp.position.filledAmount, hp.clearingPrice), hp.clearingPrice)
                        : undefined
                    }
                  />
                ))
              )}
            </div>
          )}

          {/* ── CLOSED sub-tab ───────────────────────────────────────────── */}
          {posTab === "closed" && (
            <div className="flex-1 overflow-y-auto">
              {closedPositions.length === 0 && !currentPositionInClosed ? (
                <div className="px-4 py-8 text-center">
                  <p className="text-[11px] text-muted-dim">No closed positions yet.</p>
                  <p className="text-[10px] text-muted-dim mt-1">
                    Positions you&apos;ve sold or exited on Polymarket will appear here.
                  </p>
                </div>
              ) : (
                <>
                  {/* Current-batch sell (most recent, show first) */}
                  {currentPositionInClosed && currentPosition && (
                    <PositionRow
                      batchId={currentBatchId}
                      position={currentPosition}
                      clearingPrice={currentBatchClearingPrice}
                      onClaim={handleClaim}
                      isClaiming={false}
                      isActive={false}
                      isSell={true}
                    />
                  )}
                  {closedPositions.map((hp) => (
                    <PositionRow
                      key={hp.batchId.toString()}
                      batchId={hp.batchId}
                      position={hp.position}
                      clearingPrice={hp.clearingPrice}
                      marketQuestion={hp.marketQuestion}
                      shares={hp.shares}
                      onClaim={handleClaim}
                      isClaiming={false}
                      isActive={false}
                      isSell={hp.isSell || !hp.position.isBuy}
                    />
                  ))}
                </>
              )}
            </div>
          )}

        </div>
      )}

      {/* ── ACTIVITY TAB ───────────────────────────────────────────────────── */}
      {mainTab === "activity" && (
        <div className="flex-1 overflow-y-auto">

          {/* Current batch order (if any) */}
          {currentForActivity && currentBatchId > 0n && (
            <ActivityRow
              batchId={currentBatchId}
              isBuy={true}  // current session orders are always BUY for simplicity
              amount={currentForActivity.amount ?? 0n}
              batchStatus={currentBatchStatus}
            />
          )}

          {/* Historical orders */}
          {scanning ? (
            <div><SkeletonRow /><SkeletonRow /><SkeletonRow /></div>
          ) : allStoredOrders.length === 0 && !currentForActivity ? (
            <div className="px-4 py-8 text-center">
              <p className="text-[11px] text-muted-dim">No activity yet.</p>
            </div>
          ) : (
            allStoredOrders.map((o, i) => (
              <ActivityRow
                key={`${o.batchId}-${i}`}
                batchId={BigInt(o.batchId)}
                isBuy={o.isBuy}
                amount={BigInt(o.amount)}
                clearingPrice={o.clearingPrice}
                shares={o.shares}
                marketQuestion={o.marketQuestion}
                timestamp={o.timestamp}
                batchStatus={o.batchStatus}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}
