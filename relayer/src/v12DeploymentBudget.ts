import type { Address } from "viem";

export const V12_DEPLOYMENT_GAS = {
  transcriptLibraries: {
    withdraw: 1_333_869n,
    transfer: 1_333_869n,
    order: 1_333_869n,
    buyBatch: 1_333_857n,
  },
  withdrawVerifier: 5_181_137n,
  transferVerifier: 5_181_713n,
  orderVerifier: 5_181_733n,
  buyBatchVerifier: 5_181_301n,
  poolAndAdapter: 4_732_950n,
} as const;

export const V12_TRANSCRIPT_LIBRARY =
  "0x9a2abcf4ca811335cff4ed1b1d0d4d4034889350" as const satisfies Address;
export const V12_TRANSCRIPT_LIBRARY_CODE_HASH =
  "0x9003d7c2966e6395f85e84aa6f01ccb4b41f2aea1ec536db27d6d927fc3f15c6" as const;

export interface V12DeploymentState {
  transcriptLibrary: boolean;
  verifiers: Record<"withdraw" | "transfer" | "order" | "buyBatch", boolean>;
  poolAndAdapter: boolean;
}

export function remainingV12DeploymentGas(state: V12DeploymentState): bigint {
  const verifierGas = {
    withdraw: V12_DEPLOYMENT_GAS.withdrawVerifier,
    transfer: V12_DEPLOYMENT_GAS.transferVerifier,
    order: V12_DEPLOYMENT_GAS.orderVerifier,
    buyBatch: V12_DEPLOYMENT_GAS.buyBatchVerifier,
  } as const;

  let gas = 0n;
  let transcriptLibraryAccounted = state.transcriptLibrary;
  for (const name of Object.keys(verifierGas) as Array<keyof typeof verifierGas>) {
    if (state.verifiers[name]) continue;
    if (!transcriptLibraryAccounted) {
      gas += V12_DEPLOYMENT_GAS.transcriptLibraries.withdraw;
      transcriptLibraryAccounted = true;
    }
    gas += verifierGas[name];
  }
  if (!state.poolAndAdapter) gas += V12_DEPLOYMENT_GAS.poolAndAdapter;
  return gas;
}

export function addDeploymentSafetyMargin(gas: bigint): bigint {
  return (gas * 110n + 99n) / 100n;
}
