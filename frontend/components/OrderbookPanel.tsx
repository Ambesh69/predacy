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

const LEVELS = 8;        // rows per side
const REFRESH_MS = 5_000;

function formatPrice(p: number): string {
  return (p * 100).toFixed(1) + "¢";
}

function formatShares(s: number): string {
  if (s >= 1_000_000) return (s / 1_000_000).toFixed(1) + "M";
  if (s >= 1_000)     return (s / 1_000).toFixed(1) + "k";
  return s.toFixed(0);
}

function formatUSD(usd: number): string {
  if (usd >= 1_000_000) return "$" + (usd / 1_000_000).toFixed(1) + "M";
  if (usd >= 1_000)     return "$" + (usd / 1_000).toFixed(1) + "k";
  return "$" + usd.toFixed(0);
}

/** Build enriched rows — usd = size × price (correct for both bids AND asks) */
function buildRows(raw: { price: number; size: number }[]) {
  return raw.map((r) => ({ ...r, usd: r.size * r.price }));
}

export default function OrderbookPanel({ market }: { market: Market | null }) {
  const [data, setData]             = useState<OrderbookData | null>(null);
  const [loading, setLoading]       = useState(false);
  const [error, setError]           = useState<string | null>(null);
  const [tick, setTick]             = useState(0);       // bumped by auto-refresh + manual ↻
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [ago, setAgo]               = useState("—");
  const [flashKey, setFlashKey]     = useState(0);       // key-change triggers mount animation

  const tokenId = market?.clobTokenIds?.[0]; // YES token

  // ── Fetch orderbook ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!tokenId) { setData(null); return; }
    setLoading(true);
    setError(null);
    fetch(`/api/orderbook?token_id=${encodeURIComponent(tokenId)}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.error) throw new Error(d.error);
        setData(d as OrderbookData);
        setLastUpdated(new Date());
        setFlashKey((k) => k + 1);
      })
      .catch((e) => setError(e.message ?? "Failed to load"))
      .finally(() => setLoading(false));
  }, [tokenId, tick]);

  // ── Auto-refresh every 5s ────────────────────────────────────────────────
  useEffect(() => {
    if (!tokenId) return;
    const id = setInterval(() => setTick((t) => t + 1), REFRESH_MS);
    return () => clearInterval(id);
  }, [tokenId]);

  // ── "X ago" ticker ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!lastUpdated) return;
    const id = setInterval(() => {
      const s = Math.round((Date.now() - lastUpdated.getTime()) / 1000);
      setAgo(s < 5 ? "just now" : `${s}s ago`);
    }, 1000);
    setAgo("just now");
    return () => clearInterval(id);
  }, [lastUpdated]);

  // ── Empty / no market ───────────────────────────────────────────────────
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
      <div className="flex flex-col gap-1 px-3 py-3">
        <div className="flex items-center justify-between mb-2">
          <span className="text-[10px] text-muted tracking-widest uppercase">Loading orderbook…</span>
          <div className="w-3 h-3 border border-muted/40 border-t-transparent rounded-full animate-spin" />
        </div>
        {Array.from({ length: 17 }).map((_, i) => (
          <div key={i} className={clsx("h-5 rounded bg-surface/50 animate-pulse",
            i === 8 ? "bg-surface/80 h-6" : "")}
            style={{ opacity: 0.7 - Math.abs(i - 8) * 0.04 }} />
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

  // Build rows — USD = size × price (correct for both sides)
  const bids = buildRows(rawBids);
  const asks = buildRows(rawAsks);

  // Depth bars use per-side max USD (not cumulative) for visual proportionality
  const maxBidUsd = Math.max(...bids.map((b) => b.usd), 1);
  const maxAskUsd = Math.max(...asks.map((a) => a.usd), 1);

  // Asks displayed reversed: worst ask at top, best ask closest to spread line
  const asksDisplay = [...asks].reverse();

  // Spread + mid price
  const bestBid = bids[0]?.price ?? 0;
  const bestAsk = asks[0]?.price ?? 1;
  const mid     = (bestBid + bestAsk) / 2;
  const spread  = bestAsk - bestBid;

  return (
    <div className="flex flex-col h-full">

      {/* ── Header ────────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-border flex-shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-[10px] text-muted tracking-widest uppercase flex-shrink-0">Orderbook</span>
          <span className="text-[10px] text-muted-dim flex-shrink-0">·</span>
          <span className="text-[10px] text-text truncate">{outcomeLabel} YES</span>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {/* Live dot + timestamp */}
          <span
            className={clsx(
              "w-1.5 h-1.5 rounded-full transition-colors",
              loading ? "bg-accent animate-pulse" : "bg-accent/50"
            )}
          />
          <span className="text-[9px] text-muted-dim tabular-nums">{ago}</span>
          {/* Manual refresh */}
          <button
            type="button"
            onClick={() => setTick((t) => t + 1)}
            title="Refresh orderbook"
            className="text-[13px] text-muted-dim hover:text-muted transition-colors leading-none ml-1"
          >
            ↻
          </button>
        </div>
      </div>

      {error && (
        <div className="px-4 py-2 text-[10px] text-danger border-b border-border/40 flex-shrink-0">
          {error}
        </div>
      )}

      {/* ── Column headers ────────────────────────────────────────────────── */}
      <div className="grid grid-cols-[1fr_auto_auto] px-3 py-1.5 border-b border-border/30 flex-shrink-0">
        <span className="text-[9px] text-muted-dim tracking-widest uppercase">Price</span>
        <span className="text-[9px] text-muted-dim tracking-widest uppercase text-right pr-6">Shares</span>
        <span className="text-[9px] text-muted-dim tracking-widest uppercase text-right w-16">Total</span>
      </div>

      {/* ── Orderbook rows ────────────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto" key={flashKey}>

        {/* ASKS — worst at top, best at bottom (nearest to spread) */}
        {asksDisplay.map((ask, i) => {
          const pct = Math.min((ask.usd / maxAskUsd) * 100, 100);
          return (
            <div key={`ask-${i}`} className="relative grid grid-cols-[1fr_auto_auto] items-center border-b border-border/10">
              {/* depth bar — danger, from right */}
              <div
                className="absolute inset-0 left-auto bg-danger/10"
                style={{ width: `${pct}%` }}
              />
              <span className="relative px-3 py-[5px] text-[11px] font-medium text-danger tabular-nums">
                {formatPrice(ask.price)}
              </span>
              <span className="relative pr-6 py-[5px] text-[10px] text-muted tabular-nums text-right">
                {formatShares(ask.size)}
              </span>
              <span className="relative pr-3 py-[5px] text-[10px] text-muted-dim tabular-nums text-right w-16">
                {formatUSD(ask.usd)}
              </span>
            </div>
          );
        })}

        {/* Empty asks */}
        {asks.length === 0 && data && (
          <div className="py-4 text-center text-[10px] text-muted-dim">No asks</div>
        )}

        {/* ── Spread / mid separator ──────────────────────────────────────── */}
        {data && (bids.length > 0 || asks.length > 0) && (
          <div className="flex items-center justify-between px-3 py-2 border-y border-border/40 bg-surface/30">
            <span className="text-[10px] text-muted-dim tabular-nums">
              Spread <span className="text-muted">{(spread * 100).toFixed(2)}¢</span>
            </span>
            <span
              className="text-sm font-black tabular-nums"
              style={{ fontFamily: "var(--font-display)", color: "#4D83FF" }}
            >
              {formatPrice(mid)}
            </span>
          </div>
        )}

        {/* BIDS — best at top (nearest to spread), worst at bottom */}
        {bids.map((bid, i) => {
          const pct = Math.min((bid.usd / maxBidUsd) * 100, 100);
          return (
            <div key={`bid-${i}`} className="relative grid grid-cols-[1fr_auto_auto] items-center border-b border-border/10">
              {/* depth bar — accent, from right */}
              <div
                className="absolute inset-0 left-auto bg-accent/10"
                style={{ width: `${pct}%` }}
              />
              <span className="relative px-3 py-[5px] text-[11px] font-medium text-accent tabular-nums">
                {formatPrice(bid.price)}
              </span>
              <span className="relative pr-6 py-[5px] text-[10px] text-muted tabular-nums text-right">
                {formatShares(bid.size)}
              </span>
              <span className="relative pr-3 py-[5px] text-[10px] text-muted-dim tabular-nums text-right w-16">
                {formatUSD(bid.usd)}
              </span>
            </div>
          );
        })}

        {/* Empty bids */}
        {bids.length === 0 && data && (
          <div className="py-4 text-center text-[10px] text-muted-dim">No bids</div>
        )}

        {/* Empty book */}
        {data && bids.length === 0 && asks.length === 0 && (
          <div className="flex flex-col items-center justify-center py-10 gap-2">
            <p className="text-[11px] text-muted-dim">No orders in book</p>
          </div>
        )}

        {/* Attribution */}
        <div className="flex items-center justify-center gap-1.5 px-4 py-2.5">
          <span className="text-[9px] text-muted-dim tracking-widest uppercase">
            Live · Polymarket CLOB · refreshes every 5s
          </span>
        </div>
      </div>
    </div>
  );
}
