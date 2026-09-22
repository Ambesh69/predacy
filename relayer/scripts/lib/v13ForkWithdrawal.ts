import { createRequire } from "node:module";
import { encodeAbiParameters, keccak256, toHex, type Address, type Hex } from "viem";
import { v13NoteCommitment, v13Nullifier, type V13MerkleWitness } from "../../src/v13Proofs.js";

// Local fork tooling only. User withdrawal secrets never belong in the production relayer.
export async function proveForkWithdrawal(asset: Hex, amount: bigint, secret: Hex,
  merkle: V13MerkleWitness, recipient: Address) {
  const circuit = createRequire(import.meta.url)("../../../circuits/shielded_withdraw_v1/target/shielded_withdraw_v1.json");
  const { Noir } = await import("@noir-lang/noir_js");
  const { Barretenberg, UltraHonkBackend } = await import("@aztec/bb.js");
  const halves = (value: Hex) => [BigInt(value) >> 128n, BigInt(value) & ((1n << 128n) - 1n)] as const;
  const bytes = (value: Hex) => Array.from(Buffer.from(value.slice(2), "hex"));
  const nullifier = v13Nullifier(v13NoteCommitment(asset, amount, keccak256(secret)), secret, 2);
  const binding = keccak256(encodeAbiParameters([
    { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" },
    { type: "uint256" }, { type: "address" },
  ], [toHex(3n, { size: 32 }), merkle.root, nullifier, asset, amount, recipient]));
  const [rootHigh, rootLow] = halves(merkle.root);
  const [nullifierHigh, nullifierLow] = halves(nullifier);
  const [assetHigh, assetLow] = halves(asset);
  const [bindingHigh, bindingLow] = halves(binding);
  const [recipientHigh, recipientLow] = halves(recipient);
  const api = await Barretenberg.new({});
  try {
    await api.initSRSChonk(2 ** 20);
    const { witness } = await new Noir(circuit).execute({ asset: bytes(asset), secret: bytes(secret),
      path: merkle.path.map(bytes), index: merkle.index.toString(), amount: amount.toString(),
      recipient_high: recipientHigh.toString(), recipient_low: recipientLow.toString(),
      root_high: rootHigh.toString(), root_low: rootLow.toString(),
      nullifier_high: nullifierHigh.toString(), nullifier_low: nullifierLow.toString(),
      asset_high: assetHigh.toString(), asset_low: assetLow.toString(),
      binding_high: bindingHigh.toString(), binding_low: bindingLow.toString() });
    const result = await new UltraHonkBackend(circuit.bytecode, api).generateProof(witness, { verifierTarget: "evm" });
    const expected = [rootHigh, rootLow, nullifierHigh, nullifierLow, assetHigh, assetLow, amount, bindingHigh, bindingLow];
    if (result.publicInputs.length !== expected.length || result.publicInputs.some((input, i) => BigInt(input) !== expected[i])) {
      throw new Error("Fork withdrawal public inputs mismatch");
    }
    return { proof: toHex(result.proof), root: merkle.root, nullifier };
  } finally { await api.destroy(); }
}
