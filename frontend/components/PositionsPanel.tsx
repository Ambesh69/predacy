"use client";

import { useState, useEffect, useCallback } from "react";
import { createPublicClient, http } from "viem";
import { clsx } from "clsx";
import { BATCH_VAULT_ABI, BatchStatus, getContracts } from "@/lib/contracts";
import { ACTIVE_CHAIN } from "@/lib/chain";

const publicClient = createPublicClient({
  chain: ACTIVE_CHAIN,
  transport: http(),
});

interface HistoricalPosition {
  batchId: bigint;
  batchMarketId: `0x${string}`;
  batchStatus: BatchStatus;
  position: {
    filledAmount: bigint;
    refundAmount: bigint;
    isBuy: boolean;
    claimed: boolean;
  };
}

interface PositionsPanelProps {
  walletAddress: `0x${string}`;
  currentBatchId: bigint;
  currentBatchStatus: BatchStatus;
  /** Commitments the user has sealed in the current batch this session */
  currentBatchCommitments: Array<{ hash: `0x${string}`; amount?: bigint }>;
  onClaim: (batchId: bigint) => Promise<void>;
  /** Called after scanning history — provides unique market IDs seen across all batches */
  onMarketIdsFound?: (ids: `0x${string}`[]) => void;
}


function BatchStatusBadge({ status }: { status: BatchStatus }) {
  if (status === BatchStatus.OPEN)
    return <span className="text-[9px] tracking-widest uppercase text-accent/70 border border-accent/20 px-1.5 py-0.5">OPEN</span>;
  if (status === BatchStatus.SETTLING)
    return <span className="text-[9px] tracking-widest uppercase text-blue/70 border border-blue/20 px-1.5 py-0.5">SETTLING</span>;
  return <span className="text-[9px] tracking-widest uppercase text-muted-dim border border-border px-1.5 py-0.5">SETTLED</span>;
}

function SkeletonCard() {
  return (
    <div className="border border-border p-3 space-y-2 animate-pulse">
      <div className="flex items-center justify-between">
        <div className="h-3 w-16 bg-surface/80 rounded" />
        <div className="h-3 w-12 bg-surface/80 rounded" />
      </div>
      <div className="h-3 w-24 bg-surface/60 rounded" />
      <div className="h-3 w-20 bg-surface/60 rounded" />
    </div>
  );
}

export default function PositionsPanel({
  walletAddress,
  currentBatchId,
  currentBatchStatus,
  currentBatchCommitments,
  onClaim,
  onMarketIdsFound,
}: PositionsPanelProps) {
  const [historicalPositions, setHistoricalPositions] = useState<HistoricalPosition[]>([]);
  const [scanning, setScanning] = useState(false);
  const [claimingBatchId, setClaimingBatchId] = useState<bigint | null>(null);
  const [claimErrors, setClaimErrors] = useState<Record<string, string>>({});

  // Current-batch position (fetched separately when settled)
  const [currentPosition, setCurrentPosition] = useState<{
    filledAmount: bigint;
    refundAmount: bigint;
    isBuy: boolean;
    claimed: boolean;
  } | null>(null);

  // ── Fetch current batch position when it settles ─────────────────────────────
  // Position is keyed by commitment hash — look up from localStorage.
  useEffect(() => {
    if (currentBatchStatus !== BatchStatus.SETTLED || currentBatchId === 0n) {
      setCurrentPosition(null);
      return;
    }
    let cancelled = false;
    const fetch = async () => {
      try {
        const storageKey = `predacy:orders:${walletAddress.toLowerCase()}`;
        const storedOrders: Array<{ commitment: string; batchId: string }> =
          JSON.parse(localStorage.getItem(storageKey) ?? "[]");
        const myOrder = storedOrders.find((o) => o.batchId === currentBatchId.toString());
        if (!myOrder) return; // no order in this batch

        const contracts = getContracts(ACTIVE_CHAIN.id);
        const pos = await publicClient.readContract({
          address: contracts.batchVault,
          abi: BATCH_VAULT_ABI,
          functionName: "getPosition",
          args: [currentBatchId, myOrder.commitment as `0x${string}`],
        }) as { filledAmount: bigint; refundAmount: bigint; isBuy: boolean; claimed: boolean };
        if (!cancelled) setCurrentPosition(pos);
      } catch { /* RPC hiccup */ }
    };
    fetch();
    return () => { cancelled = true; };
  }, [currentBatchStatus, currentBatchId, walletAddress]);

  // ── Scan historical batches from localStorage ─────────────────────────────────
  // Positions are keyed by commitment hash — look up from localStorage instead of
  // scanning all batches by address (which is no longer possible after the privacy fix).
  const scanHistory = useCallback(async () => {
    setScanning(true);
    const contracts = getContracts(ACTIVE_CHAIN.id);
    const results: HistoricalPosition[] = [];

    // Load all stored orders for this wallet
    let storedOrders: Array<{
      commitment: string; batchId: string;
    }> = [];
    try {
      const storageKey = `predacy:orders:${walletAddress.toLowerCase()}`;
      storedOrders = JSON.parse(localStorage.getItem(storageKey) ?? "[]");
    } catch { /* ignore */ }

    // Only look at historical batches (exclude current batch — handled separately)
    const historicalOrders = storedOrders.filter(
      (o) => o.batchId !== currentBatchId.toString()
    );

    await Promise.allSettled(
      historicalOrders.map(async (order) => {
        try {
          const id = BigInt(order.batchId);
          const [batchRaw, posRaw] = await Promise.all([
            publicClient.readContract({
              address: contracts.batchVault,
              abi: BATCH_VAULT_ABI,
              functionName: "getBatch",
              args: [id],
            }) as Promise<{ status: number; marketId: `0x${string}` }>,
            publicClient.readContract({
              address: contracts.batchVault,
              abi: BATCH_VAULT_ABI,
              functionName: "getPosition",
              args: [id, order.commitment as `0x${string}`],
            }) as Promise<{ filledAmount: bigint; refundAmount: bigint; isBuy: boolean; claimed: boolean }>,
          ]);

          if (posRaw.filledAmount === 0n && posRaw.refundAmount === 0n) return;

          results.push({
            batchId: id,
            batchMarketId: batchRaw.marketId,
            batchStatus: batchRaw.status as BatchStatus,
            position: posRaw,
          });
        } catch { /* batch doesn't exist or RPC hiccup — skip */ }
      })
    );

    // Sort descending by batchId
    results.sort((a, b) => (a.batchId > b.batchId ? -1 : 1));
    setHistoricalPositions(results);
    setScanning(false);
    // Bubble up all unique market IDs so the sell form can check balance for each
    const uniqueMarketIds = [...new Set(results.map(r => r.batchMarketId))];
    onMarketIdsFound?.(uniqueMarketIds);
  }, [currentBatchId, walletAddress, onMarketIdsFound]);

  useEffect(() => {
    scanHistory();
  }, [scanHistory]);

  const handleClaim = async (batchId: bigint) => {
    setClaimingBatchId(batchId);
    const key = batchId.toString();
    setClaimErrors((prev) => { const n = { ...prev }; delete n[key]; return n; });
    try {
      await onClaim(batchId);
      // Optimistically mark as claimed immediately so the UI updates right away
      if (batchId === currentBatchId) {
        setCurrentPosition((p) => p ? { ...p, claimed: true } : p);
      } else {
        setHistoricalPositions((prev) =>
          prev.map((hp) =>
            hp.batchId === batchId
              ? { ...hp, position: { ...hp.position, claimed: true } }
              : hp
          )
        );
      }
      // Re-fetch in background to confirm on-chain state
      scanHistory();
    } catch (e: any) {
      if (e?.code !== 4001) {
        setClaimErrors((prev) => ({ ...prev, [key]: e.message ?? "Claim failed" }));
      }
    } finally {
      setClaimingBatchId(null);
    }
  };

  const formatUsdc = (v: bigint) => `$${(Number(v) / 1e6).toFixed(2)}`;

  // ── Render ───────────────────────────────────────────────────────────────────
  return (
    <div className="flex-1 overflow-y-auto p-4 space-y-3">

      {/* ── Current batch ──────────────────────────────────────────────────── */}
      <div className="space-y-1.5">
        <div className="flex items-center gap-2">
          <p className="text-[10px] text-muted tracking-widest uppercase">Current Batch</p>
          <BatchStatusBadge status={currentBatchStatus} />
          {currentBatchId > 0n && (
            <span className="text-[9px] text-muted-dim ml-auto">#{currentBatchId.toString()}</span>
          )}
        </div>

        {currentBatchId === 0n ? (
          <p className="text-muted-dim text-[11px]">Loading…</p>
        ) : currentBatchStatus === BatchStatus.OPEN ? (
          currentBatchCommitments.length > 0 ? (
            <div className="border border-accent/20 bg-accent/5 p-3 space-y-2">
              <p className="text-accent text-[11px] tracking-wide">✓ ORDER SEALED</p>
              {currentBatchCommitments.map((c) => (
                <div key={c.hash} className="space-y-0.5">
                  <p className="text-[10px] text-muted-dim">
                    Amount: <span className="text-text">{c.amount != null ? formatUsdc(c.amount) : "—"}</span>
                  </p>
                  <p className="hash-text text-[10px] text-muted-dim break-all">{c.hash}</p>
                </div>
              ))}
              <p className="text-[10px] text-muted-dim">Waiting for batch settlement…</p>
            </div>
          ) : (
            <div className="border border-border p-3">
              <p className="text-[11px] text-muted-dim">No orders placed in this batch.</p>
            </div>
          )
        ) : currentBatchStatus === BatchStatus.SETTLING ? (
          <div className="border border-blue/20 bg-blue/5 p-3">
            <p className="text-blue/70 text-[11px] tracking-wide animate-pulse">Batch settling…</p>
          </div>
        ) : currentPosition === null ? (
          <div className="border border-border p-3 animate-pulse">
            <div className="h-3 w-32 bg-surface/80 rounded" />
          </div>
        ) : currentPosition.filledAmount === 0n && currentPosition.refundAmount === 0n ? (
          <div className="border border-border p-3">
            <p className="text-[11px] text-muted-dim">No position in this batch.</p>
          </div>
        ) : (
          <PositionCard
            batchId={currentBatchId}
            position={currentPosition}
            batchStatus={BatchStatus.SETTLED}
            onClaim={handleClaim}
            isClaiming={claimingBatchId === currentBatchId}
            claimError={claimErrors[currentBatchId.toString()]}
          />
        )}
      </div>

      {/* Divider */}
      <div className="border-t border-border/50" />

      {/* ── Historical batches ─────────────────────────────────────────────── */}
      <div className="space-y-1.5">
        <p className="text-[10px] text-muted tracking-widest uppercase">Previous Batches</p>

        {scanning ? (
          <div className="space-y-2">
            <SkeletonCard />
            <SkeletonCard />
            <SkeletonCard />
          </div>
        ) : historicalPositions.length === 0 ? (
          <div className="border border-border p-3 text-center">
            <p className="text-[11px] text-muted-dim">No historical positions found.</p>
          </div>
        ) : (
          <div className="space-y-2">
            {historicalPositions.map((hp) => (
              <PositionCard
                key={hp.batchId.toString()}
                batchId={hp.batchId}
                position={hp.position}
                batchStatus={hp.batchStatus}
                onClaim={handleClaim}
                isClaiming={claimingBatchId === hp.batchId}
                claimError={claimErrors[hp.batchId.toString()]}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Position card sub-component ────────────────────────────────────────────────
interface PositionCardProps {
  batchId: bigint;
  batchStatus: BatchStatus;
  position: {
    filledAmount: bigint;
    refundAmount: bigint;
    isBuy: boolean;
    claimed: boolean;
  };
  onClaim: (batchId: bigint) => Promise<void>;
  isClaiming: boolean;
  claimError?: string;
}

function PositionCard({ batchId, batchStatus, position, onClaim, isClaiming, claimError }: PositionCardProps) {
  const formatUsdc = (v: bigint) => `$${(Number(v) / 1e6).toFixed(2)}`;
  const isSettled = batchStatus === BatchStatus.SETTLED;
  const hasPosition = position.filledAmount > 0n || position.refundAmount > 0n;

  if (!hasPosition) return null;

  return (
    <div className={clsx(
      "border p-3 space-y-2",
      position.claimed ? "border-border/40" : isSettled ? "border-border" : "border-border/60"
    )}>
      {/* Header */}
      <div className="flex items-center justify-between">
        <span className="text-[10px] text-muted">Batch #{batchId.toString()}</span>
        <div className="flex items-center gap-1.5">
          {position.claimed ? (
            <span className="text-[9px] tracking-widest uppercase text-accent/60">CLAIMED ✓</span>
          ) : isSettled ? (
            <span className="text-[9px] tracking-widest uppercase text-yellow-400/70 border border-yellow-400/20 px-1.5 py-0.5">UNCLAIMED</span>
          ) : (
            <BatchStatusBadge status={batchStatus} />
          )}
        </div>
      </div>

      {/* Position details */}
      <div className="space-y-1">
        <div className="flex justify-between">
          <span className="text-[10px] text-muted">Side</span>
          <span className={clsx("text-[10px]", position.isBuy ? "text-accent" : "text-danger")}>
            {position.isBuy ? "BUY YES" : "SELL YES"}
          </span>
        </div>
        {position.filledAmount > 0n && (
          <div className="flex justify-between">
            <span className="text-[10px] text-muted">Filled</span>
            <span className="text-[10px] text-text">{formatUsdc(position.filledAmount)}</span>
          </div>
        )}
        {position.refundAmount > 0n && (
          <div className="flex justify-between">
            <span className="text-[10px] text-muted">Refund</span>
            <span className="text-[10px] text-text">{formatUsdc(position.refundAmount)}</span>
          </div>
        )}
      </div>

      {/* Claim button */}
      {isSettled && !position.claimed && (
        <>
          <button
            onClick={() => onClaim(batchId)}
            disabled={isClaiming}
            className="w-full py-2 border border-accent text-accent text-[10px] tracking-widest uppercase hover:bg-accent/5 transition-colors disabled:opacity-40"
          >
            {isClaiming ? (
              <span className="flex items-center justify-center gap-1.5">
                <span className="w-2.5 h-2.5 border border-current border-t-transparent rounded-full animate-spin" />
                CLAIMING…
              </span>
            ) : (
              "CLAIM POSITION"
            )}
          </button>
          {claimError && (
            <p className="text-danger text-[10px]">{claimError}</p>
          )}
        </>
      )}
    </div>
  );
}
