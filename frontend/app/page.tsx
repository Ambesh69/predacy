"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import EventCard from "@/components/EventCard";
import WalletButton from "@/components/WalletButton";
import { MOCK_MARKETS, getEvents, type PolyEvent } from "@/lib/polymarket";
import { getRelayerUrl } from "@/lib/relayerUrl";
import {
  filterAndSortEvents,
  getDiscoveryCategories,
  getDiscoveryTags,
  type DiscoverySort,
} from "@/lib/discovery";

const TICKER_ITEMS = [
  "SEALED BIDS",
  "BATCH AUCTIONS",
  "ZK PROOFS",
  "DARK ORACLE",
  "UNIFORM CLEARING",
  "NO FRONTRUNNING",
  "PRIVATE POSITIONS",
];

export default function HomePage() {
  const [events, setEvents] = useState<PolyEvent[]>(
    MOCK_MARKETS.map((m) => ({ id: m.conditionId, title: m.question, volume: m.volume, volumeNum: m.volumeNum, active: m.active, closed: m.closed, endDate: m.endDate, category: m.category, tags: m.tags, markets: [m] }))
  );
  const [loading, setLoading] = useState(true);
  const [liveMarketIds, setLiveMarketIds] = useState<Set<string>>(new Set());
  const [recentlyLiveEventIds, setRecentlyLiveEventIds] = useState<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = useState("");
  const [sortBy, setSortBy] = useState<DiscoverySort>("volume_desc");
  const [selectedCategory, setSelectedCategory] = useState("all");
  const [selectedTag, setSelectedTag] = useState("all");
  const prevLiveMarketIdsRef = useRef<Set<string>>(new Set());
  const shimmerTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // Fetch all markets with active batches from the relayer's /health endpoint.
  // Any market the relayer is tracking gets the "LIVE" badge.
  useEffect(() => {
    const relayerUrl = getRelayerUrl();
    if (!relayerUrl) return;
    (async () => {
      try {
        const res = await fetch(`${relayerUrl}/health`);
        if (!res.ok) return;
        const data = await res.json();
        // data.markets: { [marketId]: { batchId, status } }
        const ids = new Set<string>(Object.keys(data.markets ?? {}));
        setLiveMarketIds(ids);
      } catch { /* non-fatal */ }
    })();
  }, []);

  useEffect(() => {
    getEvents(50)
      .then((fetched) => {
        // Pin events that have at least one live market at the front
        if (liveMarketIds.size > 0) {
          const live: PolyEvent[] = [];
          const rest: PolyEvent[] = [];
          for (const e of fetched) {
            if (e.markets.some((m) => liveMarketIds.has(m.conditionId.toLowerCase()))) live.push(e);
            else rest.push(e);
          }
          fetched = [...live, ...rest];
        }
        setEvents(fetched);
      })
      .catch(() => {/* keep mock fallback */})
      .finally(() => setLoading(false));
  }, [liveMarketIds]);

  // Targeted shimmer:
  // 1) top-volume cards (first 2 in sorted list),
  // 2) cards whose markets just became LIVE (for a short pulse window).
  useEffect(() => {
    if (events.length === 0) return;
    const prev = prevLiveMarketIdsRef.current;
    const next = liveMarketIds;

    const newlyLiveMarketIds = [...next].filter((id) => !prev.has(id));
    if (newlyLiveMarketIds.length > 0) {
      const newlyLiveEventIds = events
        .filter((e) => e.markets.some((m) => newlyLiveMarketIds.includes(m.conditionId.toLowerCase())))
        .map((e) => e.id);

      if (newlyLiveEventIds.length > 0) {
        setRecentlyLiveEventIds((curr) => {
          const updated = new Set(curr);
          for (const id of newlyLiveEventIds) updated.add(id);
          return updated;
        });

        for (const id of newlyLiveEventIds) {
          const existing = shimmerTimersRef.current.get(id);
          if (existing) clearTimeout(existing);
          const timer = setTimeout(() => {
            setRecentlyLiveEventIds((curr) => {
              const updated = new Set(curr);
              updated.delete(id);
              return updated;
            });
            shimmerTimersRef.current.delete(id);
          }, 20000);
          shimmerTimersRef.current.set(id, timer);
        }
      }
    }

    prevLiveMarketIdsRef.current = new Set(next);
  }, [events, liveMarketIds]);

  useEffect(() => {
    const timers = shimmerTimersRef.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, []);

  const categories = useMemo(() => {
    return getDiscoveryCategories(events);
  }, [events]);

  const tags = useMemo(() => {
    return getDiscoveryTags(events);
  }, [events]);

  const displayedEvents = useMemo(() => {
    return filterAndSortEvents(events, {
      q: searchQuery,
      category: selectedCategory,
      tag: selectedTag,
      sort: sortBy,
    });
  }, [events, searchQuery, selectedCategory, selectedTag, sortBy]);

  const hasFilters = searchQuery.trim() !== "" || selectedCategory !== "all" || selectedTag !== "all" || sortBy !== "volume_desc";

  return (
    <div className="min-h-screen flex flex-col">
      {/* Ticker tape */}
      <div className="border-b border-border overflow-hidden py-2 bg-surface/45">
        <div className="flex ticker-content gap-8">
          {[...TICKER_ITEMS, ...TICKER_ITEMS].map((item, i) => (
            <span key={i} className="text-[10px] text-muted tracking-widest uppercase whitespace-nowrap flex items-center gap-2">
              <span className="text-accent/50">◆</span>
              {item}
            </span>
          ))}
        </div>
      </div>

      {/* Header */}
      <header className="border-b border-border px-4 md:px-6 py-[22px] flex items-end justify-between bg-surface/25 backdrop-blur-[2px]">
        <div>
          <h1
            className="text-[2.65rem] font-black tracking-tight leading-none text-text glow-blue"
            style={{ fontFamily: "var(--font-display)" }}
          >
            PREDACY
          </h1>
          <p className="text-muted text-xs tracking-widest mt-1">
            DARK POOL PREDICTION MARKETS ·{" "}
            <span className="text-accent/70">SEALED-BID BATCH AUCTIONS</span>
          </p>
        </div>

        <div className="flex items-center gap-4">
          {/* Chain indicator */}
          <div className="flex items-center gap-1.5 border border-border-bright bg-surface px-3 py-1.5 shadow-[0_0_0_1px_rgba(78,163,255,0.12)]">
            <div className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />
            <span className="text-[11px] text-muted tracking-widest">POLYGON</span>
          </div>

          <WalletButton />
        </div>
      </header>

      {/* Hero section */}
      <section className="border-b border-border px-4 md:px-6 py-9 grid grid-cols-1 md:grid-cols-3 gap-0 bg-surface/[0.18]">
        {/* Big statement */}
        <div className="md:col-span-2 pr-0 md:pr-8 md:border-r border-border pb-6 md:pb-0">
          <p className="text-muted text-[11px] tracking-widest uppercase mb-3">How it works</p>
          <div className="flex flex-col gap-2">
            {[
              { n: "01", label: "SEAL", desc: "Submit a cryptographic commitment — your order details are encrypted" },
              { n: "02", label: "BATCH", desc: "All orders accumulate privately for 30 seconds" },
              { n: "03", label: "CLEAR", desc: "A ZK proof computes the single uniform clearing price" },
              { n: "04", label: "SETTLE", desc: "Net position routes to Polymarket — only aggregate visible" },
            ].map(({ n, label, desc }) => (
              <div key={n} className="flex items-start gap-4 group">
                <span className="text-[10px] text-muted-dim mt-0.5 w-4 flex-shrink-0">{n}</span>
                <div>
                  <span
                    className="text-sm font-black text-text mr-2"
                    style={{ fontFamily: "var(--font-display)" }}
                  >
                    {label}
                  </span>
                  <span className="text-xs text-muted">{desc}</span>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Stats */}
        <div className="pl-0 md:pl-8 pt-6 md:pt-0 flex flex-col justify-between">
          <p className="text-muted text-[11px] tracking-widest uppercase mb-3">Protocol Stats</p>
          <div className="space-y-4">
            {[
              { label: "Batch Window", value: "30s", sub: "sealed order window" },
              { label: "Privacy", value: "ZK", sub: "commit-reveal + proof" },
              { label: "Settlement", value: "Polymarket", sub: "routes net position" },
              { label: "Frontrunning", value: "0%", sub: "uniform clearing price" },
            ].map(({ label, value, sub }) => (
              <div key={label} className="flex items-end justify-between">
                <div>
                  <p className="text-[10px] text-muted uppercase tracking-wider">{label}</p>
                  <p className="text-[11px] text-muted-dim">{sub}</p>
                </div>
                <span
                  className="text-xl font-black text-blue"
                  style={{ fontFamily: "var(--font-display)" }}
                >
                  {value}
                </span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Market list */}
      <main className="flex-1 px-4 md:px-6 py-6">
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3 mb-5">
          <div className="flex items-center gap-3 flex-wrap">
            <div className="flex items-center gap-3">
              <h2
                className="text-lg font-black text-text tracking-tight"
                style={{ fontFamily: "var(--font-display)" }}
              >
                ACTIVE MARKETS
              </h2>
              {loading && (
                <div className="w-3 h-3 border border-muted/40 border-t-transparent rounded-full animate-spin" />
              )}
            </div>

            <div className="flex items-center gap-2">
              <Link
                href="/search"
                className="text-[10px] tracking-widest uppercase px-2.5 py-1 border border-border text-muted hover:text-text hover:border-border-bright transition-colors"
              >
                Search Page
              </Link>
              <Link
                href="/categories"
                className="text-[10px] tracking-widest uppercase px-2.5 py-1 border border-border text-muted hover:text-text hover:border-border-bright transition-colors"
              >
                Categories
              </Link>
            </div>
          </div>

          <div className="flex flex-col sm:flex-row sm:items-center gap-2 w-full lg:w-auto lg:max-w-[560px]">
            <label className="flex items-center border border-border bg-surface px-3 py-2 focus-within:border-border-bright flex-1 min-w-0">
              <svg className="w-3.5 h-3.5 text-muted mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="m21 21-4.3-4.3m1.8-5.2a7 7 0 1 1-14 0 7 7 0 0 1 14 0Z" />
              </svg>
              <input
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search events, markets, tags..."
                className="w-full bg-transparent text-[13px] text-text placeholder:text-muted-dim focus:outline-none"
              />
            </label>

            <div className="flex items-center gap-2">
              <span className="text-[10px] text-muted tracking-widest uppercase">Sort</span>
              <select
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value as typeof sortBy)}
                className="bg-surface border border-border text-[11px] text-text px-2.5 py-2 focus:outline-none focus:border-border-bright"
              >
                <option value="volume_desc">Highest Volume</option>
                <option value="volume_asc">Lowest Volume</option>
                <option value="ending_soon">Ending Soon</option>
                <option value="newest">Latest Ending</option>
              </select>
            </div>
          </div>
        </div>

        <div className="active-markets-grid grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-px bg-border/90 shadow-[0_0_0_1px_rgba(78,163,255,0.08)]">
          {displayedEvents.map((event, idx) => {
            const shouldShimmer = idx < 2 || recentlyLiveEventIds.has(event.id);
            return (
            <div key={event.id} className={`bg-bg ${shouldShimmer ? "shimmer-card" : ""}`}>
              <EventCard event={event} liveMarketIds={liveMarketIds} />
            </div>
          )})}
        </div>
        {!loading && displayedEvents.length === 0 && (
          <div className="mt-3 border border-border bg-surface/25 px-4 py-6 text-center">
            <p className="text-sm text-muted">No markets match your filters.</p>
            <p className="text-[11px] text-muted-dim mt-1">Try clearing filters or searching another term.</p>
          </div>
        )}
      </main>

      {/* Footer */}
      <footer className="border-t border-border px-4 md:px-6 py-4 flex items-center justify-between bg-surface/30">
        <span className="text-[10px] text-muted-dim tracking-widest uppercase">
          Predacy · Private Prediction Markets · Powered by Polymarket Liquidity
        </span>
        <div className="flex items-center gap-4">
          <span className="text-[10px] text-muted-dim">
            <span className="text-accent/30">●</span> No position info leaks on-chain
          </span>
        </div>
      </footer>
    </div>
  );
}
