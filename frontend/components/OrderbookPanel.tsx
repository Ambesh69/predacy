"use client";

import { useState, useEffect } from "react";
import { clsx } from "clsx";
import type { Market } from "@/lib/polymarket";

interface OrderbookEntry {
  price: string;
  size: string;
}

interface OrderbookData {
  bids: OrderbookEntry[];
  asks: OrderbookEntry[];
}

const LEVELS = 8; // rows to show per side
const REFRESH_MS = 5_000;

function formatPrice(p: number) {
  return (p * 100).toFixed(1) + "¢";
}

function formatSize(size: number, price: number) {
  const usd = size * price;
  if (usd >= 1000) return "$" + (usd / 1000).toFixed(1) + "k";
  return "$" + usd.toFixed(0);
}

export default function OrderbookPanel({ market }: { market: Market | null }) {
  const [data, setData]       = useState<OrderbookData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState<string | null>(null);
  const [tick, setTick]       = useState(0); // bumped by auto-refresh + manual ↻

  const tokenId = market?.clobTokenIds?.[0]; // YES token

  // Fetch orderbook whenever token or tick changes
  useEffect(() => {
    if (!tokenId) { setData(null); return; }
    setLoading(true);
    setError(null);
    fetch(`/api/orderbook?token_id=${encodeURIComponent(tokenId)}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.error) throw new Error(d.error);
        setData(d as OrderbookData);
      })
      .catch((e) => setError(e.message ?? "Failed to load"))
      .finally(() => setLoading(false));
  }, [tokenId, tick]);

  // Auto-refresh every 5s
  useEffect(() => {
    if (!tokenId) return;
    const id = setInterval(() => setTick((t) => t + 1), REFRESH_MS);
    return () => clearInterval(id);
  }, [tokenId]);

  // ── Empty / no CLOB state ────────────────────────────────────────────────
  if (!market) {
    return (
      <div className="flex flex-col items-center justify-center flex-1 gap-2 px-6 py-12 text-center">
        <svg className="w-5 h-5 text-muted-dim" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
            d="M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 10V7" />
        </svg>
        <p className="text-[11px] text-muted tracking-widest uppercase">Select an outcome</p>
        <p className="text-[10px] text-muted-dim">Click any outcome to view its live orderbook</p>
      </div>
    );
  }

  if (!tokenId) {
    return (
      <div className="flex flex-col items-center justify-center flex-1 gap-2 px-6 py-12 text-center">
        <p className="text-[11px] text-muted-dim">Orderbook not available for this market</p>
      </div>
    );
  }

  // ── Loading skeleton ─────────────────────────────────────────────────────
  if (loading && !data) {
    return (
      <div className="flex flex-col gap-px px-3 py-3">
        {/* Header */}
        <div className="flex items-center justify-between mb-2">
          <span className="text-[10px] text-muted tracking-widest uppercase">Loading orderbook…</span>
          <div className="w-3 h-3 border border-muted/40 border-t-transparent rounded-full animate-spin" />
        </div>
        {Array.from({ length: 10 }).map((_, i) => (
          <div key={i} className="h-5 rounded bg-surface/50 animate-pulse" style={{ opacity: 1 - i * 0.07 }} />
        ))}
      </div>
    );
  }

  // ── Parse + sort ─────────────────────────────────────────────────────────
  const outcomeLabel = market.groupItemTitle ?? market.question ?? "YES";

  const rawBids = (data?.bids ?? [])
    .map((e) => ({ price: parseFloat(e.price), size: parseFloat(e.size) }))
    .filter((e) => e.price > 0 && e.size > 0)
    .sort((a, b) => b.price - a.price)   // best bid first (descending)
    .slice(0, LEVELS);

  const rawAsks = (data?.asks ?? [])
    .map((e) => ({ price: parseFloat(e.price), size: parseFloat(e.size) }))
    .filter((e) => e.price > 0 && e.size > 0)
    .sort((a, b) => a.price - b.price)   // best ask first (ascending)
    .slice(0, LEVELS);

  // Cumulative sums (USD)
  const buildCumulative = (rows: { price: number; size: number }[], isBid: boolean) => {
    let cum = 0;
    return rows.map((r) => {
      const usd = r.size * (isBid ? r.price : (1 - r.price));
      cum += usd;
      return { ...r, usd, cum };
    });
  };

  const bids = buildCumulative(rawBids, true);
  const asks = buildCumulative(rawAsks, false);

  const maxBidCum = bids[bids.length - 1]?.cum ?? 1;
  const maxAskCum = asks[asks.length - 1]?.cum ?? 1;

  // Mid price: midpoint between best bid and best ask
  const bestBid = bids[0]?.price ?? 0;
  const bestAsk = asks[0]?.price ?? 1;
  const mid = (bestBid + bestAsk) / 2;
  const spread = bestAsk - bestBid;

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-border flex-shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-muted tracking-widest uppercase">Orderbook</span>
          <span className="text-[10px] text-muted-dim">·</span>
          <span className="text-[10px] text-text truncate max-w-[160px]">{outcomeLabel} YES</span>
          {loading && (
            <div className="w-2.5 h-2.5 border border-muted/40 border-t-transparent rounded-full animate-spin" />
          )}
        </div>
        <button
          type="button"
          onClick={() => setTick((t) => t + 1)}
          title="Refresh orderbook"
          className="text-[12px] text-muted-dim hover:text-muted transition-colors leading-none"
        >
          ↻
        </button>
      </div>

      {error && (
        <div className="px-4 py-2 text-[10px] text-danger border-b border-border/40">
          {error}
        </div>
      )}

      {/* Column headers */}
      <div className="grid grid-cols-2 border-b border-border/40 flex-shrink-0">
        <div className="flex items-center gap-3 px-3 py-1.5 border-r border-border/40">
          <span className="text-[9px] text-accent/60 tracking-widest uppercase flex-1">Bids</span>
          <span className="text-[9px] text-muted-dim tracking-widest uppercase hidden sm:block">Size</span>
          <span className="text-[9px] text-muted-dim tracking-widest uppercase w-12 text-right hidden md:block">Cumul</span>
        </div>
        <div className="flex items-center gap-3 px-3 py-1.5">
          <span className="text-[9px] text-danger/60 tracking-widest uppercase flex-1">Asks</span>
          <span className="text-[9px] text-muted-dim tracking-widest uppercase hidden sm:block">Size</span>
          <span className="text-[9px] text-muted-dim tracking-widest uppercase w-12 text-right hidden md:block">Cumul</span>
        </div>
      </div>

      {/* Orderbook rows */}
      <div className="flex-1 overflow-y-auto">
        {/* Pad to equal length */}
        {Array.from({ length: Math.max(bids.length, asks.length, 1) }).map((_, i) => {
          const bid = bids[i];
          const ask = asks[i];
          return (
            <div key={i} className="grid grid-cols-2 border-b border-border/20">
              {/* Bid side */}
              <div className="relative flex items-center border-r border-border/20 overflow-hidden">
                {bid && (
                  <>
                    {/* depth bar — grows from right */}
                    <div
                      className="absolute inset-0 left-auto bg-accent/8"
                      style={{ width: `${Math.min((bid.cum / maxBidCum) * 100, 100)}%` }}
                    />
                    <div className="relative flex items-center gap-2 px-3 py-[5px] w-full tabular-nums">
                      <span className="text-[11px] font-medium text-accent w-11 flex-shrink-0">
                        {formatPrice(bid.price)}
                      </span>
                      <span className="text-[10px] text-muted flex-1 text-right">
                        {formatSize(bid.size, bid.price)}
                      </span>
                      <span className="text-[10px] text-muted-dim w-12 text-right hidden md:block">
                        ${bid.cum >= 1000 ? (bid.cum / 1000).toFixed(1) + "k" : bid.cum.toFixed(0)}
                      </span>
                    </div>
                  </>
                )}
              </div>

              {/* Ask side */}
              <div className="relative flex items-center overflow-hidden">
                {ask && (
                  <>
                    {/* depth bar — grows from left */}
                    <div
                      className="absolute inset-0 right-auto bg-danger/8"
                      style={{ width: `${Math.min((ask.cum / maxAskCum) * 100, 100)}%` }}
                    />
                    <div className="relative flex items-center gap-2 px-3 py-[5px] w-full tabular-nums">
                      <span className="text-[11px] font-medium text-danger w-11 flex-shrink-0">
                        {formatPrice(ask.price)}
                      </span>
                      <span className="text-[10px] text-muted flex-1 text-right">
                        {formatSize(ask.size, 1 - ask.price)}
                      </span>
                      <span className="text-[10px] text-muted-dim w-12 text-right hidden md:block">
                        ${ask.cum >= 1000 ? (ask.cum / 1000).toFixed(1) + "k" : ask.cum.toFixed(0)}
                      </span>
                    </div>
                  </>
                )}
              </div>
            </div>
          );
        })}

        {/* Mid price + spread */}
        {data && bids.length > 0 && asks.length > 0 && (
          <div className="flex items-center justify-center gap-4 px-4 py-2 border-b border-border/20 bg-surface/30">
            <span className="text-[10px] text-muted tracking-widest uppercase">Mid</span>
            <span className="text-sm font-black tabular-nums" style={{ fontFamily: "var(--font-display)", color: "#4D83FF" }}>
              {formatPrice(mid)}
            </span>
            <span className="text-[10px] text-muted-dim">
              spread {(spread * 100).toFixed(2)}¢
            </span>
          </div>
        )}

        {/* Empty state */}
        {data && bids.length === 0 && asks.length === 0 && (
          <div className="flex flex-col items-center justify-center py-10 gap-2">
            <p className="text-[11px] text-muted-dim">No orders in book</p>
          </div>
        )}

        {/* Polymarket attribution */}
        <div className="flex items-center justify-center gap-1.5 px-4 py-2">
          <span className="text-[9px] text-muted-dim tracking-widest uppercase">Live from Polymarket CLOB · refreshes every 5s</span>
        </div>
      </div>
    </div>
  );
}
