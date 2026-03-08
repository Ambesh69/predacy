/**
 * Server-side proxy for relayer API calls.
 *
 * All requests to /api/relayer/* are forwarded to the Railway relayer.
 * This bypasses client-side DNS / firewall issues with railway.app by
 * routing through Vercel's edge servers, which can always reach Railway.
 *
 * Supports: GET, POST (the only methods the frontend needs).
 */
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// Max wait for Railway to respond — Vercel functions time out at 10 s (hobby) or 30 s (pro).
// The claim-proof endpoint returns immediately (<2 s) so this is fine.
const TIMEOUT_MS = 25_000;

function getRelayerBase(): string {
  const url = process.env.NEXT_PUBLIC_RELAYER_URL?.trim();
  if (!url) throw new Error("NEXT_PUBLIC_RELAYER_URL not set");
  return url;
}

async function proxyRequest(
  req: NextRequest,
  params: { path: string[] },
  method: "GET" | "POST",
): Promise<NextResponse> {
  try {
    const base = getRelayerBase();
    const path = params.path.join("/");
    const { searchParams } = new URL(req.url);
    const qs = searchParams.toString();
    const upstreamUrl = `${base}/${path}${qs ? `?${qs}` : ""}`;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    // Forward X-Signature if present (used by some relayer endpoints)
    const sig = req.headers.get("x-signature");
    if (sig) headers["X-Signature"] = sig;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    let body: string | undefined;
    if (method === "POST") {
      body = await req.text();
    }

    const upstream = await fetch(upstreamUrl, {
      method,
      headers,
      body,
      signal: controller.signal,
    });
    clearTimeout(timer);

    const data = await upstream.json().catch(() => ({}));
    return NextResponse.json(data, {
      status: upstream.status,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (err: any) {
    const msg = err?.name === "AbortError"
      ? "Relayer request timed out"
      : `Relayer proxy error: ${err?.message ?? "unknown"}`;
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  return proxyRequest(req, await params, "GET");
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  return proxyRequest(req, await params, "POST");
}
