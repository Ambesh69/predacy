import { createRequire } from "node:module";
import { concatHex, encodeAbiParameters, keccak256, zeroHash, type Hex } from "viem";

const require = createRequire(import.meta.url);
const MAX_U64 = (1n << 64n) - 1n;
const TREE_DEPTH = 20;
const domain = (value: number) => `0x${"00".repeat(31)}${value.toString(16).padStart(2, "0")}` as Hex;
const DOMAIN_NOTE = domain(1);
const DOMAIN_NOTE_NULLIFIER = domain(2);
const DOMAIN_ORDER = domain(5);
const DOMAIN_ORDER_NULLIFIER = domain(6);
const DOMAIN_BATCH = domain(7);

export interface V13MerkleWitness { root: Hex; path: Hex[]; index: number }
export interface V13PrivateOrder {
  positionAsset: Hex;
  deposit: bigint;
  limitPrice: bigint;
  refundPublicKey: Hex;
  positionPublicKey: Hex;
  orderSecret: Hex;
  merkle: V13MerkleWitness;
}
export interface V13Fill { spent: bigint; shares: bigint }
export interface V13OrderLockWitness extends Omit<V13PrivateOrder, "merkle"> {
  collateralAsset: Hex;
  noteSecret: Hex;
  merkle: V13MerkleWitness;
}
export interface V13BatchWitness {
  collateralAsset: Hex;
  positionAsset: Hex;
  orders: [V13PrivateOrder, V13PrivateOrder];
}

function assertWord(value: Hex, label = "value"): void {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error(`${label} must be bytes32`);
}

function bytes(value: Hex): number[] {
  assertWord(value);
  return Array.from(Buffer.from(value.slice(2), "hex"));
}

function u64(value: bigint, label = "value"): string {
  if (value < 0n || value > MAX_U64) throw new Error(`${label} exceeds u64 range`);
  return value.toString();
}

function halves(value: Hex): [string, string] {
  assertWord(value);
  return [BigInt(`0x${value.slice(2, 34)}`).toString(), BigInt(`0x${value.slice(34)}`).toString()];
}

function field(value: string | bigint): Hex {
  const number = typeof value === "bigint" ? value : BigInt(value);
  return `0x${number.toString(16).padStart(64, "0")}` as Hex;
}

function hashPair(left: Hex, right: Hex): Hex {
  assertWord(left);
  assertWord(right);
  return keccak256(concatHex([left, right]));
}

export function v13MerkleRoot(leaf: Hex, merkle: Omit<V13MerkleWitness, "root">): Hex {
  if (!Number.isSafeInteger(merkle.index) || merkle.index < 0 || merkle.index >= 1 << TREE_DEPTH ||
      merkle.path.length !== TREE_DEPTH) throw new Error("Invalid v13 Merkle witness");
  let current = leaf;
  merkle.path.forEach((sibling, level) => {
    current = ((merkle.index >> level) & 1) === 0 ? hashPair(current, sibling) : hashPair(sibling, current);
  });
  return current;
}

export function v13NoteCommitment(asset: Hex, amount: bigint, publicKey: Hex): Hex {
  assertWord(asset, "asset");
  assertWord(publicKey, "publicKey");
  u64(amount, "note amount");
  if (amount === 0n) return zeroHash;
  return keccak256(encodeAbiParameters(
    [{ type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "bytes32" }],
    [DOMAIN_NOTE, asset, amount, publicKey],
  ));
}

export function v13Nullifier(commitment: Hex, secret: Hex, nullifierDomain: 2 | 6): Hex {
  assertWord(commitment, "commitment");
  assertWord(secret, "secret");
  return keccak256(encodeAbiParameters(
    [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }],
    [nullifierDomain === 2 ? DOMAIN_NOTE_NULLIFIER : DOMAIN_ORDER_NULLIFIER, commitment, secret],
  ));
}

export function v13OrderCommitment(order: Omit<V13PrivateOrder, "merkle">): Hex {
  if (order.deposit <= 0n || order.limitPrice <= 0n || order.limitPrice >= 1_000_000n) {
    throw new Error("Invalid v13 private order");
  }
  u64(order.deposit, "deposit");
  u64(order.limitPrice, "limitPrice");
  for (const [label, value] of Object.entries({ positionAsset: order.positionAsset,
    refundPublicKey: order.refundPublicKey, positionPublicKey: order.positionPublicKey,
    orderSecret: order.orderSecret })) assertWord(value as Hex, label);
  return keccak256(encodeAbiParameters(
    [
      { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "uint256" },
      { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" },
    ],
    [DOMAIN_ORDER, order.positionAsset, order.deposit, order.limitPrice, order.refundPublicKey,
      order.positionPublicKey, keccak256(order.orderSecret)],
  ));
}

export function v13BatchBinding(
  positionAsset: Hex, nullifiers: [Hex, Hex], fullRefunds: [Hex, Hex], totalDeposit: bigint,
): Hex {
  return keccak256(encodeAbiParameters(
    [
      { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" },
      { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" },
    ],
    [DOMAIN_BATCH, positionAsset, ...nullifiers, ...fullRefunds, totalDeposit],
  ));
}

function validateMerkle(leaf: Hex, witness: V13MerkleWitness): void {
  assertWord(witness.root, "root");
  witness.path.forEach((value) => assertWord(value, "path element"));
  if (v13MerkleRoot(leaf, witness).toLowerCase() !== witness.root.toLowerCase()) {
    throw new Error("V13 Merkle root mismatch");
  }
}

export function buildV13OrderLockInputs(witness: V13OrderLockWitness) {
  const notePublicKey = keccak256(witness.noteSecret);
  const inputNote = v13NoteCommitment(witness.collateralAsset, witness.deposit, notePublicKey);
  validateMerkle(inputNote, witness.merkle);
  const noteNullifier = v13Nullifier(inputNote, witness.noteSecret, 2);
  const orderCommitment = v13OrderCommitment(witness);
  const [rootHigh, rootLow] = halves(witness.merkle.root);
  const [nullifierHigh, nullifierLow] = halves(noteNullifier);
  const [collateralHigh, collateralLow] = halves(witness.collateralAsset);
  const [orderHigh, orderLow] = halves(orderCommitment);
  return {
    noirInputs: {
      collateral_asset: bytes(witness.collateralAsset), position_asset: bytes(witness.positionAsset),
      deposit: u64(witness.deposit), limit_price: u64(witness.limitPrice), note_secret: bytes(witness.noteSecret),
      path: witness.merkle.path.map(bytes), index: witness.merkle.index.toString(),
      refund_public_key: bytes(witness.refundPublicKey), position_public_key: bytes(witness.positionPublicKey),
      order_secret: bytes(witness.orderSecret), root_high: rootHigh, root_low: rootLow,
      note_nullifier_high: nullifierHigh, note_nullifier_low: nullifierLow,
      collateral_high: collateralHigh, collateral_low: collateralLow, order_high: orderHigh, order_low: orderLow,
    },
    publicInputs: [rootHigh, rootLow, nullifierHigh, nullifierLow, collateralHigh, collateralLow,
      orderHigh, orderLow].map(field),
    inputNote, noteNullifier, orderCommitment,
  };
}

function validateBatch(batch: V13BatchWitness) {
  assertWord(batch.collateralAsset, "collateralAsset");
  assertWord(batch.positionAsset, "positionAsset");
  const commitments = batch.orders.map((order) => {
    if (order.positionAsset.toLowerCase() !== batch.positionAsset.toLowerCase()) {
      throw new Error("V13 batch contains another position asset");
    }
    const commitment = v13OrderCommitment(order);
    validateMerkle(commitment, order.merkle);
    return commitment;
  }) as [Hex, Hex];
  const root = batch.orders[0].merkle.root;
  if (batch.orders[1].merkle.root.toLowerCase() !== root.toLowerCase()) {
    throw new Error("V13 orders must share one Merkle root");
  }
  const nullifiers = commitments.map((value, i) =>
    v13Nullifier(value, batch.orders[i].orderSecret, 6)) as [Hex, Hex];
  if (nullifiers[0] === nullifiers[1]) throw new Error("Duplicate v13 order nullifier");
  const fullRefunds = batch.orders.map((order) =>
    v13NoteCommitment(batch.collateralAsset, order.deposit, order.refundPublicKey)) as [Hex, Hex];
  const totalDeposit = batch.orders.reduce((sum, order) => sum + order.deposit, 0n);
  u64(totalDeposit, "totalDeposit");
  const binding = v13BatchBinding(batch.positionAsset, nullifiers, fullRefunds, totalDeposit);
  return { commitments, root, nullifiers, fullRefunds, totalDeposit, binding };
}

export function buildV13RouteInputs(batch: V13BatchWitness) {
  const built = validateBatch(batch);
  const [rootHigh, rootLow] = halves(built.root);
  const [collateralHigh, collateralLow] = halves(batch.collateralAsset);
  const [positionHigh, positionLow] = halves(batch.positionAsset);
  const split = (values: [Hex, Hex], half: 0 | 1) => values.map((value) => halves(value)[half]);
  const [bindingHigh, bindingLow] = halves(built.binding);
  return {
    noirInputs: {
      collateral_asset: bytes(batch.collateralAsset), position_asset: bytes(batch.positionAsset),
      deposits: batch.orders.map((order) => u64(order.deposit)),
      limits: batch.orders.map((order) => u64(order.limitPrice)),
      refund_public_keys: batch.orders.map((order) => bytes(order.refundPublicKey)),
      position_public_keys: batch.orders.map((order) => bytes(order.positionPublicKey)),
      order_secrets: batch.orders.map((order) => bytes(order.orderSecret)),
      paths: batch.orders.map((order) => order.merkle.path.map(bytes)),
      indices: batch.orders.map((order) => order.merkle.index.toString()),
      root_high: rootHigh, root_low: rootLow, collateral_high: collateralHigh, collateral_low: collateralLow,
      position_high: positionHigh, position_low: positionLow,
      nullifier_high: split(built.nullifiers, 0), nullifier_low: split(built.nullifiers, 1),
      refund_high: split(built.fullRefunds, 0), refund_low: split(built.fullRefunds, 1),
      total_deposit: u64(built.totalDeposit), binding_high: bindingHigh, binding_low: bindingLow,
    },
    publicInputs: [rootHigh, rootLow, collateralHigh, collateralLow, positionHigh, positionLow,
      ...split(built.nullifiers, 0), ...split(built.nullifiers, 1),
      ...split(built.fullRefunds, 0), ...split(built.fullRefunds, 1), built.totalDeposit.toString(),
      bindingHigh, bindingLow].map(field),
    ...built,
  };
}

export function buildV13SettlementInputs(batch: V13BatchWitness, fills: [V13Fill, V13Fill]) {
  const built = validateBatch(batch);
  fills.forEach((fill, i) => {
    const order = batch.orders[i];
    if (fill.spent < 0n || fill.spent > order.deposit || (fill.spent === 0n) !== (fill.shares === 0n) ||
        fill.spent * 1_000_000n > fill.shares * order.limitPrice) throw new Error("Invalid v13 fill");
    u64(fill.spent, "spent");
    u64(fill.shares, "shares");
  });
  const refunds = batch.orders.map((order, i) =>
    v13NoteCommitment(batch.collateralAsset, order.deposit - fills[i].spent, order.refundPublicKey)) as [Hex, Hex];
  const positions = batch.orders.map((order, i) =>
    v13NoteCommitment(batch.positionAsset, fills[i].shares, order.positionPublicKey)) as [Hex, Hex];
  const totalSpent = fills.reduce((sum, fill) => sum + fill.spent, 0n);
  const totalShares = fills.reduce((sum, fill) => sum + fill.shares, 0n);
  const [bindingHigh, bindingLow] = halves(built.binding);
  const [collateralHigh, collateralLow] = halves(batch.collateralAsset);
  const [positionHigh, positionLow] = halves(batch.positionAsset);
  const split = (values: [Hex, Hex], half: 0 | 1) => values.map((value) => halves(value)[half]);
  return {
    noirInputs: {
      collateral_asset: bytes(batch.collateralAsset), position_asset: bytes(batch.positionAsset),
      deposits: batch.orders.map((order) => u64(order.deposit)), limits: batch.orders.map((order) => u64(order.limitPrice)),
      refund_public_keys: batch.orders.map((order) => bytes(order.refundPublicKey)),
      position_public_keys: batch.orders.map((order) => bytes(order.positionPublicKey)),
      order_secrets: batch.orders.map((order) => bytes(order.orderSecret)),
      spent: fills.map((fill) => u64(fill.spent)), shares: fills.map((fill) => u64(fill.shares)),
      binding_high: bindingHigh, binding_low: bindingLow, collateral_high: collateralHigh,
      collateral_low: collateralLow, position_high: positionHigh, position_low: positionLow,
      refund_high: split(refunds, 0), refund_low: split(refunds, 1),
      position_note_high: split(positions, 0), position_note_low: split(positions, 1),
      total_deposit: u64(built.totalDeposit), total_spent: u64(totalSpent), total_shares: u64(totalShares),
    },
    publicInputs: [bindingHigh, bindingLow, collateralHigh, collateralLow, positionHigh, positionLow,
      ...split(refunds, 0), ...split(refunds, 1), ...split(positions, 0), ...split(positions, 1),
      built.totalDeposit.toString(), totalSpent.toString(), totalShares.toString()].map(field),
    ...built, refundCommitments: refunds, positionCommitments: positions, totalSpent, totalShares,
  };
}

export function buildV13CancelInputs(collateralAsset: Hex, order: V13PrivateOrder) {
  const commitment = v13OrderCommitment(order);
  validateMerkle(commitment, order.merkle);
  const nullifier = v13Nullifier(commitment, order.orderSecret, 6);
  const refund = v13NoteCommitment(collateralAsset, order.deposit, order.refundPublicKey);
  const [rootHigh, rootLow] = halves(order.merkle.root);
  const [nullifierHigh, nullifierLow] = halves(nullifier);
  const [collateralHigh, collateralLow] = halves(collateralAsset);
  const [refundHigh, refundLow] = halves(refund);
  return {
    noirInputs: {
      position_asset: bytes(order.positionAsset), deposit: u64(order.deposit), limit_price: u64(order.limitPrice),
      refund_public_key: bytes(order.refundPublicKey), position_public_key: bytes(order.positionPublicKey),
      order_secret: bytes(order.orderSecret), path: order.merkle.path.map(bytes), index: order.merkle.index.toString(),
      root_high: rootHigh, root_low: rootLow, order_nullifier_high: nullifierHigh,
      order_nullifier_low: nullifierLow, collateral_high: collateralHigh, collateral_low: collateralLow,
      refund_high: refundHigh, refund_low: refundLow, total_deposit: u64(order.deposit),
      collateral_asset: bytes(collateralAsset),
    },
    publicInputs: [rootHigh, rootLow, nullifierHigh, nullifierLow, collateralHigh, collateralLow,
      refundHigh, refundLow, order.deposit.toString()].map(field),
    orderCommitment: commitment, orderNullifier: nullifier, refundCommitment: refund,
  };
}

export function loadV13Circuit(kind: "order" | "route" | "settlement" | "cancel") {
  const circuit = require(`../circuits/shielded_${kind}_v13.json`);
  if (!circuit.bytecode || !circuit.abi?.parameters?.length) throw new Error(`Invalid bundled v13 ${kind} circuit`);
  return circuit as ConstructorParameters<(typeof import("@noir-lang/noir_js"))["Noir"]>[0];
}

async function prove(kind: "order" | "route" | "settlement" | "cancel", noirInputs: Record<string, unknown>, expected: Hex[]) {
  const { Noir } = await import("@noir-lang/noir_js");
  const { Barretenberg, BackendType, UltraHonkBackend } = await import("@aztec/bb.js");
  const circuit = loadV13Circuit(kind);
  const api = await Barretenberg.new(process.env.BB_BACKEND === "wasm"
    ? { backend: BackendType.Wasm }
    : process.env.BB_PATH ? { bbPath: process.env.BB_PATH } : {});
  try {
    // The route verifier uses a 2^21 circuit; bb.js defaults to a 2^20 CRS.
    await api.initSRSChonk(kind === "route" ? 2 ** 21 : 2 ** 20);
    const { witness } = await new Noir(circuit).execute(noirInputs as never);
    const result = await new UltraHonkBackend(circuit.bytecode, api).generateProof(witness, { verifierTarget: "evm" });
    const publicInputs = result.publicInputs.map((value) =>
      (value.startsWith("0x") ? value : `0x${value.padStart(64, "0")}`) as Hex);
    if (publicInputs.length !== expected.length || publicInputs.some((value, i) => value !== expected[i])) {
      throw new Error("V13 prover public inputs differ from contract encoding");
    }
    return { proof: `0x${Buffer.from(result.proof).toString("hex")}` as Hex, publicInputs };
  } finally {
    await api.destroy();
  }
}

export async function proveV13Route(batch: V13BatchWitness) {
  const built = buildV13RouteInputs(batch);
  return { ...(await prove("route",
    built.noirInputs, built.publicInputs)), ...built };
}

export async function proveV13OrderLock(witness: V13OrderLockWitness) {
  const built = buildV13OrderLockInputs(witness);
  return { ...(await prove("order",
    built.noirInputs, built.publicInputs)), ...built };
}

export async function proveV13Settlement(batch: V13BatchWitness, fills: [V13Fill, V13Fill]) {
  const built = buildV13SettlementInputs(batch, fills);
  return { ...(await prove("settlement",
    built.noirInputs, built.publicInputs)), ...built };
}

export async function proveV13Cancel(collateralAsset: Hex, order: V13PrivateOrder) {
  const built = buildV13CancelInputs(collateralAsset, order);
  return { ...(await prove("cancel",
    built.noirInputs, built.publicInputs)), ...built };
}
