"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { usePrivy, useWallets } from "@privy-io/react-auth";
import { createPublicClient, http, parseAbiItem } from "viem";
import { clsx } from "clsx";
import { BATCH_VAULT_ABI, ERC20_ABI, BatchStatus, getContracts } from "@/lib/contracts";
import { ACTIVE_CHAIN } from "@/lib/chain";

const publicClient = createPublicClient({
  chain: ACTIVE_CHAIN,
  transport: http(),
});

const EXPLORER =
  ACTIVE_CHAIN.blockExplorers?.default.url ?? "https://amoy.polygonscan.com";

const ORDER_COMMITTED_EVENT = parseAbiItem(
  "event OrderCommitted(uint256 indexed batchId, address indexed trader, bytes32 commitment, uint256 amount)"
);

// ── Types ─────────────────────────────────────────────────────────────────────

interface OrderEntry {
  txHash: `0x${string}`;
  blockNumber: bigint;
  batchId: bigint;
  commitment: `0x${string}`;
  rawAmount: bigint; // USDC (6 dec) for buys, YES tokens (18 dec) for sells
  // Enriched after getBatch + getPosition:
  marketId?: `0x${string}`;
  batchStatus?: BatchStatus;
  clearingPrice?: bigint;
  position?: {
    filledAmount: bigint;
    refundAmount: bigint;
    isBuy: boolean;
    claimed: boolean;
  };
  marketQuestion?: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fUsdc(v: bigint) {
  return `$${(Number(v) / 1e6).toFixed(2)}`;
}
function shortHash(h: string, pre = 10, suf = 8) {
  return `${h.slice(0, pre)}…${h.slice(-suf)}`;
}

function CopyButton({ value, label }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    await navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <button
      onClick={copy}
      className="text-[10px] text-muted hover:text-accent transition-colors px-1.5 py-0.5 border border-border hover:border-accent/30"
      title="Copy"
    >
      {copied ? "✓ copied" : label ?? "copy"}
    </button>
  );
}

function StatusBadge({
  status,
  claimed,
}: {
  status?: BatchStatus;
  claimed?: boolean;
}) {
  if (claimed)
    return (
      <span className="text-[9px] tracking-widest uppercase text-accent/70 border border-accent/20 px-1.5 py-0.5">
        CLAIMED ✓
      </span>
    );
  if (status === BatchStatus.SETTLED)
    return (
      <span className="text-[9px] tracking-widest uppercase text-yellow-400/70 border border-yellow-400/20 px-1.5 py-0.5">
        SETTLED
      </span>
    );
  if (status === BatchStatus.SETTLING)
    return (
      <span className="text-[9px] tracking-widest uppercase text-blue-400/70 border border-blue-400/20 px-1.5 py-0.5 animate-pulse">
        SETTLING
      </span>
    );
  if (status === BatchStatus.OPEN)
    return (
      <span className="text-[9px] tracking-widest uppercase text-accent/70 border border-accent/20 px-1.5 py-0.5">
        OPEN
      </span>
    );
  return (
    <span className="text-[9px] tracking-widest uppercase text-muted-dim border border-border px-1.5 py-0.5">
      PENDING
    </span>
  );
}

// ── Order row ────────────────────────────────────────────────────────────────

function OrderRow({ order }: { order: OrderEntry }) {
  const [expanded, setExpanded] = useState(false);

  const isSettled = order.batchStatus === BatchStatus.SETTLED;
  const isClaimed = order.position?.claimed ?? false;
  const isBuy = order.position?.isBuy ?? true;
  const hasResult =
    order.position &&
    (order.position.filledAmount > 0n || order.position.refundAmount > 0n);

  // Format deposit amount — use position.isBuy once available
  const amountDisplay =
    order.position != null
      ? order.position.isBuy
        ? fUsdc(order.rawAmount)
        : `${(Number(order.rawAmount) / 1e18).toFixed(4)} YES`
      : fUsdc(order.rawAmount);

  return (
    <div className="bg-bg hover:bg-surface/20 transition-colors border-b border-border last:border-b-0">
      {/* ── Main clickable row ─────────────────────────────────────────── */}
      <div
        className="p-4 cursor-pointer select-none"
        onClick={() => setExpanded((e) => !e)}
      >
        <div className="flex items-start justify-between gap-4">
          {/* Left: batch + market */}
          <div className="flex-1 min-w-0 space-y-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[10px] text-muted-dim font-mono">
                #{order.batchId.toString()}
              </span>
              <StatusBadge status={order.batchStatus} claimed={isClaimed} />
            </div>
            {order.marketQuestion ? (
              <p className="text-[12px] text-text leading-snug line-clamp-2">
                {order.marketQuestion}
              </p>
            ) : order.marketId ? (
              <p className="hash-text text-[10px] text-muted-dim">
                {shortHash(order.marketId, 14, 8)}
              </p>
            ) : (
              <div className="h-3 w-48 bg-surface/60 rounded animate-pulse" />
            )}
          </div>

          {/* Right: amount + direction */}
          <div className="text-right flex-shrink-0 space-y-1">
            <p className="text-[13px] font-medium text-text tabular-nums">
              {amountDisplay}
            </p>
            {isSettled && order.position ? (
              <p
                className={clsx(
                  "text-[10px] tracking-widest uppercase",
                  order.position.isBuy ? "text-accent" : "text-danger"
                )}
              >
                {order.position.isBuy ? "BUY YES" : "SELL YES"}
              </p>
            ) : (
              <p className="text-[10px] text-muted-dim tracking-widest">
                SEALED ■
              </p>
            )}
          </div>
        </div>

        {/* Fill / refund details */}
        {isSettled && hasResult && (
          <div className="mt-2.5 flex items-center gap-4 flex-wrap">
            {order.position!.filledAmount > 0n && (
              <span className="text-[11px] text-muted">
                Filled{" "}
                <span className="text-text">
                  {fUsdc(order.position!.filledAmount)}
                </span>
              </span>
            )}
            {order.position!.refundAmount > 0n && (
              <span className="text-[11px] text-muted">
                Refund{" "}
                <span className="text-text">
                  {fUsdc(order.position!.refundAmount)}
                </span>
              </span>
            )}
            {order.clearingPrice != null && order.clearingPrice > 0n && (
              <span className="text-[11px] text-muted">
                Cleared @{" "}
                <span className="text-text">
                  {(Number(order.clearingPrice) / 10000).toFixed(1)}¢
                </span>
              </span>
            )}
          </div>
        )}

        {/* Expand hint */}
        <div className="mt-2 flex items-center gap-1.5">
          <span className="text-[9px] text-muted-dim tracking-widest">
            {expanded ? "▲ HIDE DETAILS" : "▼ SHOW PROOF"}
          </span>
        </div>
      </div>

      {/* ── Expanded: cryptographic proof ──────────────────────────────── */}
      {expanded && (
        <div className="border-t border-border/50 px-4 py-3 bg-surface/10 space-y-3">
          {/* Commitment */}
          <div>
            <p className="text-[10px] text-muted tracking-widest uppercase mb-1.5">
              Sealed Commitment Hash
            </p>
            <div className="flex items-center gap-2 flex-wrap">
              <code className="hash-text text-[10px] text-muted-dim break-all flex-1">
                {order.commitment}
              </code>
              <CopyButton value={order.commitment} />
            </div>
            <p className="text-[9px] text-muted-dim mt-1">
              <span className="text-accent/40">// </span>
              keccak256(direction · limitPrice · amount · salt · address) — only
              you know the pre-image
            </p>
          </div>

          {/* Transaction */}
          <div>
            <p className="text-[10px] text-muted tracking-widest uppercase mb-1.5">
              On-Chain Transaction
            </p>
            <div className="flex items-center gap-2 flex-wrap">
              <code className="hash-text text-[10px] text-muted-dim break-all flex-1">
                {order.txHash}
              </code>
              <CopyButton value={order.txHash} />
              <a
                href={`${EXPLORER}/tx/${order.txHash}`}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="flex-shrink-0 text-[10px] text-accent/70 hover:text-accent transition-colors border border-accent/20 hover:border-accent/40 px-2 py-1 tracking-wider"
              >
                VIEW TX ↗
              </a>
            </div>
          </div>

          {/* Privacy note */}
          <div className="bg-accent/5 border border-accent/10 px-3 py-2">
            <p className="text-[10px] text-accent/60 leading-relaxed">
              <span className="text-accent/40">▸ </span>
              Your wallet address and deposited amount are visible on-chain.
              Your buy/sell direction, limit price, and salt cannot be derived
              from the commitment hash — they are not stored anywhere on-chain
              and cannot be backtracked.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Skeleton ──────────────────────────────────────────────────────────────────

function SkeletonRow() {
  return (
    <div className="p-4 border-b border-border animate-pulse space-y-2">
      <div className="flex justify-between">
        <div className="h-3 w-20 bg-surface rounded" />
        <div className="h-3 w-24 bg-surface rounded" />
      </div>
      <div className="h-3 w-56 bg-surface/60 rounded" />
      <div className="h-2.5 w-32 bg-surface/40 rounded" />
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function ProfileClient() {
  const { ready, authenticated, login } = usePrivy();
  const { wallets } = useWallets();
  const walletAddress = wallets[0]?.address as `0x${string}` | undefined;

  const [orders, setOrders] = useState<OrderEntry[]>([]);
  const [usdcBalance, setUsdcBalance] = useState<bigint | null>(null);
  const [loading, setLoading] = useState(true);
  const [enriching, setEnriching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadProfile = useCallback(async () => {
    if (!walletAddress) return;
    setLoading(true);
    setEnriching(false);
    setError(null);

    try {
      const contracts = getContracts(ACTIVE_CHAIN.id);

      // 1. USDC balance + OrderCommitted logs — in parallel
      const [balance, logs] = await Promise.all([
        publicClient.readContract({
          address: contracts.usdc,
          abi: ERC20_ABI,
          functionName: "balanceOf",
          args: [walletAddress],
        }) as Promise<bigint>,

        // Try full history; fall back to last 200k blocks on range errors
        publicClient
          .getLogs({
            address: contracts.batchVault,
            event: ORDER_COMMITTED_EVENT,
            args: { trader: walletAddress },
            fromBlock: 0n,
            toBlock: "latest",
          })
          .catch(async () => {
            const tip = await publicClient.getBlockNumber();
            return publicClient.getLogs({
              address: contracts.batchVault,
              event: ORDER_COMMITTED_EVENT,
              args: { trader: walletAddress },
              fromBlock: tip > 200000n ? tip - 200000n : 0n,
              toBlock: "latest",
            });
          }),
      ]);

      setUsdcBalance(balance);

      if (logs.length === 0) {
        setOrders([]);
        setLoading(false);
        return;
      }

      // Build initial entries (newest first)
      const entries: OrderEntry[] = logs
        .filter((l) => l.transactionHash && l.blockNumber !== null)
        .sort((a, b) => (b.blockNumber! > a.blockNumber! ? 1 : -1))
        .map((log) => ({
          txHash: log.transactionHash!,
          blockNumber: log.blockNumber!,
          batchId: log.args.batchId as bigint,
          commitment: log.args.commitment as `0x${string}`,
          rawAmount: log.args.amount as bigint,
        }));

      setOrders(entries);
      setLoading(false);
      setEnriching(true);

      // 2. Enrich: getBatch + getPosition for each unique batch
      const uniqueBatchIds = [...new Set(entries.map((e) => e.batchId))];

      const batchMap = new Map<
        bigint,
        {
          marketId: `0x${string}`;
          status: number;
          clearingPrice: bigint;
        }
      >();
      const posMap = new Map<
        bigint,
        {
          filledAmount: bigint;
          refundAmount: bigint;
          isBuy: boolean;
          claimed: boolean;
        }
      >();

      await Promise.allSettled(
        uniqueBatchIds.map(async (batchId) => {
          const [batch, pos] = await Promise.all([
            publicClient.readContract({
              address: contracts.batchVault,
              abi: BATCH_VAULT_ABI,
              functionName: "getBatch",
              args: [batchId],
            }) as Promise<{
              marketId: `0x${string}`;
              status: number;
              clearingPrice: bigint;
            }>,
            publicClient.readContract({
              address: contracts.batchVault,
              abi: BATCH_VAULT_ABI,
              functionName: "getPosition",
              args: [batchId, walletAddress],
            }) as Promise<{
              filledAmount: bigint;
              refundAmount: bigint;
              isBuy: boolean;
              claimed: boolean;
            }>,
          ]);
          batchMap.set(batchId, batch);
          posMap.set(batchId, pos);
        })
      );

      const enriched = entries.map((e) => ({
        ...e,
        marketId: batchMap.get(e.batchId)?.marketId,
        batchStatus: batchMap.get(e.batchId)?.status as BatchStatus | undefined,
        clearingPrice: batchMap.get(e.batchId)?.clearingPrice,
        position: posMap.get(e.batchId),
      }));

      setOrders(enriched);

      // 3. Fetch market names for unique marketIds
      const uniqueMarketIds = [
        ...new Set(
          enriched.filter((e) => e.marketId).map((e) => e.marketId!)
        ),
      ];

      const nameMap = new Map<string, string>();
      await Promise.allSettled(
        uniqueMarketIds.map(async (mId) => {
          try {
            const res = await fetch(`/api/markets?condition_id=${mId}&limit=1`);
            if (!res.ok) return;
            const data = await res.json();
            if (data[0]?.question)
              nameMap.set(mId.toLowerCase(), data[0].question);
          } catch {
            /* non-fatal */
          }
        })
      );

      setOrders((prev) =>
        prev.map((e) => ({
          ...e,
          marketQuestion: e.marketId
            ? nameMap.get(e.marketId.toLowerCase())
            : undefined,
        }))
      );

      setEnriching(false);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Failed to load profile";
      setError(msg);
      setLoading(false);
      setEnriching(false);
    }
  }, [walletAddress]);

  useEffect(() => {
    if (ready && authenticated && walletAddress) {
      loadProfile();
    }
  }, [ready, authenticated, walletAddress, loadProfile]);

  // ── Not ready ──────────────────────────────────────────────────────────────
  if (!ready) {
    return (
      <div className="min-h-screen bg-bg flex items-center justify-center">
        <div className="w-4 h-4 border border-muted/40 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!authenticated) {
    return (
      <div className="min-h-screen bg-bg flex flex-col items-center justify-center gap-6">
        <div className="space-y-1 text-center">
          <p className="text-muted text-[11px] tracking-widest uppercase">
            Connect wallet to view profile
          </p>
          <p className="text-muted-dim text-[10px]">
            Your order history is read from on-chain events
          </p>
        </div>
        <button
          onClick={login}
          className="border border-border-bright px-4 py-2 text-xs text-text tracking-widest uppercase hover:border-text/20 transition-colors"
        >
          Connect Wallet
        </button>
        <Link
          href="/"
          className="text-[10px] text-muted-dim hover:text-text transition-colors tracking-widest"
        >
          ← Back to markets
        </Link>
      </div>
    );
  }

  // ── Stats ──────────────────────────────────────────────────────────────────
  const settledOrders = orders.filter(
    (o) => o.batchStatus === BatchStatus.SETTLED
  );
  const totalFilled = settledOrders.reduce(
    (s, o) => (o.position?.filledAmount ? s + o.position.filledAmount : s),
    0n
  );
  const totalOrders = orders.length;
  const shortAddr = walletAddress
    ? `${walletAddress.slice(0, 6)}…${walletAddress.slice(-4)}`
    : "";

  return (
    <div className="min-h-screen bg-bg flex flex-col">
      {/* ── Top nav ──────────────────────────────────────────────────────── */}
      <div className="border-b border-border px-6 py-3 flex items-center justify-between">
        <Link
          href="/"
          className="text-[11px] text-muted hover:text-text transition-colors tracking-widest uppercase flex items-center gap-2"
        >
          <span>←</span> PREDACY
        </Link>
        <span
          className="text-lg font-black text-text tracking-tight"
          style={{ fontFamily: "var(--font-display)" }}
        >
          PROFILE
        </span>
        <button
          onClick={loadProfile}
          disabled={loading}
          className="text-[10px] text-muted hover:text-text transition-colors tracking-widest disabled:opacity-40"
        >
          {loading || enriching ? (
            <span className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 border border-current border-t-transparent rounded-full animate-spin" />
              LOADING
            </span>
          ) : (
            "↻ REFRESH"
          )}
        </button>
      </div>

      <div className="flex-1 px-4 md:px-8 py-6 max-w-4xl mx-auto w-full space-y-6">
        {/* ── Address ────────────────────────────────────────────────────── */}
        <div className="border border-border p-4 flex items-center gap-4 flex-wrap">
          <div className="w-2 h-2 rounded-full bg-accent animate-pulse flex-shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-[10px] text-muted tracking-widest uppercase mb-0.5">
              Wallet Address
            </p>
            <p className="hash-text text-sm text-text break-all">
              {walletAddress}
            </p>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <CopyButton value={walletAddress ?? ""} label="copy address" />
            <a
              href={`${EXPLORER}/address/${walletAddress}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[10px] text-accent/70 hover:text-accent transition-colors border border-accent/20 hover:border-accent/40 px-2 py-1 tracking-wider"
            >
              POLYGONSCAN ↗
            </a>
          </div>
        </div>

        {/* ── Stats grid ─────────────────────────────────────────────────── */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-px bg-border">
          <div className="bg-bg p-4">
            <p className="text-[10px] text-muted tracking-widest uppercase mb-1">
              USDC Balance
            </p>
            <p
              className="text-2xl font-black text-text leading-tight"
              style={{ fontFamily: "var(--font-display)" }}
            >
              {usdcBalance === null
                ? "—"
                : `$${(Number(usdcBalance) / 1e6).toFixed(2)}`}
            </p>
            <p className="text-[10px] text-muted-dim mt-0.5">available</p>
          </div>

          <div className="bg-bg p-4">
            <p className="text-[10px] text-muted tracking-widest uppercase mb-1">
              Orders
            </p>
            <p
              className="text-2xl font-black text-text leading-tight"
              style={{ fontFamily: "var(--font-display)" }}
            >
              {loading ? "—" : totalOrders}
            </p>
            <p className="text-[10px] text-muted-dim mt-0.5">sealed bids</p>
          </div>

          <div className="bg-bg p-4">
            <p className="text-[10px] text-muted tracking-widest uppercase mb-1">
              Total Filled
            </p>
            <p
              className="text-2xl font-black text-text leading-tight"
              style={{ fontFamily: "var(--font-display)" }}
            >
              {loading ? "—" : fUsdc(totalFilled)}
            </p>
            <p className="text-[10px] text-muted-dim mt-0.5">USDC filled</p>
          </div>

          <div className="bg-bg p-4">
            <p className="text-[10px] text-muted tracking-widest uppercase mb-1">
              Privacy
            </p>
            <p
              className="text-2xl font-black text-accent leading-tight"
              style={{ fontFamily: "var(--font-display)" }}
            >
              ZK ✓
            </p>
            <p className="text-[10px] text-muted-dim mt-0.5">
              sealed-bid proof
            </p>
          </div>
        </div>

        {/* ── Privacy breakdown ──────────────────────────────────────────── */}
        <div className="border border-border p-5 space-y-4">
          <div className="flex items-center gap-2">
            <div className="w-1 h-4 bg-accent/40" />
            <p className="text-[10px] text-muted tracking-widest uppercase">
              What&apos;s On-Chain vs What&apos;s Hidden
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Public column */}
            <div className="space-y-2">
              <p className="text-[9px] text-danger/60 uppercase tracking-widest mb-2">
                ◆ Visible on-chain (public)
              </p>
              {[
                ["Your wallet address", shortAddr],
                ["Amount deposited", "in USDC / YES tokens"],
                ["Commitment hash", "sealed keccak256"],
                ["Batch ID", "sequential integer"],
              ].map(([label, sub]) => (
                <div
                  key={label}
                  className="flex items-start justify-between gap-4 bg-surface/30 px-3 py-2"
                >
                  <span className="text-[11px] text-muted">{label}</span>
                  <span className="text-[10px] text-muted-dim text-right shrink-0">
                    {sub}
                  </span>
                </div>
              ))}
            </div>

            {/* Hidden column */}
            <div className="space-y-2">
              <p className="text-[9px] text-accent/60 uppercase tracking-widest mb-2">
                ◆ Cryptographically hidden (private)
              </p>
              {[
                ["Buy / Sell direction", "not stored on-chain"],
                ["Your limit price", "not stored on-chain"],
                ["Random salt", "blinding factor"],
                ["Order rationale", "never logged"],
              ].map(([label, sub]) => (
                <div
                  key={label}
                  className="flex items-start justify-between gap-4 bg-accent/5 border border-accent/10 px-3 py-2"
                >
                  <span className="text-[11px] text-accent/80">{label}</span>
                  <span className="text-[10px] text-accent/40 text-right shrink-0">
                    {sub}
                  </span>
                </div>
              ))}
            </div>
          </div>

          <div className="border-t border-border/40 pt-3">
            <p className="text-[10px] text-muted-dim leading-relaxed">
              <span className="text-accent/50">// </span>
              Each order hashes to{" "}
              <code className="hash-text">
                keccak256(direction · limitPrice · amount · salt · address)
              </code>
              . The pre-image (your order details) is never stored on-chain.
              Even knowing your wallet address, no one can determine whether you
              bought or sold, at what price, or why.
            </p>
          </div>
        </div>

        {/* ── Order history ──────────────────────────────────────────────── */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <p className="text-[10px] text-muted tracking-widest uppercase">
                Order History
              </p>
              {enriching && (
                <span className="text-[9px] text-muted-dim tracking-widest">
                  (loading details…)
                </span>
              )}
            </div>
            <span className="text-[10px] text-muted-dim">
              {loading ? "…" : `${totalOrders} orders`}
            </span>
          </div>

          {loading ? (
            <div className="border border-border divide-y divide-border">
              <SkeletonRow />
              <SkeletonRow />
              <SkeletonRow />
            </div>
          ) : error ? (
            <div className="border border-danger/20 p-6 text-center space-y-2">
              <p className="text-danger text-[11px]">{error}</p>
              <button
                onClick={loadProfile}
                className="text-[10px] text-muted hover:text-text transition-colors tracking-widest border border-border px-3 py-1"
              >
                ↻ RETRY
              </button>
            </div>
          ) : orders.length === 0 ? (
            <div className="border border-border p-10 text-center space-y-3">
              <div className="w-8 h-8 border border-border flex items-center justify-center mx-auto">
                <div className="w-2 h-2 bg-muted/30" />
              </div>
              <p className="text-muted text-[11px] tracking-widest uppercase">
                No orders yet
              </p>
              <p className="text-muted-dim text-[10px]">
                Place a sealed-bid order on any market to get started
              </p>
              <Link
                href="/"
                className="inline-block mt-1 text-[10px] text-accent/70 hover:text-accent transition-colors tracking-widest border border-accent/20 hover:border-accent/40 px-3 py-1"
              >
                Browse markets →
              </Link>
            </div>
          ) : (
            <div className="border border-border divide-y divide-border">
              {orders.map((order) => (
                <OrderRow
                  key={`${order.txHash}-${order.batchId}`}
                  order={order}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ── Footer ───────────────────────────────────────────────────────── */}
      <footer className="border-t border-border px-6 py-3 flex items-center justify-between">
        <span className="text-[10px] text-muted-dim tracking-widest">
          Predacy · Private Prediction Markets
        </span>
        <span className="text-[10px] text-muted-dim">
          <span className="text-accent/30">●</span> Order details never stored
          on-chain
        </span>
      </footer>
    </div>
  );
}
