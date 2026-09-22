import { getAddress, type Address } from "viem";

export interface BalanceAllowanceSnapshot {
  balance?: bigint | string;
  allowances?: Record<string, bigint | string>;
}

export interface FundingGateOptions {
  wallet: Address;
  exchange: Address;
  // Snapshot before initiating the vault-to-wallet transfer.
  startingBalance: bigint;
  incomingAmount: bigint;
  orderAmount: bigint;
  maxAttempts?: number;
  pollIntervalMs?: number;
}

export interface FundingGateDependencies {
  readOnChainBalance(): Promise<bigint>;
  refreshClobBalance(): Promise<BalanceAllowanceSnapshot>;
  sleep?(ms: number): Promise<void>;
}

/**
 * Wait for the confirmed transfer to be visible both on-chain and in the
 * CLOB's account cache. A successful update call alone is not evidence of funds.
 */
export async function awaitDepositWalletFunding(
  options: FundingGateOptions,
  dependencies: FundingGateDependencies,
): Promise<void> {
  getAddress(options.wallet);
  const exchange = getAddress(options.exchange);
  const attempts = options.maxAttempts ?? 45;
  const interval = options.pollIntervalMs ?? 2_000;
  if (options.startingBalance < 0n || options.incomingAmount <= 0n ||
      options.orderAmount <= 0n || options.orderAmount > options.startingBalance + options.incomingAmount ||
      !Number.isSafeInteger(attempts) || attempts < 1 ||
      !Number.isSafeInteger(interval) || interval < 0) {
    throw new Error("Invalid Deposit Wallet funding gate bounds");
  }

  const expectedBalance = options.startingBalance + options.incomingAmount;
  const sleep = dependencies.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const onChain = await dependencies.readOnChainBalance();
      if (onChain >= expectedBalance) {
        const clob = await dependencies.refreshClobBalance();
        const cached = parseAmount(clob.balance);
        const allowanceEntry = Object.entries(clob.allowances ?? {}).find(([address]) => {
          try { return getAddress(address) === exchange; } catch { return false; }
        });
        const allowance = parseAmount(allowanceEntry?.[1]);
        if (cached >= options.orderAmount && allowance >= options.orderAmount) return;
      }
    } catch (error) {
      lastError = error;
    }
    if (attempt + 1 < attempts) await sleep(interval);
  }
  throw new Error("Deposit Wallet funding is not confirmed in the CLOB; do not submit an order", {
    cause: lastError,
  });
}

function parseAmount(value: unknown): bigint {
  if (typeof value === "bigint" && value >= 0n) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
  return 0n;
}
