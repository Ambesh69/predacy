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
              <p className="text-[11px] text-muted-dim">
                {isPending ? "—" : `$${filledUsdc.toFixed(2)}`}
              </p>
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

      // 1. USDC balance
      const balance = await publicClient.readContract({
        address: contracts.usdc,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [walletAddress],
      }) as bigint;
      setUsdcBalance(balance);

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
            const pos = await publicClient.readContract({
              address:      contracts.batchVault,
              abi:          BATCH_VAULT_ABI,
              functionName: "getPosition",
              args:         [entry.batchId, entry.commitment],
            }) as { filledAmount: bigint; refundAmount: bigint; isBuy: boolean; claimed: boolean };

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
            const r = await fetch(
              `https://gamma-api.polymarket.com/markets?condition_id=${conditionId}`
            );
            const data = await r.json();
            const prices = JSON.parse(data[0]?.outcomePrices ?? "[]");
            const yesPrice = parseFloat(prices[0] ?? "0");
            if (yesPrice > 0) priceMap.set(marketId.toLowerCase(), yesPrice);
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
      const msg = e instanceof Error ? e.message : "Failed to load profile";
      setError(msg);
      setLoading(false);
      setEnriching(false);
    }
  }, [walletAddress, wallets]);

  useEffect(() => {
    if (ready && authenticated && walletAddress) {
      loadProfile();
    }
  }, [ready, authenticated, walletAddress, loadProfile]);

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
  const shortAddr     = walletAddress
    ? `${walletAddress.slice(0, 6)}…${walletAddress.slice(-4)}`
    : "";

  // Active: OPEN/SETTLING orders + SETTLED unclaimed with filledAmount > 0
  const activeOrders = orders.filter((o) =>
    o.batchStatus === BatchStatus.OPEN ||
    o.batchStatus === BatchStatus.SETTLING ||
    (o.batchStatus === BatchStatus.SETTLED && !o.claimed && (o.filledAmount ?? 0n) > 0n)
  );
  // Closed: SETTLED + claimed
  const closedOrders = orders.filter((o) =>
    o.batchStatus === BatchStatus.SETTLED && o.claimed
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
        {/* ── Profile hero ──────────────────────────────────────────────── */}
        <div className="border border-border p-5 md:p-6">
          <div className="flex flex-col md:flex-row items-start md:items-center gap-5 md:gap-0">

            {/* Avatar + identity */}
            <div className="flex items-center gap-4 md:pr-6 md:mr-6 md:border-r md:border-border flex-shrink-0">
              <WalletAvatar address={walletAddress ?? ""} size={56} />
              <div className="min-w-0">
                <p
                  className="text-lg font-black text-text tracking-tight leading-none mb-1"
                  style={{ fontFamily: "var(--font-display)" }}
                >
                  {walletAddress ? walletAddress.slice(2, 6).toUpperCase() : "——"}
                </p>
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="hash-text text-[11px] text-muted">{shortAddr}</span>
                  <CopyButton value={walletAddress ?? ""} label="copy" />
                  <a
                    href={`${EXPLORER}/address/${walletAddress}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[10px] text-accent/60 hover:text-accent transition-colors tracking-wider"
                  >
                    ↗
                  </a>
                </div>
              </div>
            </div>

            {/* Stats strip */}
            <div className="flex items-start flex-wrap gap-y-4 divide-x divide-border w-full md:w-auto">
              {([
                { label: "BALANCE", value: usdcBalance === null ? "—" : `$${(Number(usdcBalance) / 1e6).toFixed(2)}`, sub: "available",    accent: false },
                { label: "VOLUME",  value: `$${(Number(totalVolume) / 1e6).toFixed(2)}`,                              sub: "total placed", accent: false },
                { label: "ORDERS",  value: loading ? "—" : String(totalOrders),                                       sub: "sealed bids",  accent: false },
                { label: "PRIVACY", value: "ZK ✓",                                                                    sub: "proof system", accent: true  },
              ] as const).map((stat) => (
                <div key={stat.label} className="px-5 first:pl-0 md:first:pl-5">
                  <p className="text-[9px] text-muted tracking-widest uppercase mb-1">{stat.label}</p>
                  <p
                    className={`text-xl font-black leading-tight ${stat.accent ? "text-accent" : "text-text"}`}
                    style={{ fontFamily: "var(--font-display)" }}
                  >
                    {stat.value}
                  </p>
                  <p className="text-[9px] text-muted-dim mt-0.5">{stat.sub}</p>
                </div>
              ))}
            </div>

          </div>
        </div>

        {/* ── Payout address (compact strip) ────────────────────────────── */}
        <div className="border border-border border-t-0">
          {!editingRecipient ? (
            <div className="px-5 py-2.5 flex items-center gap-3">
              <span className="text-[9px] text-muted tracking-widest uppercase whitespace-nowrap flex-shrink-0">
                Payout
              </span>
              <span className="hash-text text-[11px] text-muted-dim flex-1 truncate">
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
            <div className="px-5 py-3 space-y-2">
              <div className="flex items-center gap-2">
                <span className="text-[9px] text-muted tracking-widest uppercase whitespace-nowrap flex-shrink-0">
                  Payout
                </span>
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
                      setClaimRecipient("");
                      setRecipientDraft("");
                      setEditingRecipient(false);
                    }}
                    className="ml-auto text-[9px] text-muted-dim hover:text-danger transition-colors tracking-widest"
                  >
                    RESET
                  </button>
                )}
              </div>
              <p className="text-[9px] text-muted-dim">
                {claimRecipient && claimRecipient.toLowerCase() !== walletAddress?.toLowerCase()
                  ? <span className="text-accent/60">↳ custom address set — payouts routed privately</span>
                  : <span>↳ use a fresh address for full claim privacy</span>
                }
              </p>
            </div>
          )}
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

              {/* Column headers (desktop) */}
              <div className="hidden md:flex items-center gap-4 px-4 py-2 border-b border-border/40">
                <div className="flex-1">
                  <span className="text-[9px] text-muted-dim tracking-widest uppercase">MARKET</span>
                </div>
                <div className="flex items-center gap-5 flex-shrink-0 text-right">
                  <span className="min-w-[44px] text-[9px] text-muted-dim tracking-widest uppercase text-right">AVG</span>
                  <span className="min-w-[54px] text-[9px] text-muted-dim tracking-widest uppercase text-right">CURRENT</span>
                  <span className="min-w-[68px] text-[9px] text-muted-dim tracking-widest uppercase text-right">VALUE</span>
                </div>
              </div>

              {/* Active positions */}
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
                    <p className="text-muted-dim text-[10px]">Settled unclaimed positions will appear here.</p>
                    <Link href="/" className="inline-block mt-1 text-[10px] text-accent/70 hover:text-accent border border-accent/20 hover:border-accent/40 px-3 py-1">
                      Browse markets →
                    </Link>
                  </div>
                ) : (
                  <div className="border border-border divide-y divide-border">
                    {activeOrders.map((o) => (
                      <PositionRow
                        key={o.commitment}
                        order={o}
                        onClaim={handleClaim}
                        isClaiming={claimingKey === o.commitment.toLowerCase()}
                        claimError={claimErrors[o.commitment.toLowerCase()]}
                      />
                    ))}
                  </div>
                )
              )}

              {/* Closed positions */}
              {posTab === "closed" && (
                loading ? (
                  <div className="border border-border divide-y divide-border">
                    <SkeletonRow /><SkeletonRow />
                  </div>
                ) : closedOrders.length === 0 ? (
                  <div className="border border-border p-10 text-center">
                    <p className="text-muted text-[11px] tracking-widest uppercase">No closed positions yet</p>
                    <p className="text-muted-dim text-[10px] mt-2">Claimed positions will appear here.</p>
                  </div>
                ) : (
                  <div className="border border-border divide-y divide-border">
                    {closedOrders.map((o) => (
                      <PositionRow
                        key={o.commitment}
                        order={o}
                        onClaim={handleClaim}
                        isClaiming={false}
                      />
                    ))}
                  </div>
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
