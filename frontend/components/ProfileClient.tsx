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
  "event OrderCommitted(uint256 indexed batchId, bytes32 indexed commitment)"
);

// ── Types ─────────────────────────────────────────────────────────────────────

/** Persisted locally when the user submits an order (MarketPageClient writes this) */
interface StoredOrder {
  commitment:      string;
  salt?:           string;   // preimage needed at claim time; undefined in older cached orders
  amount:          string;
  isBuy:           boolean;
  limitPrice:      string;
  batchId:         string;
  marketId:        string | null;
  marketQuestion:  string | null;
  timestamp:       number;
}

interface OrderEntry {
  // from localStorage
  commitment:      `0x${string}`;
  rawAmount:       bigint;
  isBuy:           boolean;
  limitPrice:      bigint;
  batchId:         bigint;
  marketId?:       `0x${string}`;
  marketQuestion?: string;
  timestamp:       number;
  // enriched from chain
  txHash?:         `0x${string}`;
  batchStatus?:    BatchStatus;
  clearingPrice?:  bigint;
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
      type="button"
      onClick={copy}
      aria-label="Copy value"
      className="text-[10px] text-muted hover:text-accent transition-colors px-1.5 py-0.5 border border-border hover:border-accent/30"
      title="Copy"
    >
      {copied ? "✓ copied" : label ?? "copy"}
    </button>
  );
}

function StatusBadge({
  status,
}: {
  status?: BatchStatus;
}) {
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

  const amountDisplay = order.isBuy
    ? fUsdc(order.rawAmount)
    : `${(Number(order.rawAmount) / 1e18).toFixed(4)} YES`;

  const timeAgo = (() => {
    const diff = Date.now() - order.timestamp;
    const mins = Math.floor(diff / 60_000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
  })();

  return (
    <div className="bg-bg hover:bg-surface/20 transition-colors border-b border-border last:border-b-0">
      {/* ── Main clickable row ─────────────────────────────────────────── */}
      <div
        className="p-4 cursor-pointer select-none"
        role="button"
        tabIndex={0}
        onClick={() => setExpanded((e) => !e)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setExpanded((prev) => !prev);
          }
        }}
      >
        <div className="flex items-start justify-between gap-4">
          {/* Left: batch + market */}
          <div className="flex-1 min-w-0 space-y-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[10px] text-muted-dim font-mono">
                #{order.batchId.toString()}
              </span>
              <StatusBadge status={order.batchStatus} />
              <span className="text-[10px] text-muted-dim">{timeAgo}</span>
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

          {/* Right: amount + direction (always visible — user knows their own order) */}
          <div className="text-right flex-shrink-0 space-y-1">
            <p className="text-[13px] font-medium text-text tabular-nums">
              {amountDisplay}
            </p>
            <p
              className={clsx(
                "text-[10px] tracking-widest uppercase",
                order.isBuy ? "text-accent" : "text-danger"
              )}
            >
              {order.isBuy ? "BUY YES" : "SELL YES"}
            </p>
          </div>
        </div>

        {/* Fill details after settlement */}
        {order.batchStatus === BatchStatus.SETTLED && order.clearingPrice != null && order.clearingPrice > 0n && (
          <div className="mt-2.5 flex items-center gap-4 flex-wrap">
            <span className="text-[11px] text-muted">
              Cleared @{" "}
              <span className="text-text">
                {(Number(order.clearingPrice) / 10000).toFixed(1)}¢
              </span>
            </span>
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
          {order.txHash && !/^0x0+$/.test(order.txHash) ? (
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
              <p className="text-[9px] text-muted-dim mt-1">
                <span className="text-accent/40">// </span>
                Submitted by relayer — your address is not visible in this tx
              </p>
            </div>
          ) : (
            <div>
              <p className="text-[10px] text-muted tracking-widest uppercase mb-1.5">
                On-Chain Transaction
              </p>
              <p className="text-[10px] text-muted-dim italic">
                Searching for tx on-chain…
              </p>
            </div>
          )}

          {/* Privacy note */}
          <div className="bg-accent/5 border border-accent/10 px-3 py-2">
            <p className="text-[10px] text-accent/60 leading-relaxed">
              <span className="text-accent/40">▸ </span>
              Your wallet address never appears in order events — the relayer
              submits on-chain on your behalf. Only your buy/sell direction,
              limit price, and salt are sealed inside the commitment and cannot
              be backtracked.
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

      // 1. USDC balance
      const balance = await publicClient.readContract({
        address: contracts.usdc,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [walletAddress],
      }) as bigint;

      setUsdcBalance(balance);

      // 2. Load orders from localStorage
      // Orders are stored here by MarketPageClient when the user submits an order.
      // The relayer submits commitOrderFor on-chain, so the user's wallet address
      // never appears as `trader` in OrderCommitted events — only the relayer address
      // is visible. We therefore track history locally rather than via chain scanning.
      let storedOrders: StoredOrder[] = [];
      try {
        const key = `predacy:orders:${walletAddress.toLowerCase()}`;
        storedOrders = JSON.parse(localStorage.getItem(key) ?? "[]");
      } catch { /* ignore quota / parse errors */ }

      if (storedOrders.length === 0) {
        setOrders([]);
        setLoading(false);
        return;
      }

      // Build initial entries from localStorage (newest first)
      const entries: OrderEntry[] = storedOrders.map((o) => ({
        commitment:     o.commitment as `0x${string}`,
        rawAmount:      BigInt(o.amount),
        isBuy:          o.isBuy,
        limitPrice:     BigInt(o.limitPrice),
        batchId:        BigInt(o.batchId),
        marketId:       (o.marketId ?? undefined) as `0x${string}` | undefined,
        marketQuestion: o.marketQuestion ?? undefined,
        timestamp:      o.timestamp,
      }));

      setOrders(entries);
      setLoading(false);
      setEnriching(true);

      // 3. Enrich: getBatch status + find tx hash per unique batch
      const uniqueBatchIds = [...new Set(entries.map((e) => e.batchId))];

      const batchMap = new Map<bigint, { status: number; clearingPrice: bigint }>();
      const txHashMap = new Map<string, `0x${string}`>(); // commitment.toLowerCase() → txHash

      await Promise.allSettled(
        uniqueBatchIds.map(async (batchId) => {
          try {
            // getBatch for status + clearing price
            const batch = await publicClient.readContract({
              address: contracts.batchVault,
              abi: BATCH_VAULT_ABI,
              functionName: "getBatch",
              args: [batchId],
            }) as { marketId: `0x${string}`; status: number; clearingPrice: bigint };
            batchMap.set(batchId, { status: batch.status, clearingPrice: batch.clearingPrice });

            // Scan OrderCommitted events for this batch to find tx hashes
            // (filter by batchId which is indexed — efficient)
            const logs = await publicClient
              .getLogs({
                address: contracts.batchVault,
                event: ORDER_COMMITTED_EVENT,
                args: { batchId },
                fromBlock: 0n,
                toBlock: "latest",
              })
              .catch(async () => {
                const tip = await publicClient.getBlockNumber();
                return publicClient.getLogs({
                  address: contracts.batchVault,
                  event: ORDER_COMMITTED_EVENT,
                  args: { batchId },
                  fromBlock: tip > 200000n ? tip - 200000n : 0n,
                  toBlock: "latest",
                });
              });

            for (const log of logs) {
              const c = (log.args.commitment as string | undefined)?.toLowerCase();
              if (c && log.transactionHash) {
                txHashMap.set(c, log.transactionHash);
              }
            }
          } catch { /* non-fatal — show order without chain enrichment */ }
        })
      );

      const enriched = entries.map((e) => ({
        ...e,
        txHash:       txHashMap.get(e.commitment.toLowerCase()),
        batchStatus:  batchMap.get(e.batchId)?.status as BatchStatus | undefined,
        clearingPrice: batchMap.get(e.batchId)?.clearingPrice,
      }));

      setOrders(enriched);
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
            Your order history is stored locally on this device
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
  const totalVolume = orders.reduce((s, o) => s + o.rawAmount, 0n);
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
              Settled
            </p>
            <p
              className="text-2xl font-black text-text leading-tight"
              style={{ fontFamily: "var(--font-display)" }}
            >
              {loading ? "—" : settledOrders.length}
            </p>
            <p className="text-[10px] text-muted-dim mt-0.5">batches filled</p>
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
            {/* Public column — visible on-chain */}
            <div className="space-y-2">
              <p className="text-[9px] text-muted/60 uppercase tracking-widest mb-2">
                ◆ Visible on-chain (public)
              </p>
              {[
                ["Commitment hash", "sealed keccak256"],
                ["Batch ID",        "sequential integer"],
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
                ✓ Cryptographically hidden (private)
              </p>
              {[
                ["Your wallet address", "never in any event"],
                ["Amount deposited",    "relayer pays on-chain"],
                ["Buy / Sell direction","sealed in commitment"],
                ["Your limit price",   "sealed in commitment"],
                ["Random salt",        "blinding factor"],
                ["Clearing price",     "hidden until settlement"],
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

          <div className="border-t border-border/40 pt-3 space-y-2">
            <p className="text-[10px] text-muted-dim leading-relaxed">
              <span className="text-accent/50">// </span>
              No wallet address or amount ever appears on-chain when you place
              an order. The relayer holds USDC and calls{" "}
              <code className="hash-text">commitOrderFor()</code> on your
              behalf — only the relayer&apos;s address is visible in the{" "}
              <code className="hash-text">OrderCommitted</code> event.
            </p>
            <p className="text-[10px] text-muted-dim leading-relaxed">
              <span className="text-accent/50">// </span>
              Order details are sealed inside{" "}
              <code className="hash-text">
                keccak256(marketId · direction · amount · limitPrice · salt · address)
              </code>
              . To claim after settlement you reveal this preimage — safe
              post-settlement since the batch is already closed.
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
                  (enriching from chain…)
                </span>
              )}
            </div>
            <div className="flex items-center gap-3">
              <span className="text-[10px] text-muted-dim">
                {loading ? "…" : `${totalOrders} orders`}
              </span>
              <span className="text-[9px] text-muted-dim border border-border px-2 py-0.5">
                stored locally
              </span>
            </div>
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
                Place a sealed-bid order on any market — it will appear here
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
                  key={`${order.commitment}-${order.batchId}`}
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
          <span className="text-accent/30">●</span> No address or amount in any order event
        </span>
      </footer>
    </div>
  );
}
