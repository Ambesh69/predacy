import { encodeAbiParameters } from "viem";
import { proveV12BuyBatch, type V12BuyBatchWitness } from "../src/v12BuyBatchProver.js";

const hex = (byte: string) => `0x${byte.repeat(64)}` as const;
const witness: V12BuyBatchWitness = {
  collateralAsset: hex("1"),
  positionAsset: hex("2"),
  orders: [{
    inputNote: hex("3"), deposit: 600_000n, limitPrice: 600_000n, salt: hex("4"),
    refundPublicKey: hex("5"), positionPublicKey: hex("6"),
  }],
  fills: [{ spent: 550_000n, shares: 1_000_000n }],
};

const originalLog = console.log;
console.log = () => {};
const result = await proveV12BuyBatch(witness);
console.log = originalLog;
process.stdout.write(encodeAbiParameters(
  [{ type: "bytes" }, { type: "bytes32[]" }],
  [result.proof, result.publicInputs],
));
