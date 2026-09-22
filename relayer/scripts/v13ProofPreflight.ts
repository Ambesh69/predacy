import "dotenv/config";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createPublicClient, getAddress, http, parseAbi, type Hex } from "viem";
import { polygon } from "viem/chains";
import { proveV13Cancel, proveV13OrderLock, proveV13Route, proveV13Settlement } from "../src/v13Proofs.js";
import { v13Fixture, v13LockFixture } from "./lib/v13Fixture.js";

async function main() {
  if (!process.argv[2]) {
    // Release the native prover's memory between the four expensive circuit checks.
    for (const kind of ["order", "route", "settlement", "cancel"]) {
      const code = await new Promise<number | null>((resolve, reject) => {
        const child = spawn(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), kind],
          { env: process.env, stdio: "inherit" });
        child.on("error", reject);
        child.on("exit", resolve);
      });
      if (code !== 0) throw new Error(`V13 ${kind} proof check failed (${code})`);
    }
    return;
  }
  if (!["order", "route", "settlement", "cancel"].includes(process.argv[2])) throw new Error("Unknown proof kind");
  if (!process.env.RPC_URL) throw new Error("RPC_URL is required");
  const reader = createPublicClient({ chain: polygon, transport: http(process.env.RPC_URL, { timeout: 60_000 }) });
  if (await reader.getChainId() !== polygon.id) throw new Error("Proof check requires Polygon mainnet");
  const request = v13Fixture("v13 deployed verifier preflight");
  const cases = [
    ["order", () => proveV13OrderLock(v13LockFixture(request))],
    ["route", () => proveV13Route(request.witness)],
    ["settlement", () => proveV13Settlement(request.witness,
      [{ spent: 330_000n, shares: 600_000n }, { spent: 220_000n, shares: 400_000n }])],
    ["cancel", () => proveV13Cancel(request.witness.collateralAsset, request.witness.orders[0])],
  ] as const;
  const abi = parseAbi(["function verify(bytes,bytes32[]) view returns(bool)"]);
  for (const [kind, prove] of cases) {
    if (kind !== process.argv[2]) continue;
    const variable = `V13_${kind.toUpperCase()}_VERIFIER`;
    const configured = process.env[variable];
    if (!configured) throw new Error(`${variable} is required`);
    const address = getAddress(configured);
    console.log(`Checking deployed v13 ${kind} verifier`);
    const result = await prove();
    const valid = await reader.readContract({ address, abi, functionName: "verify",
      args: [result.proof, result.publicInputs] });
    if (!valid) throw new Error(`Deployed v13 ${kind} verifier rejected a fresh proof`);
    const changed = [...result.publicInputs];
    changed[0] = `0x${(BigInt(changed[0]) ^ 1n).toString(16).padStart(64, "0")}` as Hex;
    let rejected = false;
    try {
      rejected = !await reader.readContract({ address, abi, functionName: "verify", args: [result.proof, changed] });
    } catch (error) {
      // Transport failures must not count as a negative verification result.
      const { BaseError, ContractFunctionRevertedError } = await import("viem");
      if (error instanceof BaseError && error.walk((cause) => cause instanceof ContractFunctionRevertedError)
          instanceof ContractFunctionRevertedError) rejected = true;
      else throw error;
    }
    if (!rejected) throw new Error(`Deployed v13 ${kind} verifier accepted altered public inputs`);
    console.log(JSON.stringify({ verifier: kind, address, freshProof: "pass", alteredInput: "rejected" }));
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "V13 proof preflight failed");
  process.exitCode = 1;
});
