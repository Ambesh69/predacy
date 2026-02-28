import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const GAMMA_API = "https://gamma-api.polymarket.com";

/** Fetch a single event by its Gamma API ID */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  try {
    // Try the RESTful endpoint first; fall back to query-param style
    const res = await fetch(`${GAMMA_API}/events/${encodeURIComponent(id)}`, {
      headers: { Accept: "application/json" },
      cache: "no-store",
    });

    if (res.ok) {
      const data = await res.json();
      // Gamma may return an array or a single object
      return NextResponse.json(Array.isArray(data) ? (data[0] ?? null) : data);
    }

    // Fallback: query-param lookup
    const res2 = await fetch(
      `${GAMMA_API}/events?id=${encodeURIComponent(id)}`,
      { headers: { Accept: "application/json" }, cache: "no-store" },
    );
    if (!res2.ok) {
      return NextResponse.json({ error: "Gamma API error" }, { status: res2.status });
    }
    const data2 = await res2.json();
    return NextResponse.json(Array.isArray(data2) ? (data2[0] ?? null) : data2);
  } catch {
    return NextResponse.json({ error: "Failed to fetch event" }, { status: 500 });
  }
}
