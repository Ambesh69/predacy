import { Noir } from "@noir-lang/noir_js";
import { Barretenberg, UltraHonkBackend } from "@aztec/bb.js";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { encodeAbiParameters, keccak256 } from "viem";

const require = createRequire(import.meta.url);
const dirname = path.dirname(fileURLToPath(import.meta.url));

function bytes(hex: `0x${string}`): number[] {
  return Array.from(Buffer.from(hex.slice(2), "hex"));
}

function halves(hex: `0x${string}`): [string, string] {
  return [BigInt(`0x${hex.slice(2, 34)}`).toString(), BigInt(`0x${hex.slice(34)}`).toString()];
}

async function main(): Promise<void> {
  console.log = (...args: unknown[]) => process.stderr.write(args.map(String).join(" ") + "\n");
  const circuitPath = path.resolve(dirname, "../../circuits/allocation_v11/target/allocation_v11.json");
  const circuit = require(circuitPath) as { bytecode: string };
  const market = `0x${"01".repeat(32)}` as const;
  const salt = `0x${"02".repeat(32)}` as const;
  const deposit = 410_000n;
  const limit = 420_000n;
  const commitment = keccak256(encodeAbiParameters(
    [{ type: "bytes32" }, { type: "uint8" }, { type: "uint256" }, { type: "uint256" }, { type: "bytes32" }],
    [market, 2, deposit, limit, salt],
  ));
  const [marketHi, marketLo] = halves(market);
  const [commitmentHi, commitmentLo] = halves(commitment);
  const inputs = {
    market_id: bytes(market),
    limit_price: limit.toString(),
    salt: bytes(salt),
    market_hi: marketHi,
    market_lo: marketLo,
    commitment_hi: commitmentHi,
    commitment_lo: commitmentLo,
    side: "2",
    deposit: deposit.toString(),
    filled_shares: "1000000",
    usdc_settled: "405000",
    refund: "5000",
  };

  const api = await Barretenberg.new({ bbPath: process.env.BB_PATH ?? `${process.env.HOME}/.bb/bb` });
  try {
    const noir = new Noir(circuit);
    const backend = new UltraHonkBackend(circuit.bytecode, api);
    const initial = await noir.execute({
      ...inputs,
      filled_shares: "0",
      usdc_settled: "0",
      refund: deposit.toString(),
    });
    const initialResult = await backend.generateProof(initial.witness, { verifierTarget: "evm" });
    const final = await noir.execute(inputs);
    const finalResult = await backend.generateProof(final.witness, { verifierTarget: "evm" });
    const encodeResult = (result: typeof finalResult) => ({
      proof: `0x${Buffer.from(result.proof).toString("hex")}` as `0x${string}`,
      publicInputs: result.publicInputs.map((input) =>
        (input.startsWith("0x") ? input : `0x${input.padStart(64, "0")}`) as `0x${string}`,
      ),
    });
    const initialProof = encodeResult(initialResult);
    const finalProof = encodeResult(finalResult);
    process.stderr.write(`[allocation_v11] initial=${initialResult.proof.length} bytes, final=${finalResult.proof.length} bytes\n`);
    process.stdout.write(encodeAbiParameters(
      [{ type: "bytes" }, { type: "bytes32[]" }, { type: "bytes" }, { type: "bytes32[]" }],
      [initialProof.proof, initialProof.publicInputs, finalProof.proof, finalProof.publicInputs],
    ));
  } finally {
    await api.destroy();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`[allocation_v11] ${error}\n`);
  process.exitCode = 1;
});
