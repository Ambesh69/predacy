import { createRequire } from "node:module";
import { encodeAbiParameters, keccak256, type Hex } from "viem";

const require = createRequire(import.meta.url);
const MAX_U64 = (1n << 64n) - 1n;

export interface V11AllocationWitness {
  marketId: Hex;
  commitment: Hex;
  side: 0 | 1 | 2 | 3;
  deposit: bigint;
  limitPrice: bigint;
  salt: Hex;
  filledShares: bigint;
  usdcSettled: bigint;
  refund: bigint;
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
  if (value < 0n || value > MAX_U64) throw new Error("V11 proof input exceeds u64 range");
  return value.toString();
}

export function buildV11AllocationInputs(order: V11AllocationWitness) {
  if (order.side < 0 || order.side > 3 || order.deposit <= 0n ||
      order.limitPrice <= 0n || order.limitPrice >= 1_000_000n) {
    throw new Error("Invalid v11 allocation witness");
  }
  const commitment = keccak256(encodeAbiParameters(
    [{ type: "bytes32" }, { type: "uint8" }, { type: "uint256" }, { type: "uint256" }, { type: "bytes32" }],
    [order.marketId, order.side, order.deposit, order.limitPrice, order.salt],
  ));
  if (commitment.toLowerCase() !== order.commitment.toLowerCase()) {
    throw new Error("V11 allocation witness does not match escrowed commitment");
  }
  const [marketHi, marketLo] = halves(order.marketId);
  const [commitmentHi, commitmentLo] = halves(order.commitment);
  return {
    market_id: bytes32(order.marketId),
    limit_price: u64(order.limitPrice),
    salt: bytes32(order.salt),
    market_hi: marketHi,
    market_lo: marketLo,
    commitment_hi: commitmentHi,
    commitment_lo: commitmentLo,
    side: String(order.side),
    deposit: u64(order.deposit),
    filled_shares: u64(order.filledShares),
    usdc_settled: u64(order.usdcSettled),
    refund: u64(order.refund),
  };
}

/** No mock-proof path: a failed native prover leaves the batch unfinalized. */
export async function proveV11Allocation(order: V11AllocationWitness): Promise<{
  proof: Hex;
  publicInputs: Hex[];
}> {
  const inputs = buildV11AllocationInputs(order);
  const { Noir } = await import("@noir-lang/noir_js");
  const { Barretenberg, UltraHonkBackend } = await import("@aztec/bb.js");
  const circuit = require("../circuits/allocation_v11.json") as ConstructorParameters<typeof Noir>[0];
  const api = await Barretenberg.new(process.env.BB_PATH ? { bbPath: process.env.BB_PATH } : {});
  try {
    const noir = new Noir(circuit);
    const { witness } = await noir.execute(inputs);
    const backend = new UltraHonkBackend(circuit.bytecode, api);
    const result = await backend.generateProof(witness, { verifierTarget: "evm" });
    return {
      proof: `0x${Buffer.from(result.proof).toString("hex")}`,
      publicInputs: result.publicInputs.map((input) =>
        (input.startsWith("0x") ? input : `0x${input.padStart(64, "0")}`) as Hex),
    };
  } finally {
    await api.destroy();
  }
}
