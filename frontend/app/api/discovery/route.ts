import { NextResponse } from "next/server";
import { filterAndSortEvents, type DiscoverySort } from "@/lib/discovery";
import type { PolyEvent } from "@/lib/polymarket";

export const dynamic = "force-dynamic";

const GAMMA_API = "https://gamma-api.polymarket.com";
const DEFAULT_LIMIT = 80;
const MAX_LIMIT = 200;

function parseJsonMaybe<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string") return (value as T) ?? fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function coerceTags(raw: any[]): string[] {
  return raw.map((t: any) =>
    typeof t === "string" ? t : (t?.label ?? t?.id ?? String(t))
  );
}

function normalizeEvent(event: any): PolyEvent {
  const tags = coerceTags(parseJsonMaybe<any[]>(event.tags, []));
  return {
    ...event,
    tags,
    category: event.category ?? (tags[0] || undefined),
    volumeNum: event.volumeNum != null ? Number(event.volumeNum) : parseFloat(String(event.volume ?? "0")) || 0,
    markets: parseJsonMaybe<any[]>(event.markets, []).map((market) => ({
      ...market,
      tags: coerceTags(parseJsonMaybe<any[]>(market.tags, [])),
    })),
  };
}

function normalizeSort(value: string | null): DiscoverySort {
  if (value === "volume_asc") return value;
  if (value === "ending_soon") return value;
  if (value === "newest") return value;
  return "volume_desc";
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const q = searchParams.get("q") ?? "";
  const category = searchParams.get("category") ?? "all";
  const tag = searchParams.get("tag") ?? "all";
  const sort = normalizeSort(searchParams.get("sort"));
  const rawLimit = Number(searchParams.get("limit") ?? DEFAULT_LIMIT);
  const limit = Number.isFinite(rawLimit)
    ? Math.max(1, Math.min(MAX_LIMIT, Math.floor(rawLimit)))
    : DEFAULT_LIMIT;

  const url = `${GAMMA_API}/events?active=true&closed=false&limit=${limit}&order=volume&ascending=false`;

  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      cache: "no-store",
    });

    if (!res.ok) {
      return NextResponse.json({ error: "Gamma API error" }, { status: res.status });
    }

    const data = await res.json();
    const events: PolyEvent[] = (Array.isArray(data) ? data : []).map(normalizeEvent);
    const filtered = filterAndSortEvents(events, { q, category, tag, sort });

    return NextResponse.json(
      {
        events: filtered,
        total: filtered.length,
        query: { q, category, tag, sort, limit },
      },
      {
        headers: { "Cache-Control": "no-store, no-cache, must-revalidate" },
      }
    );
  } catch {
    return NextResponse.json({ error: "Failed to fetch discovery events" }, { status: 500 });
  }
}
