"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import DiscoveryControls from "@/components/DiscoveryControls";
import EventCard from "@/components/EventCard";
import WalletButton from "@/components/WalletButton";
import {
  filterAndSortEvents,
  getDiscoveryCategories,
  getDiscoveryTags,
  type DiscoverySort,
} from "@/lib/discovery";
import { getEvents, type PolyEvent } from "@/lib/polymarket";

interface DiscoveryPageClientProps {
  title: string;
  subtitle: string;
  fixedCategory?: string;
  initialQuery?: string;
}

function normalizeCategory(category: string) {
  return category.trim().toLowerCase();
}

export default function DiscoveryPageClient({
  title,
  subtitle,
  fixedCategory,
  initialQuery = "",
}: DiscoveryPageClientProps) {
  const [events, setEvents] = useState<PolyEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [liveMarketIds, setLiveMarketIds] = useState<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = useState(initialQuery);
  const [sortBy, setSortBy] = useState<DiscoverySort>("volume_desc");
  const [selectedCategory, setSelectedCategory] = useState(fixedCategory ?? "all");
  const [selectedTag, setSelectedTag] = useState("all");

  useEffect(() => {
    const relayerUrl = process.env.NEXT_PUBLIC_RELAYER_URL;
    if (!relayerUrl) return;
    fetch(`${relayerUrl}/health`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!data) return;
        setLiveMarketIds(new Set<string>(Object.keys(data.markets ?? {})));
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    getEvents(100)
      .then((fetched) => setEvents(fetched))
      .catch(() => setEvents([]))
      .finally(() => setLoading(false));
  }, []);

  const categories = useMemo(() => getDiscoveryCategories(events), [events]);
  const tags = useMemo(() => getDiscoveryTags(events), [events]);

  const displayed = useMemo(() => {
    const filtered = filterAndSortEvents(events, {
      q: searchQuery,
      category: selectedCategory,
      tag: selectedTag,
      sort: sortBy,
    });
    if (!fixedCategory) return filtered;
    return filtered.filter((e) => normalizeCategory(e.category ?? "") === normalizeCategory(fixedCategory));
  }, [events, fixedCategory, searchQuery, selectedCategory, selectedTag, sortBy]);

  const hasFilters = searchQuery.trim() !== "" || selectedCategory !== (fixedCategory ?? "all") || selectedTag !== "all" || sortBy !== "volume_desc";

  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b border-border px-4 md:px-6 py-4 bg-surface/30 backdrop-blur-[2px] flex items-center justify-between gap-3">
        <div className="flex items-center gap-4">
          <Link href="/" className="text-[11px] text-muted hover:text-text tracking-widest uppercase">
            ← Markets
          </Link>
          <h1 className="text-xl font-black text-text tracking-tight" style={{ fontFamily: "var(--font-display)" }}>
            {title}
          </h1>
        </div>
        <WalletButton />
      </header>

      <main className="flex-1 px-4 md:px-6 py-6">
        <p className="text-[11px] text-muted-dim tracking-widest uppercase mb-3">{subtitle}</p>

        <DiscoveryControls
          query={searchQuery}
          onQueryChange={setSearchQuery}
          sortBy={sortBy}
          onSortChange={setSortBy}
          categories={categories}
          selectedCategory={selectedCategory}
          onCategoryChange={setSelectedCategory}
          tags={tags}
          selectedTag={selectedTag}
          onTagChange={setSelectedTag}
          onClear={() => {
            setSearchQuery("");
            setSortBy("volume_desc");
            setSelectedCategory(fixedCategory ?? "all");
            setSelectedTag("all");
          }}
          hasFilters={hasFilters}
        />

        {loading ? (
          <div className="py-8 flex justify-center">
            <div className="w-4 h-4 border border-muted/40 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : displayed.length === 0 ? (
          <div className="mt-3 border border-border bg-surface/25 px-4 py-6 text-center">
            <p className="text-sm text-muted">No markets match your filters.</p>
            <p className="text-[11px] text-muted-dim mt-1">Try a broader search or clear filters.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-px bg-border/90 shadow-[0_0_0_1px_rgba(78,163,255,0.08)]">
            {displayed.map((event) => (
              <div key={event.id} className="bg-bg">
                <EventCard event={event} liveMarketIds={liveMarketIds} />
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
