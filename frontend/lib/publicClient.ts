/**
 * Shared viem public client for all frontend components.
 *
 * polygon-rpc.com shut down Feb 2026 — viem's bare http() transport for Polygon
 * resolves to rate-limited public RPCs (meowrpc 429, etc).  Use an explicit
 * fallback list so balance reads survive individual provider outages.
 *
 * viem's fallback() transport does NOT retry on HTTP 429 (it's a valid HTTP
 * response, not a network error).  To avoid rate-limits entirely, set
 * NEXT_PUBLIC_RPC_URL in Vercel to an authenticated dRPC endpoint — it will
 * be used as the primary transport and the free RPCs below serve as backups.
 */
import { createPublicClient, http, fallback } from "viem";
import { ACTIVE_CHAIN, IS_MAINNET } from "./chain";

export const publicClient = createPublicClient({
  chain: ACTIVE_CHAIN,
  transport: IS_MAINNET
    ? fallback([
        // Authenticated endpoint injected via Vercel env var (no rate limits).
        // Falls through to free public RPCs if not configured.
        ...(process.env.NEXT_PUBLIC_RPC_URL
          ? [http(process.env.NEXT_PUBLIC_RPC_URL)]
          : []),
        http("https://polygon.llamarpc.com"),   // primary free — reliable
        http("https://rpc.ankr.com/polygon"),   // secondary free
        http("https://polygon.drpc.org"),       // tertiary free
      ])
    : http(),
});
