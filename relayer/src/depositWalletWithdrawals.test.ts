import { describe, expect, it, vi } from "vitest";
import type { Signer, TransactionHandle } from "@polymarket/client";
import {
  completeGaslessWorkflow, withdrawPusdFromDepositWallet, type GaslessWorkflow,
} from "./depositWalletWithdrawals.js";
import type { DepositWalletClient } from "./depositWalletClient.js";

const address = "0x0000000000000000000000000000000000000001";
const signature = `0x${"11".repeat(65)}`;

describe("Deposit Wallet gasless workflow", () => {
  it("satisfies address and signing requests in order", async () => {
    const handle = { wait: vi.fn() } as unknown as TransactionHandle;
    const signer = {
      getAddress: vi.fn(async () => address),
      signMessage: vi.fn(async () => signature),
      signTypedData: vi.fn(async () => signature),
    } as unknown as Signer;
    const workflow = (async function* (): AsyncGenerator<unknown, TransactionHandle, unknown> {
      const requestedAddress = yield { kind: "requestAddress" as const };
      expect(requestedAddress).toBe(address);
      const signedMessage = yield { kind: "signGaslessMessage" as const, payload: "0x12" };
      expect(signedMessage).toBe(signature);
      const signedTypedData = yield { kind: "signGaslessTypedData" as const, payload: {} };
      expect(signedTypedData).toBe(signature);
      return handle;
    })() as GaslessWorkflow;

    expect(await completeGaslessWorkflow(workflow, signer)).toBe(handle);
    expect(signer.getAddress).toHaveBeenCalledOnce();
    expect(signer.signMessage).toHaveBeenCalledOnce();
    expect(signer.signTypedData).toHaveBeenCalledOnce();
  });

  it("rejects a non-Deposit Wallet before initiating a pUSD transfer", async () => {
    const client = { account: { walletType: -1 } } as unknown as DepositWalletClient;
    await expect(withdrawPusdFromDepositWallet(
      client, {} as Signer, "https://polygon.invalid", address, address, 1n,
    )).rejects.toThrow(/requires a Deposit Wallet/);
  });
});
