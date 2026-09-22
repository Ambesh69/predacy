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
import { createHmac } from "node:crypto";

export const dynamic = "force-dynamic";
export const maxDuration = 60; // Vercel Pro: allow up to 60 s for this serverless function

// Max wait for Railway to respond.
// The relayer now responds after tx submission (~2–8 s), not after receipt (~30–120 s),
// so 55 s gives plenty of headroom while staying within Vercel Pro's 60 s function limit.
const TIMEOUT_MS = 55_000;

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
    if (params.path[0] === "admin") {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    const base = getRelayerBase();
    const path = params.path.join("/");
    const { searchParams } = new URL(req.url);
    const qs = searchParams.toString();
    const upstreamUrl = `${base}/${path}${qs ? `?${qs}` : ""}`;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (path === "v13/private-order") {
      const secret = process.env.RELAYER_PROXY_SECRET?.trim();
      const country = req.headers.get("x-vercel-ip-country")?.toUpperCase() ?? "";
      const region = req.headers.get("x-vercel-ip-country-region")?.toUpperCase() ?? "";
      if (!secret || secret.length < 32 || !/^[A-Z]{2}$/.test(country) || !/^[A-Z0-9-]{0,8}$/.test(region)) {
        return NextResponse.json({ error: "Geographic eligibility could not be verified" }, { status: 403 });
      }
      const timestamp = Date.now().toString();
      headers["X-Predacy-Country"] = country;
      headers["X-Predacy-Region"] = region;
      headers["X-Predacy-Geo-Timestamp"] = timestamp;
      headers["X-Predacy-Geo-Signature"] = createHmac("sha256", secret)
        .update(`${country}:${region}:${timestamp}`).digest("hex");
    }

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
