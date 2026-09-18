import { ACTIVE_CHAIN } from "@/lib/chain";
import { getContracts } from "@/lib/contracts";
import { getRelayerUrl } from "@/lib/relayerUrl";

export async function assertTradingReady(): Promise<void> {
  const relayerUrl = getRelayerUrl();
  if (!relayerUrl) throw new Error("Trading is unavailable: relayer is not configured.");

  let health: { tradingEnabled?: boolean; tradingBlocker?: string; chainId?: number; vault?: string };
  try {
    const response = await fetch(`${relayerUrl}/health`, { cache: "no-store", signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    health = await response.json();
  } catch {
    throw new Error("Trading is unavailable: relayer health could not be verified.");
  }

  if (!health.tradingEnabled) {
    throw new Error(health.tradingBlocker ?? "Trading is temporarily unavailable.");
  }
  if (health.chainId !== ACTIVE_CHAIN.id || health.vault?.toLowerCase() !== getContracts(ACTIVE_CHAIN.id).batchVault.toLowerCase()) {
    throw new Error("Trading is unavailable: frontend and relayer network settings do not match.");
  }
}
