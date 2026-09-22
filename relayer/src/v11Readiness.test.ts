import { describe, expect, it } from "vitest";
import { assessV11Environment, assertV11VaultIdentity, V11_REQUIRED_ENV } from "./v11Readiness.js";

const address = "0x00000000000000000000000000000000000000aa" as const;
const other = "0x00000000000000000000000000000000000000bb" as const;
const env: NodeJS.ProcessEnv = {
  CHAIN_ID: "137", VAULT_ADDRESS: other,
  RPC_URL: "https://polygon.invalid",
  V11_DATABASE_URL: "postgres://example.invalid/db",
  V11_VAULT_ADDRESS: address,
  V11_RELAYER_PRIVATE_KEY: `0x${"11".repeat(32)}`,
  V11_SIGNER_PRIVATE_KEY: `0x${"22".repeat(32)}`,
  V11_DEPOSIT_WALLET: address,
  V11_GUARDIAN: other,
  V11_ALLOCATION_VERIFIER: address,
  V11_EXCHANGE_ADDRESS: address,
  POLYMARKET_BUILDER_KEY: "test",
  POLYMARKET_BUILDER_SECRET: "test",
  POLYMARKET_BUILDER_PASSPHRASE: "test",
};

describe("v11 read-only preflight", () => {
  it("requires a dedicated v11 vault, signer, wallet, and journal URL", () => {
    expect(assessV11Environment(env)).toEqual({ readyForReadOnlyChecks: true, missing: [], errors: [] });
    const missing = assessV11Environment({ ...env, V11_DATABASE_URL: "", V11_DEPOSIT_WALLET: "" });
    expect(missing.readyForReadOnlyChecks).toBe(false);
    expect(missing.missing).toEqual(["V11_DATABASE_URL", "V11_DEPOSIT_WALLET"]);
    expect(V11_REQUIRED_ENV).toContain("V11_SIGNER_PRIVATE_KEY");
  });

  it("rejects v10 reuse and signer/relayer key reuse", () => {
    const result = assessV11Environment({ ...env, V11_VAULT_ADDRESS: other,
      V11_SIGNER_PRIVATE_KEY: env.V11_RELAYER_PRIVATE_KEY, CHAIN_ID: "80002" });
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.stringMatching(/Polygon mainnet/),
      expect.stringMatching(/active v10 vault/),
      expect.stringMatching(/must be separate/),
    ]));
  });

  it("requires a guardian distinct from the relayer", () => {
    const result = assessV11Environment({ ...env,
      V11_GUARDIAN: "0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A" });
    expect(result.errors).toEqual(expect.arrayContaining([expect.stringMatching(/guardian and relayer/)]));
  });

  it("compares on-chain vault identity before any trading action", () => {
    const expected = { depositWallet: address, relayer: address, guardian: other,
      allocationVerifier: address };
    expect(() => assertV11VaultIdentity(expected, expected)).not.toThrow();
    expect(() => assertV11VaultIdentity({ ...expected, relayer: other }, expected))
      .toThrow(/relayer differs/);
    expect(() => assertV11VaultIdentity({ ...expected, guardian: address }, expected))
      .toThrow(/guardian differs/);
  });
});
