import { getAddress, type Hex } from "viem";
import type { V11EscrowedOrder } from "./v11SingleOrderRunner.js";

const sides = new Set(["YES_BUY", "YES_SELL", "NO_BUY", "NO_SELL"]);

/** Parse a one-time operator manifest; the driver verifies every escrow field on-chain. */
export function parseV11OrderManifest(json: string, expectedBatchId: string): V11EscrowedOrder {
  if (!/^\d+$/.test(expectedBatchId)) throw new Error("Invalid v11 batch ID");
  const raw: unknown = JSON.parse(json);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("V11 order manifest must be an object");
  }
  const record = raw as Record<string, unknown>;
  const read = (key: string): string => {
    const value = record[key];
    if (typeof value !== "string" || !value) throw new Error(`Invalid v11 manifest ${key}`);
    return value;
  };
  const decimal = (key: string): bigint => {
    const value = read(key);
    if (!/^(?:0|[1-9]\d*)$/.test(value)) throw new Error(`Invalid v11 manifest ${key}`);
    return BigInt(value);
  };
  const bytes32 = (key: string): Hex => {
    const value = read(key);
    if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error(`Invalid v11 manifest ${key}`);
    return value as Hex;
  };
  if (read("batchId") !== expectedBatchId) throw new Error("V11 manifest batch ID differs from command");
  const side = read("side");
  if (!sides.has(side)) throw new Error("Invalid v11 manifest side");
  return {
    batchId: expectedBatchId,
    marketId: bytes32("marketId"), commitment: bytes32("commitment"),
    side: side as V11EscrowedOrder["side"], deposit: decimal("deposit"),
    limitPrice: decimal("limitPrice"), salt: bytes32("salt"),
    tokenId: decimal("tokenId"), priceTick: decimal("priceTick"),
    depositWallet: getAddress(read("depositWallet")),
  };
}
