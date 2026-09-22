import {
  encodeAbiParameters,
  encodePacked,
  getAddress,
  keccak256,
  type Address,
  type Hex,
} from "viem";
import orderCircuit from "@/circuits/shielded_order_v13.json";
import withdrawCircuit from "@/circuits/shielded_withdraw_v1.json";
import cancelCircuit from "@/circuits/shielded_cancel_v13.json";
import type { InputMap } from "@noir-lang/noir_js";

const MAX_U64 = (1n << 64n) - 1n;
const LOW_128 = (1n << 128n) - 1n;
const DOMAIN_NOTE = `0x${"00".repeat(31)}01` as Hex;
const DOMAIN_NULLIFIER = `0x${"00".repeat(31)}02` as Hex;
const DOMAIN_WITHDRAW = `0x${"00".repeat(31)}03` as Hex;
const DOMAIN_ORDER = `0x${"00".repeat(31)}05` as Hex;
const DOMAIN_ORDER_NULLIFIER = `0x${"00".repeat(31)}06` as Hex;

export interface PrivateMerkleWitness {
  root: Hex;
  path: Hex[];
  index: number;
}

export interface PrivateOrderProofRequest {
  collateralAsset: Hex;
  positionAsset: Hex;
  deposit: bigint;
  limitPrice: bigint;
  noteSecret: Hex;
  merkle: PrivateMerkleWitness;
  refundPublicKey: Hex;
  positionPublicKey: Hex;
  orderSecret: Hex;
}

export interface PrivateWithdrawalProofRequest {
  asset: Hex;
  amount: bigint;
  noteSecret: Hex;
  merkle: PrivateMerkleWitness;
  recipient: Address;
}

export interface BrowserProof {
  proof: Hex;
  publicInputs: Hex[];
}

export interface PrivateCancellationProofRequest {
  collateralAsset: Hex;
  positionAsset: Hex;
  deposit: bigint;
  limitPrice: bigint;
  orderSecret: Hex;
  refundPublicKey: Hex;
  positionPublicKey: Hex;
  merkle: PrivateMerkleWitness;
}

function assertBytes32(value: Hex, label: string): void {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error(`${label} must be bytes32`);
}

function assertU64(value: bigint, label: string): void {
  if (value <= 0n || value > MAX_U64) throw new Error(`${label} must fit a positive u64`);
}

function bytes(value: Hex): number[] {
  assertBytes32(value, "Circuit value");
  return Array.from({ length: 32 }, (_, index) => Number.parseInt(value.slice(2 + index * 2, 4 + index * 2), 16));
}

function halves(value: Hex): [bigint, bigint] {
  assertBytes32(value, "Split value");
  const word = BigInt(value);
  return [word >> 128n, word & LOW_128];
}

function fieldWord(value: bigint): Hex {
  return `0x${value.toString(16).padStart(64, "0")}` as Hex;
}

function proofHex(value: Uint8Array): Hex {
  return `0x${Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("")}` as Hex;
}

export function privateNoteCommitment(asset: Hex, amount: bigint, publicKey: Hex): Hex {
  return keccak256(encodeAbiParameters(
    [{ type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "bytes32" }],
    [DOMAIN_NOTE, asset, amount, publicKey],
  ));
}

export function privateOrderCommitment(request: Pick<PrivateCancellationProofRequest,
  "positionAsset" | "deposit" | "limitPrice" | "refundPublicKey" | "positionPublicKey" | "orderSecret">): Hex {
  return keccak256(encodeAbiParameters(
    [
      { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" },
      { type: "uint256" }, { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" },
    ],
    [DOMAIN_ORDER, request.positionAsset, request.deposit, request.limitPrice,
      request.refundPublicKey, request.positionPublicKey, keccak256(request.orderSecret)],
  ));
}

function noteNullifier(commitment: Hex, secret: Hex): Hex {
  return keccak256(encodeAbiParameters(
    [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }],
    [DOMAIN_NULLIFIER, commitment, secret],
  ));
}

function merkleRoot(leaf: Hex, witness: PrivateMerkleWitness): Hex {
  if (!Number.isInteger(witness.index) || witness.index < 0 || witness.index >= 1_048_576 || witness.path.length !== 20) {
    throw new Error("Private note requires a 20-level Merkle witness");
  }
  let current = leaf;
  for (let level = 0; level < 20; level += 1) {
    const sibling = witness.path[level];
    assertBytes32(sibling, `Merkle sibling ${level}`);
    current = (witness.index >> level) & 1
      ? keccak256(encodePacked(["bytes32", "bytes32"], [sibling, current]))
      : keccak256(encodePacked(["bytes32", "bytes32"], [current, sibling]));
  }
  if (current.toLowerCase() !== witness.root.toLowerCase()) throw new Error("Private note Merkle path is stale or invalid");
  return current;
}

async function generateProof(circuit: unknown, inputs: InputMap, expected: Hex[]): Promise<BrowserProof> {
  if (typeof window === "undefined") throw new Error("Private proofs must be generated in the browser");
  const [{ Noir }, { Barretenberg, BackendType, UltraHonkBackend }] = await Promise.all([
    import("@noir-lang/noir_js"),
    import("@aztec/bb.js"),
  ]);
  const api = await Barretenberg.new({ backend: BackendType.Wasm });
  try {
    const noir = new Noir(circuit as ConstructorParameters<typeof Noir>[0]);
    const { witness } = await noir.execute(inputs);
    const backend = new UltraHonkBackend((circuit as { bytecode: string }).bytecode, api);
    const result = await backend.generateProof(witness, { verifierTarget: "evm" });
    const publicInputs = result.publicInputs.map((input) =>
      (input.startsWith("0x") ? input : `0x${input.padStart(64, "0")}`) as Hex);
    if (publicInputs.length !== expected.length ||
        publicInputs.some((input, index) => input.toLowerCase() !== expected[index].toLowerCase())) {
      throw new Error("Browser proof public inputs do not match the pool transaction");
    }
    return { proof: proofHex(result.proof), publicInputs };
  } finally {
    await api.destroy();
  }
}

export async function provePrivateBuyOrder(request: PrivateOrderProofRequest): Promise<BrowserProof & {
  root: Hex;
  nullifier: Hex;
  orderCommitment: Hex;
}> {
  assertU64(request.deposit, "Deposit");
  if (request.limitPrice <= 0n || request.limitPrice >= 1_000_000n || request.limitPrice > MAX_U64) {
    throw new Error("Limit price must be between 1 and 999999");
  }
  [request.collateralAsset, request.positionAsset, request.noteSecret, request.refundPublicKey,
    request.positionPublicKey, request.orderSecret].forEach((value, index) => assertBytes32(value, `Order value ${index}`));
  const publicKey = keccak256(request.noteSecret);
  const inputNote = privateNoteCommitment(request.collateralAsset, request.deposit, publicKey);
  const root = merkleRoot(inputNote, request.merkle);
  const nullifier = noteNullifier(inputNote, request.noteSecret);
  const orderCommitment = privateOrderCommitment(request);
  const expected = [root, nullifier, request.collateralAsset, orderCommitment]
    .flatMap((value) => halves(value).map(fieldWord));
  const proof = await generateProof(orderCircuit, {
    collateral_asset: bytes(request.collateralAsset),
    position_asset: bytes(request.positionAsset),
    deposit: request.deposit.toString(),
    limit_price: request.limitPrice.toString(),
    note_secret: bytes(request.noteSecret),
    path: request.merkle.path.map(bytes),
    index: request.merkle.index.toString(),
    refund_public_key: bytes(request.refundPublicKey),
    position_public_key: bytes(request.positionPublicKey),
    order_secret: bytes(request.orderSecret),
    root_high: halves(root)[0].toString(), root_low: halves(root)[1].toString(),
    note_nullifier_high: halves(nullifier)[0].toString(), note_nullifier_low: halves(nullifier)[1].toString(),
    collateral_high: halves(request.collateralAsset)[0].toString(),
    collateral_low: halves(request.collateralAsset)[1].toString(),
    order_high: halves(orderCommitment)[0].toString(), order_low: halves(orderCommitment)[1].toString(),
  }, expected);
  return { ...proof, root, nullifier, orderCommitment };
}

export async function provePrivateWithdrawal(request: PrivateWithdrawalProofRequest): Promise<BrowserProof & {
  root: Hex;
  nullifier: Hex;
}> {
  assertU64(request.amount, "Withdrawal amount");
  assertBytes32(request.asset, "Withdrawal asset");
  assertBytes32(request.noteSecret, "Note secret");
  const recipient = getAddress(request.recipient);
  const commitment = privateNoteCommitment(request.asset, request.amount, keccak256(request.noteSecret));
  const root = merkleRoot(commitment, request.merkle);
  const nullifier = noteNullifier(commitment, request.noteSecret);
  const binding = keccak256(encodeAbiParameters(
    [
      { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" },
      { type: "uint256" }, { type: "address" },
    ],
    [DOMAIN_WITHDRAW, root, nullifier, request.asset, request.amount, recipient],
  ));
  const recipientWord = BigInt(recipient);
  const expected = [
    ...halves(root).map(fieldWord), ...halves(nullifier).map(fieldWord), ...halves(request.asset).map(fieldWord),
    fieldWord(request.amount), ...halves(binding).map(fieldWord),
  ];
  const proof = await generateProof(withdrawCircuit, {
    asset: bytes(request.asset),
    secret: bytes(request.noteSecret),
    path: request.merkle.path.map(bytes),
    index: request.merkle.index.toString(),
    recipient_high: (recipientWord >> 128n).toString(),
    recipient_low: (recipientWord & LOW_128).toString(),
    root_high: halves(root)[0].toString(), root_low: halves(root)[1].toString(),
    nullifier_high: halves(nullifier)[0].toString(), nullifier_low: halves(nullifier)[1].toString(),
    asset_high: halves(request.asset)[0].toString(), asset_low: halves(request.asset)[1].toString(),
    amount: request.amount.toString(),
    binding_high: halves(binding)[0].toString(), binding_low: halves(binding)[1].toString(),
  }, expected);
  return { ...proof, root, nullifier };
}

export async function provePrivateOrderCancellation(request: PrivateCancellationProofRequest): Promise<BrowserProof & {
  orderCommitment: Hex;
  orderNullifier: Hex;
  refundCommitment: Hex;
}> {
  assertU64(request.deposit, "Cancellation deposit");
  if (request.limitPrice <= 0n || request.limitPrice >= 1_000_000n) throw new Error("Invalid cancellation limit");
  const orderCommitment = privateOrderCommitment(request);
  const root = merkleRoot(orderCommitment, request.merkle);
  const orderNullifier = keccak256(encodeAbiParameters(
    [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }],
    [DOMAIN_ORDER_NULLIFIER, orderCommitment, request.orderSecret],
  ));
  const refundCommitment = privateNoteCommitment(request.collateralAsset, request.deposit, request.refundPublicKey);
  const [rootHigh, rootLow] = halves(root);
  const [nullifierHigh, nullifierLow] = halves(orderNullifier);
  const [collateralHigh, collateralLow] = halves(request.collateralAsset);
  const [refundHigh, refundLow] = halves(refundCommitment);
  const expected = [
    fieldWord(rootHigh), fieldWord(rootLow), fieldWord(nullifierHigh), fieldWord(nullifierLow),
    fieldWord(collateralHigh), fieldWord(collateralLow), fieldWord(refundHigh), fieldWord(refundLow),
    fieldWord(request.deposit),
  ];
  const proof = await generateProof(cancelCircuit, {
    position_asset: bytes(request.positionAsset),
    deposit: request.deposit.toString(),
    limit_price: request.limitPrice.toString(),
    refund_public_key: bytes(request.refundPublicKey),
    position_public_key: bytes(request.positionPublicKey),
    order_secret: bytes(request.orderSecret),
    path: request.merkle.path.map(bytes),
    index: request.merkle.index.toString(),
    root_high: rootHigh.toString(), root_low: rootLow.toString(),
    order_nullifier_high: nullifierHigh.toString(), order_nullifier_low: nullifierLow.toString(),
    collateral_high: collateralHigh.toString(), collateral_low: collateralLow.toString(),
    refund_high: refundHigh.toString(), refund_low: refundLow.toString(),
    total_deposit: request.deposit.toString(),
    collateral_asset: bytes(request.collateralAsset),
  }, expected);
  return { ...proof, orderCommitment, orderNullifier, refundCommitment };
}
