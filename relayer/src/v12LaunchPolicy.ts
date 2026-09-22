export interface V12LaunchPolicy {
  enabled: boolean;
  blocker: string | null;
}

export function resolveV12LaunchPolicy(
  chainId: number,
  env: Record<string, string | undefined>,
): V12LaunchPolicy {
  if (env.V12_PRIVATE_TRADING_ENABLED !== "true") {
    return { enabled: false, blocker: "V12 private intake is disabled" };
  }
  if (chainId === 137 && env.V12_ACCEPT_PUBLIC_ORDER_LINKAGE !== "true") {
    return {
      enabled: false,
      blocker: "V12 intake is blocked: lockBuyOrder exposes each order's outcome asset and startBuyBatch links it to the public aggregate hedge",
    };
  }
  return { enabled: true, blocker: null };
}
