/**
 * Shared viem public client for all frontend components.
 *
 * polygon-rpc.com shut down Feb 2026 — viem's bare http() transport for Polygon
 * resolves to rate-limited public RPCs (meowrpc 429, etc).  Use an explicit
 * fallback list so balance reads survive individual provider outages.
 */
import { createPublicClient, http, fallback } from "viem";
import { ACTIVE_CHAIN, IS_MAINNET } from "./chain";

export const publicClient = createPublicClient({
  chain: ACTIVE_CHAIN,
  transport: IS_MAINNET
    ? fallback([
        http("https://polygon.meowrpc.com"),
        http("https://rpc.ankr.com/polygon"),
        http("https://polygon.drpc.org"),
      ])
    : http(),
});
