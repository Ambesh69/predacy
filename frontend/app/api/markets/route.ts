import { NextResponse } from "next/server";

const GAMMA_API = "https://gamma-api.polymarket.com";

/** Server-side proxy for Polymarket Gamma API — avoids CORS issues from the browser */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const conditionId = searchParams.get("condition_id");
  const limit       = searchParams.get("limit") ?? "20";

  // Single-market lookup by conditionId
  const url = conditionId
    ? `${GAMMA_API}/markets?condition_id=${encodeURIComponent(conditionId)}`
    : `${GAMMA_API}/markets?active=true&closed=false&limit=${limit}&order=volumeNum&ascending=false`;

  try {
    const res = await fetch(url, {
      headers: { "Accept": "application/json" },
      next: { revalidate: 30 }, // cache 30s
    });

    if (!res.ok) {
      return NextResponse.json({ error: "Gamma API error" }, { status: res.status });
    }

    const data = await res.json();
    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json({ error: "Failed to fetch markets" }, { status: 500 });
  }
}
