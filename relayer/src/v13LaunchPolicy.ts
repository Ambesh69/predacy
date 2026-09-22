export function resolveV13LaunchPolicy(chainId: number, env: NodeJS.ProcessEnv) {
  if (env.V13_PRIVATE_TRADING_ENABLED !== "true") return { enabled: false, blocker: "V13 private intake is disabled" };
  if (chainId === 137 && env.V13_ACCEPT_PUBLIC_AGGREGATE_EXECUTION !== "true") {
    return { enabled: false, blocker: "V13 aggregate Polymarket execution is public" };
  }
  if (chainId === 137 && env.V13_TRUST_RELAYER_WITH_WITNESSES !== "true") {
    return { enabled: false, blocker: "V13 relayer can read plaintext order witnesses in process memory" };
  }
  return { enabled: true, blocker: null };
}
