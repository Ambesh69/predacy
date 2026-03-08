/**
 * Returns the URL to use for relayer API calls.
 *
 * In the browser (client components) we route through the Vercel server-side
 * proxy at /api/relayer/* rather than hitting Railway directly.  This avoids
 * client-side DNS / firewall issues with railway.app — Vercel's servers can
 * always reach Railway even when the user's browser cannot.
 *
 * On the server (Next.js Route Handlers, server components) we use the real
 * Railway URL directly, since Vercel servers have no DNS restrictions.
 *
 * The proxy strip is transparent: /api/relayer/order → Railway /order,
 * /api/relayer/claim-proof → Railway /claim-proof, etc.
 */
export function getRelayerUrl(): string | undefined {
  // typeof window === "undefined" → server-side (Vercel edge/Node runtime)
  if (typeof window === "undefined") {
    return process.env.NEXT_PUBLIC_RELAYER_URL?.trim() || undefined;
  }
  // Browser — use the same-origin Vercel proxy so railway.app DNS is irrelevant.
  // We use a relative path so it works on any Vercel deployment URL (preview, prod, etc.)
  return "/api/relayer";
}
