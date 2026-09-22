import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { WalletType } from "@polymarket/client";
import { loadV13Circuit, v13OrderCommitment } from "./v13Proofs.js";
import { V13MerkleTree } from "./v13MerkleTree.js";
import type { V13PolygonDriverConfig } from "./v13PolygonDriver.js";
import { V13PolygonDriver } from "./v13PolygonDriver.js";
import type { V13BuyRequest } from "./v13BuyRunner.js";
import type { Hex } from "viem";

const funding = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("./v12PolygonDriver.js", () => ({ V12PolygonDriver: class { assertFunding = funding; } }));
const word = (byte: string) => `0x${byte.repeat(64)}` as Hex;

describe("v13 production runtime", () => {
  it.each(["order", "route", "settlement", "cancel"] as const)("ships the exact compiled %s circuit", (kind) => {
    const built = JSON.parse(readFileSync(new URL(
      `../../circuits/shielded_${kind}_v13/target/shielded_${kind}_v13.json`, import.meta.url), "utf8"));
    expect(loadV13Circuit(kind)).toEqual(built);
  });

  it.each(["accepted", "rejected", "submitting", "uncertain", "prepared", null])(
    "uses CLOB evidence for %s orders instead of requiring the pre-fill balance", async (state) => {
      funding.mockClear();
      const positionAsset = word("2");
      const orders = ["7", "8"].map((secret) => ({ positionAsset, deposit: 500_000n,
        limitPrice: 600_000n, refundPublicKey: word("3"), positionPublicKey: word("4"), orderSecret: word(secret) }));
      const tree = new V13MerkleTree();
      orders.forEach((order, index) => tree.append(index, v13OrderCommitment(order)));
      const address = "0x0000000000000000000000000000000000000011";
      const input: V13BuyRequest = { marketId: word("9"), positionTokenId: 99n,
        priceTick: 10_000n, depositWallet: address, witness: { collateralAsset: word("1"), positionAsset,
          orders: orders.map((order, index) => ({ ...order, merkle: tree.witness(index) })) as V13BuyRequest["witness"]["orders"] } };
      const driver = new V13PolygonDriver({ rpcUrl: "http://127.0.0.1:1", relayerKey: word("1"),
        clob: { account: { walletType: WalletType.DEPOSIT_WALLET, wallet: address } },
        orderJournal: { get: async () => state ? { state } : null },
      } as unknown as V13PolygonDriverConfig);
      await driver.assertFunding(input, 1_000_000n);
      expect(funding).toHaveBeenCalledTimes(state === "prepared" || state === null ? 1 : 0);
    });
});
