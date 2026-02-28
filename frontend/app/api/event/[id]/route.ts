import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const GAMMA_API = "https://gamma-api.polymarket.com";

/** Fetch a single event by its Gamma API ID.
 *  Also batch-fetches accurate volume data from the /markets endpoint
 *  because the /events endpoint sometimes returns volume=0 for nested markets.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  try {
    // ── 1. Fetch event ────────────────────────────────────────────────────────
    const res = await fetch(`${GAMMA_API}/events/${encodeURIComponent(id)}`, {
      headers: { Accept: "application/json" },
      cache: "no-store",
    });

    let data: any = null;

    if (res.ok) {
      const raw = await res.json();
      data = Array.isArray(raw) ? (raw[0] ?? null) : raw;
    } else {
      // Fallback: query-param lookup
      const res2 = await fetch(
        `${GAMMA_API}/events?id=${encodeURIComponent(id)}`,
        { headers: { Accept: "application/json" }, cache: "no-store" },
      );
      if (!res2.ok) {
        return NextResponse.json({ error: "Gamma API error" }, { status: res2.status });
      }
      const raw2 = await res2.json();
      data = Array.isArray(raw2) ? (raw2[0] ?? null) : raw2;
    }

    if (!data) return NextResponse.json(null);

    // ── 2. Enrich nested markets with accurate volume from /markets ───────────
    // The /events endpoint sometimes returns volume="0" for individual outcome
    // markets. The /markets endpoint always has the correct lifetime volumes.
    const markets: any[] = data.markets ?? [];
    if (markets.length > 0) {
      try {
        const conditionIds = markets
          .map((m: any) => m.conditionId)
          .filter(Boolean) as string[];

        // Gamma /markets accepts repeated condition_ids[] params
        const qs = conditionIds
          .map((cid) => `condition_ids[]=${encodeURIComponent(cid)}`)
          .join("&");

        const mRes = await fetch(
          `${GAMMA_API}/markets?${qs}&limit=${conditionIds.length}`,
          { headers: { Accept: "application/json" }, cache: "no-store" },
        );

        if (mRes.ok) {
          const mData: any[] = await mRes.json();
          // Build a conditionId → { volume, volumeNum } lookup
          const volMap = new Map<string, { volume: string; volumeNum: number }>();
          for (const m of (Array.isArray(mData) ? mData : [])) {
            if (m.conditionId) {
              volMap.set(m.conditionId, {
                volume:    m.volume    ?? "0",
                volumeNum: m.volumeNum ?? 0,
              });
            }
          }
          // Merge accurate volumes back into each nested market
          data = {
            ...data,
            markets: markets.map((m: any) => {
              const vol = volMap.get(m.conditionId);
              if (!vol) return m;
              return {
                ...m,
                volume:    vol.volume,
                volumeNum: vol.volumeNum,
              };
            }),
          };
        }
      } catch {
        // Volume enrichment is best-effort — don't fail the whole request
      }
    }

    return NextResponse.json(data);
  } catch {
    return NextResponse.json({ error: "Failed to fetch event" }, { status: 500 });
  }
}
