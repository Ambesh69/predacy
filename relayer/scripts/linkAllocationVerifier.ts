import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { encodeAbiParameters, getAddress } from "viem";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const artifactPath = path.resolve(dirname, "../../contracts/v11-verifier/out/Verifier.sol/HonkVerifier.json");
const artifact = JSON.parse(readFileSync(artifactPath, "utf8")) as {
  bytecode: {
    object: string;
    linkReferences: Record<string, Record<string, Array<{ start: number; length: number }>>>;
  };
};
const address = getAddress(process.argv[2] ?? "");
const references = Object.values(artifact.bytecode.linkReferences).flatMap(
  (libraries) => Object.entries(libraries).flatMap(([name, locations]) => {
    if (name !== "ZKTranscriptLib") throw new Error(`Unexpected verifier library: ${name}`);
    return locations;
  }),
);
if (references.length !== 1 || references[0].length !== 20) {
  throw new Error("Unexpected verifier link references");
}
let bytecode = artifact.bytecode.object;
if (!bytecode.startsWith("0x")) throw new Error("Verifier bytecode is not hex-prefixed");
for (const reference of references) {
  const start = 2 + reference.start * 2;
  bytecode = `${bytecode.slice(0, start)}${address.slice(2).toLowerCase()}${bytecode.slice(start + 40)}`;
}
if (!/^0x[0-9a-fA-F]+$/.test(bytecode)) throw new Error("Verifier bytecode remains unlinked");
process.stdout.write(encodeAbiParameters([{ type: "bytes" }], [bytecode as `0x${string}`]));
