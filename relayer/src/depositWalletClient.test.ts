import { describe, expect, it } from "vitest";
import { WalletType } from "@polymarket/client";
import { assertDepositWalletIdentity } from "./depositWalletClient.js";

const signer = "0x0000000000000000000000000000000000000001" as const;
const wallet = "0x0000000000000000000000000000000000000002" as const;

describe("Deposit Wallet identity", () => {
  it("accepts the expected signer and wallet", () => {
    expect(() => assertDepositWalletIdentity(
      { signer, wallet, walletType: WalletType.DEPOSIT_WALLET }, signer, wallet,
    )).not.toThrow();
  });

  it("rejects an EOA maker", () => {
    expect(() => assertDepositWalletIdentity(
      { signer, wallet: signer, walletType: WalletType.EOA }, signer, wallet,
    )).toThrow(/not a Deposit Wallet/);
  });

  it("rejects a mismatched signer", () => {
    expect(() => assertDepositWalletIdentity(
      { signer: wallet, wallet, walletType: WalletType.DEPOSIT_WALLET }, signer, wallet,
    )).toThrow(/signer does not match/);
  });

  it("rejects a mismatched derived wallet", () => {
    expect(() => assertDepositWalletIdentity(
      { signer, wallet: signer, walletType: WalletType.DEPOSIT_WALLET }, signer, wallet,
    )).toThrow(/Derived Deposit Wallet/);
  });
});
