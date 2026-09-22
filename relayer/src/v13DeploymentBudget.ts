export const V13_DEPLOYMENT_GAS = {
  orderVerifier: 6_735_774n,
  routeVerifier: 6_736_211n,
  settlementVerifier: 6_736_195n,
  cancelVerifier: 6_735_446n,
  poolAndAdapter: 5_948_835n,
} as const;

export interface V13DeploymentState {
  verifiers: Record<"order" | "route" | "settlement" | "cancel", boolean>;
  poolAndAdapter: boolean;
}

export function remainingV13DeploymentGas(state: V13DeploymentState): bigint {
  const verifierGas = {
    order: V13_DEPLOYMENT_GAS.orderVerifier,
    route: V13_DEPLOYMENT_GAS.routeVerifier,
    settlement: V13_DEPLOYMENT_GAS.settlementVerifier,
    cancel: V13_DEPLOYMENT_GAS.cancelVerifier,
  } as const;
  let gas = state.poolAndAdapter ? 0n : V13_DEPLOYMENT_GAS.poolAndAdapter;
  for (const name of Object.keys(verifierGas) as Array<keyof typeof verifierGas>) {
    if (!state.verifiers[name]) gas += verifierGas[name];
  }
  return gas;
}

export function v13DeploymentCostWei(gas: bigint, maxFeePerGas: bigint, marginPercent = 10n): bigint {
  if (gas < 0n || maxFeePerGas < 0n || marginPercent < 0n) throw new Error("Invalid v13 deployment budget");
  return gas * maxFeePerGas * (100n + marginPercent) / 100n;
}
