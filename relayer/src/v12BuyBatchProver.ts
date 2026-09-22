import { createRequire } from "node:module";
import { encodeAbiParameters, keccak256, zeroHash, type Hex } from "viem";

const require = createRequire(import.meta.url);
const MAX_U64 = (1n << 64n) - 1n;
const DOMAIN_NOTE = `0x${"00".repeat(31)}01` as Hex;
const DOMAIN_ORDER = `0x${"00".repeat(31)}04` as Hex;

export interface V12PrivateBuyOrder {
  inputNote: Hex;
  deposit: bigint;
  limitPrice: bigint;
  salt: Hex;
  refundPublicKey: Hex;
  positionPublicKey: Hex;
}

export interface V12BuyFill {
  spent: bigint;
  shares: bigint;
}

export interface V12BuyBatchWitness {
  collateralAsset: Hex;
  positionAsset: Hex;
  orders: V12PrivateBuyOrder[];
  fills: V12BuyFill[];
}

function bytes32(hex: Hex): number[] {
  if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) throw new Error("Expected a 32-byte hex value");
  return Array.from(Buffer.from(hex.slice(2), "hex"));
}

function halves(hex: Hex): [string, string] {
  bytes32(hex);
  return [BigInt(`0x${hex.slice(2, 34)}`).toString(), BigInt(`0x${hex.slice(34)}`).toString()];
}

function u64(value: bigint): string {
  if (value < 0n || value > MAX_U64) throw new Error("V12 proof input exceeds u64 range");
  return value.toString();
}

export function v12NoteCommitment(asset: Hex, amount: bigint, publicKey: Hex): Hex {
  if (amount === 0n) return zeroHash;
  u64(amount);
  return keccak256(encodeAbiParameters(
    [{ type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "bytes32" }],
    [DOMAIN_NOTE, asset, amount, publicKey],
  ));
}

export function v12OrderCommitment(order: V12PrivateBuyOrder, positionAsset: Hex): Hex {
  return keccak256(encodeAbiParameters(
    [
      { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" },
      { type: "uint256" }, { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" },
    ],
    [DOMAIN_ORDER, order.inputNote, positionAsset, order.deposit, order.limitPrice,
      order.refundPublicKey, order.positionPublicKey, order.salt],
  ));
}

/** Builds the canonical Noir witness and the exact 20 inputs expected by ShieldedPoolV1. */
export function buildV12BuyBatchInputs(batch: V12BuyBatchWitness) {
  if (batch.orders.length < 1 || batch.orders.length > 2 || batch.fills.length !== batch.orders.length) {
    throw new Error("V12 buy batch requires one or two matching orders and fills");
  }
  bytes32(batch.collateralAsset);
  bytes32(batch.positionAsset);

  const paddedOrders: V12PrivateBuyOrder[] = [...batch.orders];
  const paddedFills: V12BuyFill[] = [...batch.fills];
  while (paddedOrders.length < 2) {
    paddedOrders.push({
      inputNote: zeroHash, deposit: 0n, limitPrice: 0n, salt: zeroHash,
      refundPublicKey: zeroHash, positionPublicKey: zeroHash,
    });
    paddedFills.push({ spent: 0n, shares: 0n });
  }

  for (let i = 0; i < batch.orders.length; i++) {
    const order = paddedOrders[i];
    const fill = paddedFills[i];
    if (order.deposit <= 0n || order.limitPrice <= 0n || order.limitPrice >= 1_000_000n ||
        fill.spent < 0n || fill.spent > order.deposit || (fill.spent === 0n) !== (fill.shares === 0n) ||
        fill.spent * 1_000_000n > fill.shares * order.limitPrice) {
      throw new Error("Invalid V12 private buy order or fill");
    }
    u64(order.deposit);
    u64(order.limitPrice);
    u64(fill.spent);
    u64(fill.shares);
  }

  const orderCommitments = paddedOrders.map((order, index) =>
    index < batch.orders.length ? v12OrderCommitment(order, batch.positionAsset) : zeroHash);
  const refundCommitments = paddedOrders.map((order, index) => index < batch.orders.length
    ? v12NoteCommitment(batch.collateralAsset, order.deposit - paddedFills[index].spent, order.refundPublicKey)
    : zeroHash);
  const positionCommitments = paddedOrders.map((order, index) => index < batch.orders.length
    ? v12NoteCommitment(batch.positionAsset, paddedFills[index].shares, order.positionPublicKey)
    : zeroHash);
  const totalDeposit = batch.orders.reduce((sum, order) => sum + order.deposit, 0n);
  const totalSpent = batch.fills.reduce((sum, fill) => sum + fill.spent, 0n);
  const totalShares = batch.fills.reduce((sum, fill) => sum + fill.shares, 0n);
  const [collateralHigh, collateralLow] = halves(batch.collateralAsset);
  const [positionHigh, positionLow] = halves(batch.positionAsset);
  const split = (values: Hex[], half: 0 | 1) => values.map((value) => halves(value)[half]);

  const noirInputs = {
    collateral_asset: bytes32(batch.collateralAsset),
    position_asset: bytes32(batch.positionAsset),
    input_notes: paddedOrders.map((order) => bytes32(order.inputNote)),
    deposits: paddedOrders.map((order) => u64(order.deposit)),
    limits: paddedOrders.map((order) => u64(order.limitPrice)),
    salts: paddedOrders.map((order) => bytes32(order.salt)),
    refund_public_keys: paddedOrders.map((order) => bytes32(order.refundPublicKey)),
    position_public_keys: paddedOrders.map((order) => bytes32(order.positionPublicKey)),
    spent: paddedFills.map((fill) => u64(fill.spent)),
    shares: paddedFills.map((fill) => u64(fill.shares)),
    order_count: String(batch.orders.length),
    collateral_high: collateralHigh,
    collateral_low: collateralLow,
    position_high: positionHigh,
    position_low: positionLow,
    order_high: split(orderCommitments, 0),
    order_low: split(orderCommitments, 1),
    refund_high: split(refundCommitments, 0),
    refund_low: split(refundCommitments, 1),
    position_note_high: split(positionCommitments, 0),
    position_note_low: split(positionCommitments, 1),
    total_deposit: u64(totalDeposit),
    total_spent: u64(totalSpent),
    total_shares: u64(totalShares),
  };

  const publicInputs = [
    BigInt(batch.orders.length), BigInt(collateralHigh), BigInt(collateralLow),
    BigInt(positionHigh), BigInt(positionLow),
    ...split(orderCommitments, 0).map(BigInt), ...split(orderCommitments, 1).map(BigInt),
    ...split(refundCommitments, 0).map(BigInt), ...split(refundCommitments, 1).map(BigInt),
    ...split(positionCommitments, 0).map(BigInt), ...split(positionCommitments, 1).map(BigInt),
    totalDeposit, totalSpent, totalShares,
  ].map((value) => `0x${value.toString(16).padStart(64, "0")}` as Hex);

  return { noirInputs, publicInputs, orderCommitments, refundCommitments, positionCommitments,
    totalDeposit, totalSpent, totalShares };
}

export async function proveV12BuyBatch(batch: V12BuyBatchWitness): Promise<{
  proof: Hex;
  publicInputs: Hex[];
  orderCommitments: Hex[];
  refundCommitments: Hex[];
  positionCommitments: Hex[];
}> {
  const built = buildV12BuyBatchInputs(batch);
  const { Noir } = await import("@noir-lang/noir_js");
  const { Barretenberg, BackendType, UltraHonkBackend } = await import("@aztec/bb.js");
  const circuit = require("../../circuits/shielded_buy_batch_v1/target/shielded_buy_batch_v1.json") as
    ConstructorParameters<typeof Noir>[0];
  const api = await Barretenberg.new(process.env.BB_BACKEND === "wasm"
    ? { backend: BackendType.Wasm }
    : process.env.BB_PATH ? { bbPath: process.env.BB_PATH } : {});
  try {
    const noir = new Noir(circuit);
    const { witness } = await noir.execute(built.noirInputs);
    const backend = new UltraHonkBackend(circuit.bytecode, api);
    const result = await backend.generateProof(witness, { verifierTarget: "evm" });
    const publicInputs = result.publicInputs.map((input) =>
      (input.startsWith("0x") ? input : `0x${input.padStart(64, "0")}`) as Hex);
    if (publicInputs.length !== 20 || publicInputs.some((input, i) => input !== built.publicInputs[i])) {
      throw new Error("V12 prover public inputs differ from ShieldedPoolV1 encoding");
    }
    return {
      proof: `0x${Buffer.from(result.proof).toString("hex")}`,
      publicInputs,
      orderCommitments: built.orderCommitments,
      refundCommitments: built.refundCommitments,
      positionCommitments: built.positionCommitments,
    };
  } finally {
    await api.destroy();
  }
}
