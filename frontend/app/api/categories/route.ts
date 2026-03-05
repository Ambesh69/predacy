import { NextResponse } from "next/server";
import { summarizeCategories } from "@/lib/discovery";
import type { PolyEvent } from "@/lib/polymarket";

export const dynamic = "force-dynamic";

const GAMMA_API = "https://gamma-api.polymarket.com";
const DEFAULT_LIMIT = 120;
const MAX_LIMIT = 250;

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
    markets: parseJsonMaybe<any[]>(event.markets, []),
  };
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const rawLimit = Number(searchParams.get("limit") ?? DEFAULT_LIMIT);
  const limit = Number.isFinite(rawLimit)
    ? Math.max(10, Math.min(MAX_LIMIT, Math.floor(rawLimit)))
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
    const categories = summarizeCategories(events);

    return NextResponse.json(
      {
        categories,
        total: categories.length,
      },
      {
        headers: { "Cache-Control": "no-store, no-cache, must-revalidate" },
      }
    );
  } catch {
    return NextResponse.json({ error: "Failed to fetch categories" }, { status: 500 });
  }
}
