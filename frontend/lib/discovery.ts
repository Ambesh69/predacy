import type { PolyEvent } from "@/lib/polymarket";

export type DiscoverySort = "volume_desc" | "volume_asc" | "ending_soon" | "newest";

export interface DiscoveryQuery {
  q?: string;
  category?: string;
  tag?: string;
  sort?: DiscoverySort;
}

export function getDiscoveryCategories(events: PolyEvent[]): string[] {
  const set = new Set<string>();
  for (const e of events) {
    const c = (e.category ?? "").trim();
    if (c) set.add(c);
  }
  return ["all", ...Array.from(set).sort((a, b) => a.localeCompare(b))];
}

export function getDiscoveryTags(events: PolyEvent[]): string[] {
  const set = new Set<string>();
  for (const e of events) {
    for (const t of e.tags ?? []) {
      const n = String(t).trim();
      if (n) set.add(n);
    }
  }
  return ["all", ...Array.from(set).sort((a, b) => a.localeCompare(b))];
}

export function filterAndSortEvents(events: PolyEvent[], query: DiscoveryQuery): PolyEvent[] {
  const q = (query.q ?? "").trim().toLowerCase();
  const category = (query.category ?? "all").toLowerCase();
  const tag = (query.tag ?? "all").toLowerCase();
  const sort = query.sort ?? "volume_desc";

  let list = [...events];

  if (q) {
    list = list.filter((e) => {
      const haystack = [
        e.title,
        e.category ?? "",
        ...(e.tags ?? []),
        ...e.markets.map((m) => m.question ?? ""),
      ].join(" ").toLowerCase();
      return haystack.includes(q);
    });
  }

  if (category !== "all") {
    list = list.filter((e) => (e.category ?? "").toLowerCase() === category);
  }

  if (tag !== "all") {
    list = list.filter((e) => (e.tags ?? []).some((t) => t.toLowerCase() === tag));
  }

  const endTs = (e: PolyEvent) => {
    const ts = Date.parse(e.endDate ?? "");
    return Number.isNaN(ts) ? Number.POSITIVE_INFINITY : ts;
  };

  list.sort((a, b) => {
    if (sort === "volume_asc") return (a.volumeNum ?? 0) - (b.volumeNum ?? 0);
    if (sort === "ending_soon") return endTs(a) - endTs(b);
    if (sort === "newest") return endTs(b) - endTs(a);
    return (b.volumeNum ?? 0) - (a.volumeNum ?? 0);
  });

  return list;
}
