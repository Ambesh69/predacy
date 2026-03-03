"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import Link from "next/link";
import { usePrivy, useWallets } from "@privy-io/react-auth";
import {
  createPublicClient, createWalletClient, custom, http, parseAbiItem,
  keccak256, encodeAbiParameters,
} from "viem";
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

interface StoredOrder {
  commitment:      string;
  salt?:           string;
  amount:          string;
  isBuy:           boolean;
  limitPrice:      string;
  batchId:         string;
  marketId:        string | null;
  marketQuestion:  string | null;
  timestamp:       number;
  claimed?:        boolean;
}

interface OrderEntry {
  // from localStorage
  commitment:       `0x${string}`;
  salt?:            string;
  rawAmount:        bigint;
  isBuy:            boolean;
  limitPrice:       bigint;
  batchId:          bigint;
  marketId?:        `0x${string}`;
  marketQuestion?:  string;
  timestamp:        number;
  // enriched from chain
  txHash?:          `0x${string}`;
  batchStatus?:     BatchStatus;
  clearingPrice?:   bigint;
  // position data
  filledAmount?:    bigint;
  refundAmount?:    bigint;
  claimed?:         boolean;
  // market data
  currentYesPrice?: number;   // 0–1 float from Gamma API
  shares?:          number;   // computed from filledAmount / clearingPrice
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fUsdc(v: bigint) {
  return `$${(Number(v) / 1e6).toFixed(2)}`;
}
function shortHash(h: string, pre = 10, suf = 8) {
  return `${h.slice(0, pre)}…${h.slice(-suf)}`;
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
// Retry an async RPC call up to `attempts` times with linear back-off.
async function withRetry<T>(fn: () => Promise<T>, attempts = 3, baseMs = 900): Promise<T> {
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); } catch (e) {
      if (i === attempts - 1) throw e;
      await new Promise((r) => setTimeout(r, baseMs * (i + 1)));
    }
  }
  throw new Error("unreachable");
}

// Convert raw viem / network error messages into short, readable sentences.
function cleanRpcError(raw: string): string {
  if (/timed out|timeout/i.test(raw))
    return "RPC request timed out — the testnet node is slow. Click ↻ Retry.";
  if (/rate.?limit|429/i.test(raw))
    return "RPC rate-limited — wait a few seconds, then retry.";
  if (/network|fetch failed|ECONNREFUSED/i.test(raw))
    return "Network error — check your connection and retry.";
  if (/user rejected|denied/i.test(raw))
    return "Signature rejected.";
  return "Failed to load profile — click ↻ Retry.";
}

function cleanClaimError(raw: string): string {
  if (raw.includes("AlreadyClaimed"))     return "Already claimed.";
  if (raw.includes("NothingToClaim"))     return "Nothing to claim for this order.";
  if (raw.includes("BatchNotSettled"))    return "Batch not yet settled — try again shortly.";
  if (raw.includes("ZKProofInvalid"))     return "ZK proof invalid — contact support.";
  if (raw.includes("ClaimVerifierNotSet")) return "Claim verifier not configured on-chain.";
  if (raw.includes("preimage not found")) return "Order preimage missing — cannot claim from this device.";
  if (raw.length > 100) return raw.slice(0, 100) + "…";
  return raw;
}

// ── Sub-components ────────────────────────────────────────────────────────────

function WalletAvatar({ address, size = 56 }: { address: string; size?: number }) {
  if (!address) return (
    <div className="rounded-full bg-surface flex-shrink-0" style={{ width: size, height: size }} />
  );
  const b1 = parseInt(address.slice(2, 4), 16);
  const b2 = parseInt(address.slice(4, 6), 16);
  const b3 = parseInt(address.slice(6, 8), 16);
  const h1 = Math.round((b1 * 360) / 256);
  const h2 = Math.round((b2 * 360) / 256);
  const sat = 55 + (b3 % 25);
  const gradId = `av-${address.slice(2, 10)}`;
  return (
    <svg width={size} height={size} viewBox="0 0 56 56" aria-hidden>
      <defs>
        <linearGradient id={gradId} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%"   stopColor={`hsl(${h1},${sat}%,42%)`} />
          <stop offset="100%" stopColor={`hsl(${h2},${sat}%,60%)`} />
        </linearGradient>
      </defs>
      <circle cx="28" cy="28" r="28" fill={`url(#${gradId})`} />
      <text x="28" y="33" textAnchor="middle" fontSize="15"
            fontWeight="700" fill="rgba(255,255,255,0.85)" fontFamily="monospace">
        {address.slice(2, 6).toUpperCase()}
      </text>
    </svg>
  );
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

function StatusBadge({ status }: { status?: BatchStatus }) {
  if (status === BatchStatus.SETTLED)
    return <span className="text-[9px] tracking-widest uppercase text-yellow-400/70 border border-yellow-400/20 px-1.5 py-0.5">SETTLED</span>;
  if (status === BatchStatus.SETTLING)
    return <span className="text-[9px] tracking-widest uppercase text-blue-400/70 border border-blue-400/20 px-1.5 py-0.5 animate-pulse">SETTLING</span>;
  if (status === BatchStatus.OPEN)
    return <span className="text-[9px] tracking-widest uppercase text-accent/70 border border-accent/20 px-1.5 py-0.5">OPEN</span>;
  return <span className="text-[9px] tracking-widest uppercase text-muted-dim border border-border px-1.5 py-0.5">PENDING</span>;
}

// ── Skeleton row ──────────────────────────────────────────────────────────────

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

// ── Activity row (expandable proof) ──────────────────────────────────────────

function ActivityRow({ order }: { order: OrderEntry }) {
  const [expanded, setExpanded] = useState(false);

  const amountDisplay = order.isBuy
    ? fUsdc(order.rawAmount)
    : `${(Number(order.rawAmount) / 1e18).toFixed(4)} YES`;

  return (
    <div className="bg-bg hover:bg-surface/20 transition-colors border-b border-border last:border-b-0">
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
          {/* Left: type badge + market question */}
          <div className="flex-1 min-w-0 space-y-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className={clsx(
                "text-[9px] tracking-widest uppercase px-1.5 py-0.5 border font-mono",
                order.isBuy
                  ? "border-accent/30 text-accent bg-accent/5"
                  : "border-danger/30 text-danger bg-danger/5",
              )}>
                {order.isBuy ? "BUY" : "SELL"}
              </span>
              <StatusBadge status={order.batchStatus} />
              <span className="text-[10px] text-muted-dim">{timeAgo(order.timestamp)}</span>
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

          {/* Right: amount + clearing price */}
          <div className="text-right flex-shrink-0 space-y-1">
            <p className="text-[13px] font-medium text-text tabular-nums">
              {amountDisplay}
            </p>
            {order.batchStatus === BatchStatus.SETTLED && order.clearingPrice != null && order.clearingPrice > 0n && (
              <p className="text-[10px] text-muted">
                @ <span className="text-text">{(Number(order.clearingPrice) / 10_000).toFixed(1)}¢</span>
              </p>
            )}
            {order.claimed && (
              <p className="text-[9px] text-accent/60 tracking-widest uppercase">CLAIMED ✓</p>
            )}
          </div>
        </div>

        <div className="mt-2 flex items-center gap-1.5">
          <span className="text-[9px] text-muted-dim tracking-widest">
            {expanded ? "▲ HIDE DETAILS" : "▼ SHOW PROOF"}
          </span>
        </div>
      </div>

      {expanded && (
        <div className="border-t border-border/50 px-4 py-3 bg-surface/10 space-y-3">
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

          <div className="bg-accent/5 border border-accent/10 px-3 py-2">
            <p className="text-[10px] text-accent/60 leading-relaxed">
              <span className="text-accent/40">▸ </span>
              Your wallet address never appears in order events — the relayer
              submits on-chain on your behalf. Only your buy/sell direction,
              limit price, and salt are sealed inside the commitment.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Sparkline chart ───────────────────────────────────────────────────────────

function SparklineChart({ points, positive }: { points: number[]; positive: boolean }) {
  if (points.length < 2) {
    // Single point or no data — render a flat line
    const color = positive ? "#22c55e" : "#ef4444";
    return (
      <svg viewBox="0 0 200 60" className="w-full h-full" preserveAspectRatio="none">
        <line x1="0" y1="30" x2="200" y2="30" stroke={color} strokeWidth="1.5" strokeOpacity="0.4" />
      </svg>
    );
  }

  const min = Math.min(...points);
  const max = Math.max(...points);
  const range = max - min || 1;
  const pad = 6;
  const w = 200, h = 60;

  const coords = points.map((v, i) => {
    const x = (i / (points.length - 1)) * w;
    const y = h - pad - ((v - min) / range) * (h - pad * 2);
    return [x, y];
  });

  const pathD = coords.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const areaD = `${pathD} L${w},${h} L0,${h} Z`;
  const color = positive ? "#22c55e" : "#ef4444";
  const gradId = `spark-${positive ? "pos" : "neg"}`;

  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-full" preserveAspectRatio="none">
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.25" />
          <stop offset="100%" stopColor={color} stopOpacity="0.02" />
        </linearGradient>
      </defs>
      <path d={areaD} fill={`url(#${gradId})`} />
      <path d={pathD} fill="none" stroke={color} strokeWidth="1.5" />
    </svg>
  );
}

// ── Pending order row (Active tab) ────────────────────────────────────────────

function PendingRow({ order }: { order: OrderEntry }) {
  return (
    <div className="border-b border-border last:border-b-0 p-4 flex items-center gap-4">
      <div className="flex-1 min-w-0 space-y-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className={clsx(
            "text-[9px] tracking-widest uppercase px-1.5 py-0.5 border font-mono",
            order.isBuy
              ? "border-accent/30 text-accent bg-accent/5"
              : "border-danger/30 text-danger bg-danger/5",
          )}>
            {order.isBuy ? "BUY YES" : "BUY NO"}
          </span>
          <span className={clsx(
            "text-[9px] tracking-widest uppercase px-1.5 py-0.5 border",
            order.batchStatus === BatchStatus.SETTLING
              ? "text-blue-400/60 border-blue-400/20 animate-pulse"
              : "text-muted border-border",
          )}>
            {order.batchStatus === BatchStatus.SETTLING ? "SETTLING" : "PENDING"}
          </span>
          <span className="text-[9px] text-muted-dim">{timeAgo(order.timestamp)}</span>
        </div>
        <p className="text-[12px] text-text leading-snug line-clamp-1">
          {order.marketQuestion ?? `Batch #${order.batchId}`}
        </p>
      </div>
      <div className="text-right flex-shrink-0">
        <p className="text-[12px] font-medium text-text tabular-nums">{fUsdc(order.rawAmount)}</p>
        <p className="text-[9px] text-muted-dim mt-0.5">sealed bid</p>
      </div>
    </div>
  );
}

// ── Closed position row (Closed tab, Polymarket-style) ─────────────────────────

function ClosedPositionRow({
  order,
  onClaim,
  isClaiming,
  claimError,
}: {
  order:      OrderEntry;
  onClaim:    (order: OrderEntry) => Promise<void>;
  isClaiming: boolean;
  claimError?: string;
}) {
  const canClaim = !order.claimed && (order.filledAmount ?? 0n) > 0n;

  const avgCents = order.clearingPrice && order.clearingPrice > 0n
    ? (Number(order.clearingPrice) / 1e4).toFixed(1) + "¢"
    : "—";

  const filledUsdc = order.filledAmount != null
    ? Number(order.filledAmount) / 1e6
    : Number(order.rawAmount) / 1e6;

  // For NO positions, current value uses the NO price (1 − yes)
  const outcomePrice = order.currentYesPrice != null
    ? (order.isBuy ? order.currentYesPrice : 1 - order.currentYesPrice)
    : null;

  const currentValue = order.shares != null && outcomePrice != null
    ? order.shares * outcomePrice
    : null;

  const pnl    = currentValue != null ? currentValue - filledUsdc : null;
  const pnlPct = pnl != null && filledUsdc > 0 ? (pnl / filledUsdc) * 100 : null;

  // Determine Won / Lost from market resolution (price near 0 or 1 means resolved)
  const isResolved  = outcomePrice != null && (outcomePrice > 0.9 || outcomePrice < 0.1);
  const won         = isResolved && outcomePrice! > 0.9;
  const lost        = isResolved && outcomePrice! < 0.1;

  return (
    <div className="border-b border-border last:border-b-0 p-4 space-y-3">
      <div className="flex items-start gap-3">

        {/* RESULT badge (fixed width, vertically centred) */}
        <div className="flex-shrink-0 w-16 pt-0.5">
          {won ? (
            <div className="flex items-center gap-1.5">
              <span className="w-5 h-5 rounded-full bg-accent/15 border border-accent/40 flex items-center justify-center text-[10px] text-accent flex-shrink-0">✓</span>
              <span className="text-[11px] font-medium text-accent">Won</span>
            </div>
          ) : lost ? (
            <div className="flex items-center gap-1.5">
              <span className="w-5 h-5 rounded-full bg-danger/15 border border-danger/40 flex items-center justify-center text-[10px] text-danger flex-shrink-0">✗</span>
              <span className="text-[11px] font-medium text-danger">Lost</span>
            </div>
          ) : (
            <span className="text-[10px] text-muted-dim">—</span>
          )}
        </div>

        {/* Market info */}
        <div className="flex-1 min-w-0 space-y-0.5">
          <p className="text-[12px] text-text leading-snug line-clamp-2">
            {order.marketQuestion
              ?? (order.marketId ? shortHash(order.marketId, 14, 8) : `Batch #${order.batchId}`)}
          </p>
          {/* Polymarket-style subtitle: "58.8 Yes at 34¢" */}
          <p className="text-[10px] text-muted-dim">
            {order.shares != null && order.shares > 0
              ? `${order.shares.toFixed(1)} ${order.isBuy ? "Yes" : "No"} at ${avgCents}`
              : avgCents}
            {order.claimed && (
              <span className="ml-2 text-accent/50">· claimed ✓</span>
            )}
          </p>
        </div>

        {/* Right: TOTAL TRADED | AMOUNT WON */}
        <div className="flex items-start gap-5 flex-shrink-0 text-right">
          <div className="min-w-[68px]">
            <p className="text-[9px] text-muted-dim tracking-widest uppercase mb-1">TOTAL TRADED</p>
            <p className="text-[12px] text-text tabular-nums font-mono">${filledUsdc.toFixed(2)}</p>
          </div>
          <div className="min-w-[88px]">
            <p className="text-[9px] text-muted-dim tracking-widest uppercase mb-1">AMOUNT WON</p>
            {currentValue != null ? (
              <div>
                <p className="text-[12px] text-text tabular-nums font-mono">${currentValue.toFixed(2)}</p>
                {pnl != null && (
                  <p className={clsx("text-[10px] tabular-nums font-medium", pnl >= 0 ? "text-accent" : "text-danger")}>
                    {pnl >= 0 ? "+" : ""}{pnl.toFixed(2)}
                    {pnlPct != null ? ` (${Math.abs(pnlPct).toFixed(0)}%)` : ""}
                  </p>
                )}
              </div>
            ) : (
              <p className="text-[12px] text-muted-dim">—</p>
            )}
          </div>
        </div>
      </div>

      {canClaim && (
        <div className="space-y-1">
          <button
            onClick={() => onClaim(order)}
            disabled={isClaiming}
            className="w-full py-1.5 border border-accent text-accent text-[10px] tracking-widest uppercase hover:bg-accent/5 transition-colors disabled:opacity-40"
          >
            {isClaiming ? (
              <span className="flex items-center justify-center gap-1.5">
                <span className="w-2.5 h-2.5 border border-current border-t-transparent rounded-full animate-spin" />
                CLAIMING… (~20s)
              </span>
            ) : "CLAIM POSITION"}
          </button>
          {claimError && !isClaiming && (
            <p className="text-danger text-[10px] text-center">{claimError}</p>
          )}
        </div>
      )}
    </div>
  );
}

// ── Position table row (Polymarket-style, full-width) ─────────────────────────

function PositionRow({
  order,
  onClaim,
  isClaiming,
  claimError,
}: {
  order:      OrderEntry;
  onClaim:    (order: OrderEntry) => Promise<void>;
  isClaiming: boolean;
  claimError?: string;
}) {

  const isPending  = order.batchStatus === BatchStatus.OPEN || order.batchStatus === BatchStatus.SETTLING;
  const isSettled  = order.batchStatus === BatchStatus.SETTLED;
  const canClaim   = isSettled && !order.claimed && (order.filledAmount ?? 0n) > 0n;

  const avgCents = order.clearingPrice && order.clearingPrice > 0n
    ? (Number(order.clearingPrice) / 1e4).toFixed(1) + "¢"
    : "—";

  const currCents = order.currentYesPrice != null
    ? (order.currentYesPrice * 100).toFixed(1) + "¢"
    : "—";

  const filledUsdc = order.filledAmount != null
    ? Number(order.filledAmount) / 1e6
    : Number(order.rawAmount) / 1e6;

  const currentValue = order.shares != null && order.currentYesPrice != null
    ? order.shares * order.currentYesPrice
    : null;

  const pnl    = currentValue != null ? currentValue - filledUsdc : null;
  const pnlPct = pnl != null && filledUsdc > 0 ? (pnl / filledUsdc) * 100 : null;

  return (
    <div className={clsx(
      "border-b border-border last:border-b-0 p-4 space-y-3",
      order.claimed && "opacity-50",
    )}>
      <div className="flex items-start gap-4">
        {/* Left: market info */}
        <div className="flex-1 min-w-0 space-y-1.5">
          {/* Direction + status badges */}
          <div className="flex items-center gap-2 flex-wrap">
            <span className={clsx(
              "text-[9px] tracking-widest uppercase px-1.5 py-0.5 border font-mono",
              order.isBuy
                ? "border-accent/30 text-accent bg-accent/5"
                : "border-danger/30 text-danger bg-danger/5",
            )}>
              {order.isBuy ? "YES" : "NO"}
            </span>
            {isPending && (
              <span className={clsx(
                "text-[9px] tracking-widest uppercase px-1.5 py-0.5 border",
                order.batchStatus === BatchStatus.SETTLING
                  ? "text-blue/60 border-blue/20 animate-pulse"
                  : "text-muted border-border",
              )}>
                {order.batchStatus === BatchStatus.SETTLING ? "SETTLING" : "PENDING"}
              </span>
            )}
            {order.claimed && (
              <span className="text-[9px] tracking-widest uppercase text-accent/50 border border-accent/20 px-1.5 py-0.5">
                CLAIMED ✓
              </span>
            )}
          </div>

          {/* Market question */}
          <p className="text-[12px] text-text leading-snug line-clamp-2">
            {order.marketQuestion
              ?? (order.marketId ? shortHash(order.marketId, 14, 8) : `Batch #${order.batchId}`)}
          </p>

          {/* Shares + cost */}
          {order.shares != null && order.shares > 0 && (
            <p className="text-[10px] text-muted-dim">
              {order.shares.toFixed(2)} shares
              {" · "}cost {fUsdc(order.filledAmount ?? order.rawAmount)}
            </p>
          )}
        </div>

        {/* Right: AVG | CURRENT | VALUE columns */}
        <div className="flex items-start gap-5 flex-shrink-0 text-right">
          {/* AVG */}
          <div className="min-w-[44px]">
            <p className="text-[9px] text-muted-dim tracking-widest uppercase mb-1">AVG</p>
            <p className="text-[11px] text-text tabular-nums font-mono">{avgCents}</p>
          </div>

          {/* CURRENT */}
          <div className="min-w-[54px]">
            <p className="text-[9px] text-muted-dim tracking-widest uppercase mb-1">CURRENT</p>
            <p className="text-[11px] text-text tabular-nums font-mono">{currCents}</p>
          </div>

          {/* VALUE */}
          <div className="min-w-[68px]">
            <p className="text-[9px] text-muted-dim tracking-widest uppercase mb-1">VALUE</p>
            {currentValue != null ? (
              <div>
                <p className="text-[11px] text-text tabular-nums font-mono">
                  ${currentValue.toFixed(2)}
                </p>
                {pnl != null && (
                  <p className={clsx(
                    "text-[9px] tabular-nums",
                    pnl >= 0 ? "text-accent" : "text-danger",
                  )}>
                    {pnl >= 0 ? "+" : ""}{pnl.toFixed(2)}
                    {pnlPct != null ? ` (${pnlPct.toFixed(0)}%)` : ""}
                  </p>
                )}
              </div>
            ) : (
              <p className="text-[11px] text-muted-dim">—</p>
            )}
          </div>
        </div>
      </div>

      {/* Claim button */}
      {canClaim && (
        <div className="space-y-1">
          <button
            onClick={() => onClaim(order)}
            disabled={isClaiming}
            className="w-full py-1.5 border border-accent text-accent text-[10px] tracking-widest uppercase hover:bg-accent/5 transition-colors disabled:opacity-40"
          >
            {isClaiming ? (
              <span className="flex items-center justify-center gap-1.5">
                <span className="w-2.5 h-2.5 border border-current border-t-transparent rounded-full animate-spin" />
                CLAIMING… (~20s)
              </span>
            ) : "CLAIM POSITION"}
          </button>
          {claimError && !isClaiming && (
            <p className="text-danger text-[10px] text-center">{claimError}</p>
          )}
        </div>
      )}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function ProfileClient() {
  const { ready, authenticated, login } = usePrivy();
  const { wallets } = useWallets();
  const walletAddress = wallets[0]?.address as `0x${string}` | undefined;

  const [orders,       setOrders]       = useState<OrderEntry[]>([]);
  const [usdcBalance,  setUsdcBalance]  = useState<bigint | null>(null);
  const [loading,      setLoading]      = useState(true);
  const [enriching,    setEnriching]    = useState(false);
  const [error,        setError]        = useState<string | null>(null);
  const [mainTab,      setMainTab]      = useState<"positions" | "activity">("positions");
  const [posTab,       setPosTab]       = useState<"active" | "closed">("active");
  const [claimingKey,   setClaimingKey]   = useState<string | null>(null);
  const [claimErrors,   setClaimErrors]   = useState<Record<string, string>>({});
  const [claimRecipient, setClaimRecipient] = useState<string>("");
  const [editingRecipient, setEditingRecipient] = useState(false);
  const [recipientDraft,   setRecipientDraft]   = useState("");
  const [toast, setToast] = useState<{ id: number; message: string; type: "success" | "error" } | null>(null);
  const toastIdRef = useRef(0);

  // Load saved payout address from localStorage when wallet connects
  useEffect(() => {
    if (!walletAddress) return;
    const saved = localStorage.getItem(`predacy:claim-recipient:${walletAddress.toLowerCase()}`);
    setClaimRecipient(saved ?? "");
  }, [walletAddress]);

  function pushToast(message: string, type: "success" | "error") {
    const id = ++toastIdRef.current;
    setToast({ id, message, type });
    setTimeout(() => setToast((t) => (t?.id === id ? null : t)), 4000);
  }

  const loadProfile = useCallback(async () => {
    if (!walletAddress) return;
    setLoading(true);
    setEnriching(false);
    setError(null);

    try {
      const contracts = getContracts(ACTIVE_CHAIN.id);

      // 1. USDC balance — non-blocking: RPC timeout here won't kill the rest of the load.
      //    Retried 3× with back-off before giving up; shows "—" in UI on failure.
      withRetry(() =>
        publicClient.readContract({
          address: contracts.usdc,
          abi: ERC20_ABI,
          functionName: "balanceOf",
          args: [walletAddress],
        }) as Promise<bigint>
      ).then(setUsdcBalance).catch(() => { /* show "—" in header, rest of profile still loads */ });

      // 2. Load orders from localStorage + merge with relayer remote history
      //    so the same wallet shows all orders on any device.
      const storageKey = `predacy:orders:${walletAddress.toLowerCase()}`;
      let storedOrders: StoredOrder[] = [];
      try {
        storedOrders = JSON.parse(localStorage.getItem(storageKey) ?? "[]");
      } catch { /* ignore quota / parse errors */ }

      // 2a. Fetch remote history from relayer (authenticated: one-time EIP-191 signature proves ownership)
      //     Signature is stored in localStorage permanently — Alice signs once per device, never again.
      //     Fixed message (no timestamp) means the same signature works forever.
      try {
        const relayerUrl = process.env.NEXT_PUBLIC_RELAYER_URL;
        const wallet     = wallets[0];
        if (relayerUrl && wallet) {
          const addr     = walletAddress.toLowerCase();
          const sigKey   = `predacy:history-sig:${addr}`;
          const message  = `Predacy: authorize history access for ${addr}`;

          // Reuse stored signature, or sign once and persist it forever
          let signature = localStorage.getItem(sigKey);
          if (!signature) {
            const provider  = await wallet.getEthereumProvider();
            const wc        = createWalletClient({ account: walletAddress, chain: ACTIVE_CHAIN, transport: custom(provider) });
            signature       = await wc.signMessage({ account: walletAddress, message });
            try { localStorage.setItem(sigKey, signature); } catch { /* ignore quota errors */ }
          }

          const resp = await fetch(`${relayerUrl}/history/${addr}`, {
            headers: { "X-Signature": signature },
          });
          if (resp.ok) {
            const { orders: remoteOrders } = await resp.json() as { orders: StoredOrder[] };
            if (Array.isArray(remoteOrders) && remoteOrders.length > 0) {
              // Build a set of known commitments from localStorage
              const knownCommitments = new Set(storedOrders.map((o) => o.commitment.toLowerCase()));
              // Merge: add remote orders not present locally (local takes precedence for claimed/salt/ephemeralKey)
              const newOrders = remoteOrders.filter(
                (o) => o.commitment && !knownCommitments.has(o.commitment.toLowerCase())
              );
              if (newOrders.length > 0) {
                // Prepend remote orders sorted by timestamp desc, then re-sort the whole array
                storedOrders = [...storedOrders, ...newOrders]
                  .sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0))
                  .slice(0, 200);
                // Persist merged set so future page loads are fast
                try { localStorage.setItem(storageKey, JSON.stringify(storedOrders)); } catch { /* ignore */ }
              }
            }
          }
        }
      } catch { /* remote fetch failure is non-fatal — show local only */ }

      if (storedOrders.length === 0) {
        setOrders([]);
        setLoading(false);
        return;
      }

      // storedOrders is newest-first (EventPageClient uses unshift; merge sorts desc)
      const entries: OrderEntry[] = storedOrders
        .map((o) => ({
          commitment:     o.commitment as `0x${string}`,
          salt:           o.salt,
          rawAmount:      BigInt(o.amount),
          isBuy:          o.isBuy,
          limitPrice:     BigInt(o.limitPrice),
          batchId:        BigInt(o.batchId),
          marketId:       (o.marketId ?? undefined) as `0x${string}` | undefined,
          marketQuestion: o.marketQuestion ?? undefined,
          timestamp:      o.timestamp,
          claimed:        o.claimed,
        }));

      setOrders(entries);
      setLoading(false);
      setEnriching(true);

      // 3. Fetch batch status + clearing price + tx hashes per unique batch
      const uniqueBatchIds = [...new Set(entries.map((e) => e.batchId))];
      const batchMap   = new Map<bigint, { status: number; clearingPrice: bigint }>();
      const txHashMap  = new Map<string, `0x${string}`>();

      await Promise.allSettled(
        uniqueBatchIds.map(async (batchId) => {
          try {
            const batch = await publicClient.readContract({
              address: contracts.batchVault,
              abi: BATCH_VAULT_ABI,
              functionName: "getBatch",
              args: [batchId],
            }) as { marketId: `0x${string}`; status: number; clearingPrice: bigint };
            batchMap.set(batchId, { status: batch.status, clearingPrice: batch.clearingPrice });

            const logs = await publicClient.getLogs({
              address: contracts.batchVault,
              event: ORDER_COMMITTED_EVENT,
              args: { batchId },
              fromBlock: 0n,
              toBlock: "latest",
            }).catch(async () => {
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
              if (c && log.transactionHash) txHashMap.set(c, log.transactionHash);
            }
          } catch { /* non-fatal */ }
        })
      );

      // 4. Enrich position data for SETTLED batches
      const posMap = new Map<string, {
        filledAmount: bigint; refundAmount: bigint; claimed: boolean;
      }>();

      const settledEntries = entries.filter((e) => {
        const b = batchMap.get(e.batchId);
        return b?.status === BatchStatus.SETTLED;
      });

      await Promise.allSettled(
        settledEntries.map(async (entry) => {
          try {
            const pos = await withRetry(() =>
              publicClient.readContract({
                address:      contracts.batchVault,
                abi:          BATCH_VAULT_ABI,
                functionName: "getPosition",
                args:         [entry.batchId, entry.commitment],
              }) as Promise<{ filledAmount: bigint; refundAmount: bigint; isBuy: boolean; claimed: boolean }>
            );

            // usedNullifiers is authoritative for claimed state
            let claimed = pos.claimed || entry.claimed === true;
            if (!claimed && entry.salt) {
              try {
                const nullifier = keccak256(
                  encodeAbiParameters(
                    [{ type: "bytes32" }, { type: "uint256" }, { type: "bytes32" }],
                    [entry.commitment, entry.batchId, entry.salt as `0x${string}`],
                  )
                );
                claimed = await withRetry(() =>
                  publicClient.readContract({
                    address:      contracts.batchVault,
                    abi:          BATCH_VAULT_ABI,
                    functionName: "usedNullifiers",
                    args:         [nullifier],
                  }) as Promise<boolean>
                );
                if (claimed) {
                  try {
                    const sk = `predacy:orders:${walletAddress.toLowerCase()}`;
                    const all: Array<Record<string, unknown>> = JSON.parse(localStorage.getItem(sk) ?? "[]");
                    localStorage.setItem(sk, JSON.stringify(
                      all.map((o) => o.batchId === entry.batchId.toString() ? { ...o, claimed: true } : o)
                    ));
                  } catch { /* ignore */ }
                }
              } catch { /* leave as unclaimed */ }
            }

            posMap.set(entry.commitment.toLowerCase(), {
              filledAmount: pos.filledAmount,
              refundAmount: pos.refundAmount,
              claimed,
            });
          } catch { /* non-fatal */ }
        })
      );

      // 5. Fetch current YES prices from Gamma API for all unique markets
      const priceMap = new Map<string, number>(); // marketId.lower() → YES price 0–1
      const uniqueMarketIds = [...new Set(
        entries.filter((e) => e.marketId).map((e) => e.marketId!)
      )];
      await Promise.allSettled(
        uniqueMarketIds.map(async (marketId) => {
          try {
            const conditionId = marketId.slice(2); // strip 0x
            // Route through the Next.js server proxy — direct Gamma calls from the
            // browser are blocked by CORS, which silently drops the catch and leaves
            // currentYesPrice as undefined.
            const r = await fetch(`/api/markets?condition_id=${conditionId}`);
            const data = await r.json();
            const prices = JSON.parse(data[0]?.outcomePrices ?? "[]");
            const yesPrice = parseFloat(prices[0] ?? "");
            // Store any valid number incl. 0 (resolved-NO markets sit near 0 but shouldn't be excluded)
            if (prices.length > 0 && !isNaN(yesPrice)) priceMap.set(marketId.toLowerCase(), yesPrice);
          } catch { /* non-fatal */ }
        })
      );

      // 6. Assemble enriched entries
      const enriched: OrderEntry[] = entries.map((e) => {
        const batchInfo   = batchMap.get(e.batchId);
        const posInfo     = posMap.get(e.commitment.toLowerCase());
        const clearingPrice = batchInfo?.clearingPrice ?? 0n;
        const filledAmount  = posInfo?.filledAmount ?? 0n;
        const currentYesPrice = priceMap.get((e.marketId ?? "").toLowerCase());

        const shares =
          clearingPrice > 0n && filledAmount > 0n
            ? Number(filledAmount * 1_000_000n / clearingPrice) / 1_000_000
            : undefined;

        return {
          ...e,
          txHash:          txHashMap.get(e.commitment.toLowerCase()),
          batchStatus:     batchInfo?.status as BatchStatus | undefined,
          clearingPrice:   clearingPrice > 0n ? clearingPrice : undefined,
          filledAmount:    posInfo ? filledAmount : undefined,
          refundAmount:    posInfo?.refundAmount,
          claimed:         posInfo?.claimed ?? e.claimed,
          currentYesPrice,
          shares,
        };
      });

      setOrders(enriched);
      setEnriching(false);
    } catch (e: unknown) {
      const raw = e instanceof Error ? e.message : "Failed to load profile";
      setError(cleanRpcError(raw));
      setLoading(false);
      setEnriching(false);
    }
  }, [walletAddress, wallets]);

  useEffect(() => {
    if (ready && authenticated && walletAddress) {
      loadProfile();
    }
  }, [ready, authenticated, walletAddress, loadProfile]);

  // ── Live price polling (every 15 s) ───────────────────────────────────────
  // Re-fetches Gamma API prices for all unique market IDs in the current orders
  // and patches currentYesPrice in-place so P&L / value numbers tick live.
  // We use a ref to read the latest orders without stale-closure issues.
  const ordersRef = useRef<OrderEntry[]>([]);
  useEffect(() => { ordersRef.current = orders; }, [orders]);

  useEffect(() => {
    if (!authenticated || !walletAddress) return;

    const poll = async () => {
      const current = ordersRef.current;
      if (current.length === 0) return;

      const uniqueIds = [...new Set(
        current.filter((o) => o.marketId).map((o) => o.marketId!)
      )];

      const results = await Promise.allSettled(
        uniqueIds.map((marketId) =>
          fetch(`/api/markets?condition_id=${marketId.slice(2)}`)
            .then((r) => r.json())
            .then((data) => {
              const prices = JSON.parse(data[0]?.outcomePrices ?? "[]");
              const yesPrice = parseFloat(prices[0] ?? "");
              return (prices.length > 0 && !isNaN(yesPrice))
                ? { marketId: marketId.toLowerCase(), yesPrice }
                : null;
            })
            .catch(() => null)
        )
      );

      const updated = new Map<string, number>();
      results.forEach((r) => {
        if (r.status === "fulfilled" && r.value) {
          updated.set(r.value.marketId, r.value.yesPrice);
        }
      });
      if (updated.size === 0) return;

      setOrders((prev) =>
        prev.map((o) => {
          const key = (o.marketId ?? "").toLowerCase();
          const fresh = updated.get(key);
          if (fresh == null || fresh === o.currentYesPrice) return o;
          return { ...o, currentYesPrice: fresh };
        })
      );
    };

    const id = setInterval(poll, 15_000);
    return () => clearInterval(id);
  }, [authenticated, walletAddress]);

  // ── Claim handler ─────────────────────────────────────────────────────────

  const handleClaim = async (order: OrderEntry) => {
    if (!walletAddress) return;
    const recipient = (claimRecipient || walletAddress) as `0x${string}`;
    const key = order.commitment.toLowerCase();
    setClaimingKey(key);
    setClaimErrors((prev) => { const n = { ...prev }; delete n[key]; return n; });

    try {
      const storageKey = `predacy:orders:${walletAddress.toLowerCase()}`;
      const storedOrders: Array<StoredOrder> =
        JSON.parse(localStorage.getItem(storageKey) ?? "[]");
      const myOrder = storedOrders.find((o) => o.batchId === order.batchId.toString());
      if (!myOrder)           throw new Error("Order preimage not found in local storage — cannot claim");
      if (!myOrder.marketId)  throw new Error("Order is missing marketId — cannot claim");

      const relayerUrl = process.env.NEXT_PUBLIC_RELAYER_URL;
      if (!relayerUrl) throw new Error("NEXT_PUBLIC_RELAYER_URL is not set");

      const resp = await fetch(`${relayerUrl}/claim-proof`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          batchId:    order.batchId.toString(),
          marketId:   myOrder.marketId,
          isBuy:      myOrder.isBuy,
          amount:     myOrder.amount,
          limitPrice: myOrder.limitPrice,
          salt:       myOrder.salt,
          recipient,
        }),
      });

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.error ?? `Claim request failed (${resp.status})`);
      }

      const { txHash } = await resp.json();
      const receipt = await publicClient.waitForTransactionReceipt({
        hash: txHash as `0x${string}`,
      });
      if (receipt.status === "reverted") {
        throw new Error("Claim transaction reverted — the batch may not be fully settled yet. Try again in a few seconds.");
      }

      // Mark claimed in localStorage
      try {
        const all: Array<Record<string, unknown>> = JSON.parse(localStorage.getItem(storageKey) ?? "[]");
        localStorage.setItem(storageKey, JSON.stringify(
          all.map((o) => o.batchId === order.batchId.toString() ? { ...o, claimed: true } : o)
        ));
      } catch { /* ignore */ }

      // Update UI optimistically
      setOrders((prev) =>
        prev.map((o) =>
          o.commitment === order.commitment ? { ...o, claimed: true } : o
        )
      );
      // Refresh USDC balance
      try {
        const contracts = getContracts(ACTIVE_CHAIN.id);
        const bal = await publicClient.readContract({
          address: contracts.usdc,
          abi: ERC20_ABI,
          functionName: "balanceOf",
          args: [walletAddress],
        }) as bigint;
        setUsdcBalance(bal);
      } catch { /* non-fatal */ }

      pushToast("Position claimed — payout sent to wallet.", "success");
    } catch (e: any) {
      if (e?.code !== 4001) {
        const msg = cleanClaimError(e?.message ?? "Claim failed");
        setClaimErrors((prev) => ({ ...prev, [key]: msg }));
        pushToast(msg, "error");
      }
    } finally {
      setClaimingKey(null);
    }
  };

  // ── Derived data ──────────────────────────────────────────────────────────

  const settledOrders = orders.filter((o) => o.batchStatus === BatchStatus.SETTLED);
  const totalVolume   = orders.reduce((s, o) => s + o.rawAmount, 0n);
  const totalOrders   = orders.length;

  // P&L: sum over settled positions that have live price data
  const pnlPositions = settledOrders.filter(
    (o) => o.shares != null && o.currentYesPrice != null && o.filledAmount != null
  );
  const hasPnlData = !enriching && pnlPositions.length > 0;
  const totalPnl = pnlPositions.reduce((sum, o) => {
    const currentValue = (o.shares ?? 0) * (o.currentYesPrice ?? 0);
    const cost = Number(o.filledAmount ?? 0n) / 1e6;
    return sum + currentValue - cost;
  }, 0);
  const pnlDisplay = hasPnlData
    ? (totalPnl >= 0 ? `+$${totalPnl.toFixed(2)}` : `-$${Math.abs(totalPnl).toFixed(2)}`)
    : (enriching ? "…" : "—");

  // Current value of unclaimed settled positions (shares × current outcome price).
  // Claimed positions are excluded — those shares are already redeemed into the USDC balance.
  const positionsValue = settledOrders.reduce((sum, o) => {
    if (o.claimed) return sum; // already redeemed — value sits in USDC balance instead
    if (!o.shares || o.currentYesPrice == null) return sum;
    const outcomePrice = o.isBuy ? o.currentYesPrice : 1 - o.currentYesPrice;
    return sum + o.shares * outcomePrice;
  }, 0);
  const hasUnclaimedSettled = settledOrders.some((o) => !o.claimed && o.shares != null);

  // Biggest single-position win (max positive P&L across all settled positions)
  const biggestWin = pnlPositions.reduce((best, o) => {
    const outcomePrice = o.isBuy ? (o.currentYesPrice ?? 0) : 1 - (o.currentYesPrice ?? 0);
    const cv = (o.shares ?? 0) * outcomePrice;
    const pnl = cv - Number(o.filledAmount ?? 0n) / 1e6;
    return pnl > best ? pnl : best;
  }, 0);

  // Sparkline: cumulative P&L across settled orders sorted by timestamp
  const sparkPoints = (() => {
    const sorted = pnlPositions.slice().sort((a, b) => a.timestamp - b.timestamp);
    let running = 0;
    const pts = [0]; // start at zero
    for (const o of sorted) {
      const outcomePrice = o.isBuy ? (o.currentYesPrice ?? 0) : 1 - (o.currentYesPrice ?? 0);
      const cv = (o.shares ?? 0) * outcomePrice;
      running += cv - Number(o.filledAmount ?? 0n) / 1e6;
      pts.push(running);
    }
    return pts;
  })();

  // Joined date from earliest order timestamp
  const joinedDate = orders.length > 0
    ? new Date(Math.min(...orders.map((o) => o.timestamp))).toLocaleDateString("en-US", { month: "short", year: "numeric" })
    : null;

  const shortAddr     = walletAddress
    ? `${walletAddress.slice(0, 6)}…${walletAddress.slice(-4)}`
    : "";

  // Polymarket semantics:
  // Active  = pending bids (OPEN/SETTLING) + settled positions where underlying market hasn't resolved
  // Closed  = settled positions where market resolved (price < 5% or > 95%)
  const activeOrders = orders.filter((o) => {
    if (o.batchStatus === BatchStatus.OPEN || o.batchStatus === BatchStatus.SETTLING) return true;
    if (o.batchStatus !== BatchStatus.SETTLED) return false;
    const yp = o.currentYesPrice;
    if (yp == null) return true; // no price data yet → treat as active
    return yp >= 0.05 && yp <= 0.95; // market still live
  });
  const closedOrders = orders.filter((o) => {
    if (o.batchStatus !== BatchStatus.SETTLED) return false;
    const yp = o.currentYesPrice;
    return yp != null && (yp < 0.05 || yp > 0.95); // market resolved
  });
  // Within active: split pending bids vs settled (live) positions
  const pendingOrders = activeOrders.filter((o) =>
    o.batchStatus === BatchStatus.OPEN || o.batchStatus === BatchStatus.SETTLING
  );
  const livePositions = activeOrders.filter((o) =>
    o.batchStatus === BatchStatus.SETTLED
  );

  // ── Not ready ─────────────────────────────────────────────────────────────
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

  return (
    <div className="min-h-screen bg-bg flex flex-col">
      {/* ── Top nav ───────────────────────────────────────────────────────── */}
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
        {/* ── Profile cards (Polymarket-style two-panel) ────────────────── */}
        <div className="grid grid-cols-1 md:grid-cols-2 border border-border">

          {/* ── Left card: identity + stats ─────────────────────────── */}
          <div className="p-5 md:border-r md:border-border space-y-5">
            {/* Avatar + handle + address */}
            <div className="flex items-center gap-4">
              <WalletAvatar address={walletAddress ?? ""} size={64} />
              <div className="min-w-0 flex-1">
                <p
                  className="text-xl font-black text-text tracking-tight leading-none mb-1"
                  style={{ fontFamily: "var(--font-display)" }}
                >
                  {walletAddress ? walletAddress.slice(2, 6).toUpperCase() : "——"}
                </p>
                <p className="text-[10px] text-muted-dim">
                  {joinedDate ? `Joined ${joinedDate}` : "Predacy Trader"}
                </p>
              </div>
              <div className="flex items-center gap-1.5 flex-shrink-0">
                <CopyButton value={walletAddress ?? ""} label="copy" />
                <a
                  href={`${EXPLORER}/address/${walletAddress}`}
                  target="_blank" rel="noopener noreferrer"
                  className="text-[10px] text-muted hover:text-accent border border-border px-1.5 py-0.5 transition-colors"
                >
                  ↗
                </a>
              </div>
            </div>

            {/* Stats row */}
            <div className="flex items-start gap-0 divide-x divide-border">
              <div className="pr-5">
                <p className="text-base font-black text-text leading-tight" style={{ fontFamily: "var(--font-display)" }}>
                  {usdcBalance === null ? "…" : `$${(Number(usdcBalance) / 1e6).toFixed(2)}`}
                </p>
                <p className="text-[10px] text-muted-dim mt-0.5">USDC Balance</p>
              </div>
              <div className="px-5">
                <p className="text-base font-black text-text leading-tight" style={{ fontFamily: "var(--font-display)" }}>
                  {enriching
                    ? "…"
                    : hasUnclaimedSettled
                      ? `$${positionsValue.toFixed(2)}`
                      : "—"}
                </p>
                <p className="text-[10px] text-muted-dim mt-0.5">Positions Value</p>
              </div>
              <div className="px-5">
                <p className="text-base font-black text-text leading-tight" style={{ fontFamily: "var(--font-display)" }}>
                  {loading ? "—" : totalOrders}
                </p>
                <p className="text-[10px] text-muted-dim mt-0.5">Predictions</p>
              </div>
              <div className="pl-5">
                <p className="text-base font-black text-accent leading-tight" style={{ fontFamily: "var(--font-display)" }}>
                  ZK ✓
                </p>
                <p className="text-[10px] text-muted-dim mt-0.5">Privacy</p>
              </div>
            </div>

            {/* Payout address */}
            <div className="border-t border-border/50 pt-3">
              {!editingRecipient ? (
                <div className="flex items-center gap-2">
                  <span className="text-[9px] text-muted tracking-widest uppercase whitespace-nowrap flex-shrink-0">
                    Payout
                  </span>
                  <span className="hash-text text-[10px] text-muted-dim flex-1 truncate">
                    {claimRecipient || walletAddress}
                  </span>
                  {claimRecipient && claimRecipient.toLowerCase() !== walletAddress?.toLowerCase() && (
                    <span className="text-[9px] text-accent/50 flex-shrink-0">↳ custom</span>
                  )}
                  <button
                    onClick={() => { setRecipientDraft(claimRecipient); setEditingRecipient(true); }}
                    className="flex-shrink-0 text-[9px] text-muted hover:text-text border border-border px-2 py-0.5 tracking-widest transition-colors"
                  >
                    EDIT
                  </button>
                </div>
              ) : (
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <span className="text-[9px] text-muted tracking-widest uppercase whitespace-nowrap flex-shrink-0">Payout</span>
                    <input
                      type="text"
                      value={recipientDraft}
                      onChange={(e) => setRecipientDraft(e.target.value)}
                      placeholder={walletAddress ?? ""}
                      autoFocus
                      className="flex-1 bg-surface border border-border px-2 py-1 text-[10px] font-mono text-text placeholder-muted-dim focus:outline-none focus:border-accent/40"
                    />
                  </div>
                  <div className="flex gap-2 items-center">
                    <button
                      onClick={() => {
                        const addr = recipientDraft.trim();
                        if (addr && !/^0x[0-9a-fA-F]{40}$/.test(addr)) return;
                        if (walletAddress) {
                          const key = `predacy:claim-recipient:${walletAddress.toLowerCase()}`;
                          if (addr) { localStorage.setItem(key, addr); setClaimRecipient(addr); }
                          else      { localStorage.removeItem(key);    setClaimRecipient("");   }
                        }
                        setEditingRecipient(false);
                      }}
                      disabled={recipientDraft.trim() !== "" && !/^0x[0-9a-fA-F]{40}$/.test(recipientDraft.trim())}
                      className="px-3 py-1 border border-accent text-accent text-[9px] tracking-widest uppercase hover:bg-accent/5 transition-colors disabled:opacity-30"
                    >
                      SAVE
                    </button>
                    <button
                      onClick={() => setEditingRecipient(false)}
                      className="px-3 py-1 border border-border text-muted text-[9px] tracking-widest uppercase hover:text-text transition-colors"
                    >
                      CANCEL
                    </button>
                    {claimRecipient && (
                      <button
                        onClick={() => {
                          if (walletAddress) localStorage.removeItem(`predacy:claim-recipient:${walletAddress.toLowerCase()}`);
                          setClaimRecipient(""); setRecipientDraft(""); setEditingRecipient(false);
                        }}
                        className="ml-auto text-[9px] text-muted-dim hover:text-danger transition-colors tracking-widest"
                      >
                        RESET
                      </button>
                    )}
                  </div>
                  <p className="text-[9px] text-muted-dim">
                    {claimRecipient && claimRecipient.toLowerCase() !== walletAddress?.toLowerCase()
                      ? <span className="text-accent/60">↳ custom address — payouts routed privately</span>
                      : <span>↳ use a fresh address for full claim privacy</span>}
                  </p>
                </div>
              )}
            </div>
          </div>

          {/* ── Right card: Profit/Loss + sparkline ─────────────────── */}
          <div className="p-5 flex flex-col">
            {/* Header row */}
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-1.5">
                <span className={clsx(
                  "text-[11px]",
                  !hasPnlData ? "text-muted" : totalPnl >= 0 ? "text-accent" : "text-danger",
                )}>
                  {!hasPnlData ? "◆" : totalPnl >= 0 ? "▲" : "▼"}
                </span>
                <span className="text-[12px] font-medium text-text tracking-wide">Profit/Loss</span>
              </div>
              <span className="text-[9px] text-accent/50 border border-accent/20 px-1.5 py-0.5 tracking-widest">
                ZK SEALED
              </span>
            </div>

            {/* P&L amount */}
            <p
              className={clsx(
                "text-3xl font-black leading-tight mb-0.5",
                !hasPnlData ? "text-muted" : totalPnl >= 0 ? "text-accent" : "text-danger",
              )}
              style={{ fontFamily: "var(--font-display)" }}
            >
              {enriching ? "…" : (hasPnlData
                ? (totalPnl >= 0 ? `+$${totalPnl.toFixed(2)}` : `-$${Math.abs(totalPnl).toFixed(2)}`)
                : "$0.00"
              )}
            </p>
            <p className="text-[10px] text-muted-dim mb-4">
              All-Time P&amp;L
            </p>

            {/* Sparkline */}
            <div className="flex-1 min-h-[56px]">
              <SparklineChart points={sparkPoints} positive={totalPnl >= 0} />
            </div>
          </div>

        </div>

        {/* ── Privacy breakdown ─────────────────────────────────────────── */}
        <div className="border border-border p-5 space-y-4">
          <div className="flex items-center gap-2">
            <div className="w-1 h-4 bg-accent/40" />
            <p className="text-[10px] text-muted tracking-widest uppercase">
              What&apos;s On-Chain vs What&apos;s Hidden
            </p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <p className="text-[9px] text-muted/60 uppercase tracking-widest mb-2">◆ Visible on-chain (public)</p>
              {[
                ["Commitment hash", "sealed keccak256"],
                ["Batch ID",        "sequential integer"],
              ].map(([label, sub]) => (
                <div key={label} className="flex items-start justify-between gap-4 bg-surface/30 px-3 py-2">
                  <span className="text-[11px] text-muted">{label}</span>
                  <span className="text-[10px] text-muted-dim text-right shrink-0">{sub}</span>
                </div>
              ))}
            </div>
            <div className="space-y-2">
              <p className="text-[9px] text-accent/60 uppercase tracking-widest mb-2">✓ Cryptographically hidden (private)</p>
              {[
                ["Your wallet address", "never in any event"],
                ["Amount deposited",    "relayer pays on-chain"],
                ["Buy / Sell direction","sealed in commitment"],
                ["Your limit price",   "sealed in commitment"],
                ["Random salt",        "blinding factor"],
                ["Clearing price",     "hidden until settlement"],
              ].map(([label, sub]) => (
                <div key={label} className="flex items-start justify-between gap-4 bg-accent/5 border border-accent/10 px-3 py-2">
                  <span className="text-[11px] text-accent/80">{label}</span>
                  <span className="text-[10px] text-accent/40 text-right shrink-0">{sub}</span>
                </div>
              ))}
            </div>
          </div>
          <div className="border-t border-border/40 pt-3 space-y-2">
            <p className="text-[10px] text-muted-dim leading-relaxed">
              <span className="text-accent/50">// </span>
              No wallet address or amount ever appears on-chain when you place an order. The relayer
              holds USDC and calls <code className="hash-text">commitOrderFor()</code> on your behalf.
            </p>
          </div>
        </div>

        {/* ── Positions / Activity tabs ─────────────────────────────────── */}
        <div className="space-y-0">
          {/* Main tab bar */}
          <div className="flex items-center gap-0 border-b border-border">
            {(["positions", "activity"] as const).map((tab) => (
              <button
                key={tab}
                type="button"
                onClick={() => setMainTab(tab)}
                className={clsx(
                  "px-4 py-2.5 text-[11px] tracking-widest uppercase transition-colors border-b-2",
                  mainTab === tab
                    ? "border-text/40 text-text"
                    : "border-transparent text-muted hover:text-text",
                )}
              >
                {tab === "positions" ? "Positions" : "Activity"}
              </button>
            ))}
            {enriching && (
              <span className="ml-auto mr-2 text-[9px] text-muted-dim tracking-widest flex items-center gap-1">
                <span className="w-2 h-2 border border-current border-t-transparent rounded-full animate-spin" />
                enriching…
              </span>
            )}
          </div>

          {/* ── POSITIONS TAB ──────────────────────────────────────────── */}
          {mainTab === "positions" && (
            <div>
              {/* Active / Closed sub-tabs */}
              <div className="flex items-center gap-5 px-1 border-b border-border/50">
                {(["active", "closed"] as const).map((sub) => {
                  const count = sub === "active" ? activeOrders.length : closedOrders.length;
                  return (
                    <button
                      key={sub}
                      type="button"
                      onClick={() => setPosTab(sub)}
                      className={clsx(
                        "py-2.5 text-[10px] tracking-widest uppercase transition-colors flex items-center gap-1.5",
                        posTab === sub ? "text-text" : "text-muted hover:text-text",
                      )}
                    >
                      {sub === "active" ? "Active" : "Closed"}
                      {count > 0 && (
                        <span className={clsx(
                          "text-[8px] px-1 py-0.5 border tabular-nums",
                          posTab === sub ? "border-text/30 text-text" : "border-border text-muted-dim",
                        )}>
                          {count}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>

              {/* ── ACTIVE SUB-TAB: pending orders only ────────────────── */}
              {posTab === "active" && (
                loading ? (
                  <div className="border border-border divide-y divide-border">
                    <SkeletonRow /><SkeletonRow /><SkeletonRow />
                  </div>
                ) : error ? (
                  <div className="border border-danger/20 p-6 text-center space-y-2">
                    <p className="text-danger text-[11px]">{error}</p>
                    <button onClick={loadProfile} className="text-[10px] text-muted hover:text-text border border-border px-3 py-1">↻ RETRY</button>
                  </div>
                ) : activeOrders.length === 0 ? (
                  <div className="border border-border p-10 text-center space-y-3">
                    <div className="w-8 h-8 border border-border flex items-center justify-center mx-auto">
                      <div className="w-2 h-2 bg-muted/30" />
                    </div>
                    <p className="text-muted text-[11px] tracking-widest uppercase">No active positions</p>
                    <p className="text-muted-dim text-[10px]">Open bids and live positions appear here.</p>
                    <Link href="/" className="inline-block mt-1 text-[10px] text-accent/70 hover:text-accent border border-accent/20 hover:border-accent/40 px-3 py-1">
                      Browse markets →
                    </Link>
                  </div>
                ) : (
                  <div className="border border-border">
                    {/* Pending bids section */}
                    {pendingOrders.length > 0 && (
                      <div className="divide-y divide-border">
                        {pendingOrders.map((o) => (
                          <PendingRow key={o.commitment} order={o} />
                        ))}
                      </div>
                    )}
                    {/* Live settled positions (market unresolved) */}
                    {livePositions.length > 0 && (
                      <>
                        {/* Column headers */}
                        <div className={clsx(
                          "hidden md:flex items-center gap-4 px-4 py-2 border-border/40",
                          pendingOrders.length > 0 ? "border-t" : "border-b",
                        )}>
                          <div className="flex-1">
                            <span className="text-[9px] text-muted-dim tracking-widest uppercase">MARKET</span>
                          </div>
                          <div className="flex items-center gap-5 flex-shrink-0 text-right">
                            <span className="min-w-[44px] text-[9px] text-muted-dim tracking-widest uppercase text-right">AVG</span>
                            <span className="min-w-[54px] text-[9px] text-muted-dim tracking-widest uppercase text-right">CURRENT</span>
                            <span className="min-w-[68px] text-[9px] text-muted-dim tracking-widest uppercase text-right">VALUE</span>
                          </div>
                        </div>
                        <div className="divide-y divide-border border-t border-border/40">
                          {livePositions.map((o) => (
                            <PositionRow
                              key={o.commitment}
                              order={o}
                              onClaim={handleClaim}
                              isClaiming={claimingKey === o.commitment.toLowerCase()}
                              claimError={claimErrors[o.commitment.toLowerCase()]}
                            />
                          ))}
                        </div>
                      </>
                    )}
                  </div>
                )
              )}

              {/* ── CLOSED SUB-TAB: all settled positions ──────────────── */}
              {posTab === "closed" && (
                loading ? (
                  <div className="border border-border divide-y divide-border">
                    <SkeletonRow /><SkeletonRow />
                  </div>
                ) : closedOrders.length === 0 ? (
                  <div className="border border-border p-10 text-center">
                    <p className="text-muted text-[11px] tracking-widest uppercase">No closed positions yet</p>
                    <p className="text-muted-dim text-[10px] mt-2">Positions in resolved markets appear here.</p>
                  </div>
                ) : (
                  <>
                    {/* Column headers */}
                    <div className="hidden md:flex items-center gap-3 px-4 py-2 border-b border-border/40">
                      <div className="w-16 flex-shrink-0">
                        <span className="text-[9px] text-muted-dim tracking-widest uppercase">RESULT</span>
                      </div>
                      <div className="flex-1">
                        <span className="text-[9px] text-muted-dim tracking-widest uppercase">MARKET</span>
                      </div>
                      <div className="flex items-center gap-5 flex-shrink-0 text-right">
                        <span className="min-w-[68px] text-[9px] text-muted-dim tracking-widest uppercase text-right">TOTAL TRADED</span>
                        <span className="min-w-[88px] text-[9px] text-muted-dim tracking-widest uppercase text-right">AMOUNT WON</span>
                      </div>
                    </div>
                    <div className="border border-border divide-y divide-border">
                      {closedOrders.map((o) => (
                        <ClosedPositionRow
                          key={o.commitment}
                          order={o}
                          onClaim={handleClaim}
                          isClaiming={claimingKey === o.commitment.toLowerCase()}
                          claimError={claimErrors[o.commitment.toLowerCase()]}
                        />
                      ))}
                    </div>
                  </>
                )
              )}
            </div>
          )}

          {/* ── ACTIVITY TAB ──────────────────────────────────────────── */}
          {mainTab === "activity" && (
            <div>
              <div className="flex items-center justify-between px-4 py-2.5 border-b border-border/40">
                <span className="text-[9px] text-muted-dim tracking-widest uppercase">
                  {loading ? "…" : `${totalOrders} orders`}
                </span>
                <span className="text-[9px] text-muted-dim border border-border px-2 py-0.5">
                  stored locally · click to reveal proof
                </span>
              </div>

              {loading ? (
                <div className="border border-border divide-y divide-border">
                  <SkeletonRow /><SkeletonRow /><SkeletonRow />
                </div>
              ) : error ? (
                <div className="border border-danger/20 p-6 text-center space-y-2">
                  <p className="text-danger text-[11px]">{error}</p>
                  <button onClick={loadProfile} className="text-[10px] text-muted hover:text-text border border-border px-3 py-1">↻ RETRY</button>
                </div>
              ) : orders.length === 0 ? (
                <div className="border border-border p-10 text-center space-y-3">
                  <div className="w-8 h-8 border border-border flex items-center justify-center mx-auto">
                    <div className="w-2 h-2 bg-muted/30" />
                  </div>
                  <p className="text-muted text-[11px] tracking-widest uppercase">No orders yet</p>
                  <p className="text-muted-dim text-[10px]">
                    Place a sealed-bid order on any market — it will appear here
                  </p>
                  <Link
                    href="/"
                    className="inline-block mt-1 text-[10px] text-accent/70 hover:text-accent border border-accent/20 hover:border-accent/40 px-3 py-1"
                  >
                    Browse markets →
                  </Link>
                </div>
              ) : (
                <div className="border border-border divide-y divide-border">
                  {orders.map((order) => (
                    <ActivityRow
                      key={`${order.commitment}-${order.batchId}`}
                      order={order}
                    />
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ── Footer ────────────────────────────────────────────────────────── */}
      <footer className="border-t border-border px-6 py-3 flex items-center justify-between">
        <span className="text-[10px] text-muted-dim tracking-widest">
          Predacy · Private Prediction Markets
        </span>
        <span className="text-[10px] text-muted-dim">
          <span className="text-accent/30">●</span> No address or amount in any order event
        </span>
      </footer>

      {/* ── Toast ─────────────────────────────────────────────────────────── */}
      {toast && (
        <div
          key={toast.id}
          className={clsx(
            "fixed bottom-6 left-1/2 -translate-x-1/2 z-50",
            "px-4 py-3 border text-[11px] tracking-wide animate-slide-up",
            "shadow-lg max-w-xs w-full",
            toast.type === "success"
              ? "bg-surface border-accent/40 text-accent"
              : "bg-surface border-danger/40 text-danger",
          )}
        >
          <div className="flex items-center gap-2">
            {toast.type === "success" ? (
              <svg className="w-3.5 h-3.5 flex-shrink-0" viewBox="0 0 14 14" fill="none">
                <path d="M2 7l3.5 3.5L12 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square" />
              </svg>
            ) : (
              <svg className="w-3.5 h-3.5 flex-shrink-0" viewBox="0 0 14 14" fill="none">
                <path d="M2 2l10 10M12 2L2 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square" />
              </svg>
            )}
            {toast.message}
          </div>
        </div>
      )}
    </div>
  );
}
