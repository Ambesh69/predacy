import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const CLOB_API = "https://clob.polymarket.com";

/**
 * Server-side proxy for Polymarket CLOB prices-history endpoint.
 * Avoids CORS and rate-limit issues when called from the browser.
 *
 * Query params:
 *   token_id  — CLOB token ID (large decimal integer string from clobTokenIds[0])
 *   interval  — "6h" | "1d" | "1w" | "max"  (default: "1d")
 *   fidelity  — data-point granularity in minutes (default: 60)
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const tokenId  = searchParams.get("token_id");
  const interval = searchParams.get("interval") ?? "1d";
  const fidelity = searchParams.get("fidelity") ?? "60";

  if (!tokenId) {
    return NextResponse.json({ error: "token_id required" }, { status: 400 });
  }

  const url =
    `${CLOB_API}/prices-history` +
    `?market=${encodeURIComponent(tokenId)}` +
    `&interval=${interval}` +
    `&fidelity=${fidelity}`;

  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      cache: "no-store",
    });

    if (!res.ok) {
      return NextResponse.json({ error: "CLOB API error" }, { status: res.status });
    }

    const data = await res.json();
    return NextResponse.json(data, {
      // 30-second freshness is fine for price history
      headers: { "Cache-Control": "public, s-maxage=30, stale-while-revalidate=30" },
    });
  } catch {
    return NextResponse.json({ error: "Failed to fetch prices" }, { status: 500 });
  }
}
