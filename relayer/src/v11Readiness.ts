import { getAddress, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export const V11_REQUIRED_ENV = [
  "RPC_URL",
  "V11_DATABASE_URL",
  "V11_VAULT_ADDRESS",
  "V11_RELAYER_PRIVATE_KEY",
  "V11_SIGNER_PRIVATE_KEY",
  "V11_DEPOSIT_WALLET",
  "V11_GUARDIAN",
  "V11_ALLOCATION_VERIFIER",
  "V11_EXCHANGE_ADDRESS",
  "POLYMARKET_BUILDER_KEY",
  "POLYMARKET_BUILDER_SECRET",
  "POLYMARKET_BUILDER_PASSPHRASE",
] as const;

export interface V11Readiness {
  readyForReadOnlyChecks: boolean;
  missing: string[];
  errors: string[];
}

/** Configuration checks only; this never grants permission to trade. */
export function assessV11Environment(env: NodeJS.ProcessEnv): V11Readiness {
  const missing = V11_REQUIRED_ENV.filter((key) => !env[key]?.trim());
  const errors: string[] = [];
  if (env.CHAIN_ID !== "137") errors.push("CHAIN_ID must be Polygon mainnet (137)");
  for (const key of ["V11_VAULT_ADDRESS", "V11_DEPOSIT_WALLET", "V11_GUARDIAN",
    "V11_ALLOCATION_VERIFIER", "V11_EXCHANGE_ADDRESS"] as const) {
    const value = env[key];
    if (!value) continue;
    try {
      if (getAddress(value) === getAddress("0x0000000000000000000000000000000000000000")) {
        errors.push(`${key} cannot be the zero address`);
      }
    } catch {
      errors.push(`${key} is not an EVM address`);
    }
  }
  if (env.V11_VAULT_ADDRESS && env.VAULT_ADDRESS) {
    try {
      if (getAddress(env.V11_VAULT_ADDRESS) === getAddress(env.VAULT_ADDRESS)) {
        errors.push("V11_VAULT_ADDRESS still points to the active v10 vault");
      }
    } catch { /* Address validation above reports the v11 error. */ }
  }
  for (const key of ["V11_RELAYER_PRIVATE_KEY", "V11_SIGNER_PRIVATE_KEY"] as const) {
    const value = env[key];
    if (value && !/^0x[0-9a-fA-F]{64}$/.test(value)) errors.push(`${key} is not a 32-byte private key`);
  }
  if (env.V11_RELAYER_PRIVATE_KEY && env.V11_SIGNER_PRIVATE_KEY &&
      env.V11_RELAYER_PRIVATE_KEY.toLowerCase() === env.V11_SIGNER_PRIVATE_KEY.toLowerCase()) {
    errors.push("V11 signer and relayer keys must be separate");
  }
  if (env.V11_RELAYER_PRIVATE_KEY && /^0x[0-9a-fA-F]{64}$/.test(env.V11_RELAYER_PRIVATE_KEY) &&
      env.V11_GUARDIAN) {
    try {
      if (getAddress(env.V11_GUARDIAN) ===
          privateKeyToAccount(env.V11_RELAYER_PRIVATE_KEY as `0x${string}`).address) {
        errors.push("V11 guardian and relayer must be separate");
      }
    } catch { /* Address validation above reports the guardian error. */ }
  }
  return { readyForReadOnlyChecks: missing.length === 0 && errors.length === 0, missing, errors };
}

export interface V11VaultIdentity {
  depositWallet: Address;
  relayer: Address;
  guardian: Address;
  allocationVerifier: Address;
}

export function assertV11VaultIdentity(actual: V11VaultIdentity, expected: V11VaultIdentity): void {
  for (const key of ["depositWallet", "relayer", "guardian", "allocationVerifier"] as const) {
    if (getAddress(actual[key]) !== getAddress(expected[key])) {
      throw new Error(`V11 vault ${key} differs from deployment configuration`);
    }
  }
}
