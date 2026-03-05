"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import DiscoveryControls from "@/components/DiscoveryControls";
import EventCard from "@/components/EventCard";
import WalletButton from "@/components/WalletButton";
import {
  getDiscoveryCategories,
  getDiscoveryTags,
  type DiscoverySort,
} from "@/lib/discovery";
import type { PolyEvent } from "@/lib/polymarket";

interface DiscoveryPageClientProps {
  title: string;
  subtitle: string;
  fixedCategory?: string;
  initialQuery?: string;
  initialSort?: DiscoverySort;
  initialTag?: string;
  initialCategory?: string;
}

function normalizeCategory(category: string) {
  return category.trim().toLowerCase();
}

export default function DiscoveryPageClient({
  title,
  subtitle,
  fixedCategory,
  initialQuery = "",
  initialSort = "volume_desc",
  initialTag = "all",
  initialCategory = "all",
}: DiscoveryPageClientProps) {
  const [events, setEvents] = useState<PolyEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [liveMarketIds, setLiveMarketIds] = useState<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = useState(initialQuery);
  const [sortBy, setSortBy] = useState<DiscoverySort>(initialSort);
  const [selectedCategory, setSelectedCategory] = useState(fixedCategory ?? initialCategory);
  const [selectedTag, setSelectedTag] = useState(initialTag);
  const router = useRouter();
  const pathname = usePathname();

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
    const controller = new AbortController();
    const category = fixedCategory ?? selectedCategory;
    const params = new URLSearchParams();
    if (searchQuery.trim()) params.set("q", searchQuery.trim());
    if (category !== "all") params.set("category", category);
    if (selectedTag !== "all") params.set("tag", selectedTag);
    if (sortBy !== "volume_desc") params.set("sort", sortBy);
    params.set("limit", "120");

    setLoading(true);
    fetch(`/api/discovery?${params.toString()}`, {
      signal: controller.signal,
      cache: "no-store",
    })
      .then((res) => (res.ok ? res.json() : Promise.reject()))
      .then((data) => setEvents(data.events ?? []))
      .catch(() => {
        if (controller.signal.aborted) return;
        setEvents([]);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [fixedCategory, searchQuery, selectedCategory, selectedTag, sortBy]);

  useEffect(() => {
    const params = new URLSearchParams();
    if (searchQuery.trim()) params.set("q", searchQuery.trim());
    if (!fixedCategory && selectedCategory !== "all") params.set("category", selectedCategory);
    if (selectedTag !== "all") params.set("tag", selectedTag);
    if (sortBy !== "volume_desc") params.set("sort", sortBy);
    const next = params.toString();
    router.replace(next ? `${pathname}?${next}` : pathname, { scroll: false });
  }, [fixedCategory, pathname, router, searchQuery, selectedCategory, selectedTag, sortBy]);

  const categories = useMemo(() => getDiscoveryCategories(events), [events]);
  const tags = useMemo(() => getDiscoveryTags(events), [events]);

  const displayed = useMemo(() => {
    if (!fixedCategory) return events;
    return events.filter((e) => normalizeCategory(e.category ?? "") === normalizeCategory(fixedCategory));
  }, [events, fixedCategory]);

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
        <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
          <p className="text-[11px] text-muted-dim tracking-widest uppercase">{subtitle}</p>
          <div className="flex items-center gap-2">
            <Link
              href="/search"
              className="text-[10px] tracking-widest uppercase px-2.5 py-1 border border-border text-muted hover:text-text hover:border-border-bright transition-colors"
            >
              Search
            </Link>
            <Link
              href="/categories"
              className="text-[10px] tracking-widest uppercase px-2.5 py-1 border border-border text-muted hover:text-text hover:border-border-bright transition-colors"
            >
              Categories
            </Link>
          </div>
        </div>

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
