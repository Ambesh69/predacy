/**
 * Check if deployed ClaimHonkVerifier has the expected VK_HASH in its bytecode.
 * Run: node_modules/.bin/tsx scripts/checkVK.ts
 */
import { createPublicClient, http } from "viem";
import { polygon } from "viem/chains";

const CLAIM_VERIFIER = "0xa555AAb4E1BE1a002EDe3150818650B3fE2164A1" as `0x${string}`;
const RPC_URL = process.env.RPC_URL ?? "https://polygon-rpc.com";

const client = createPublicClient({
  chain: polygon,
  transport: http(RPC_URL),
});

async function main() {
  const bytecode = await client.getBytecode({ address: CLAIM_VERIFIER });
  if (!bytecode) { console.log("No bytecode — contract not deployed?"); return; }
  console.log("Bytecode length:", (bytecode.length - 2) / 2, "bytes");

  const expected = "303ee1bacab6ee5e29fa9819707085112fceda2609c5b87015695bfd613ef95a";
  const found = bytecode.toLowerCase().includes(expected.toLowerCase());
  console.log(`Expected VK_HASH found in bytecode: ${found ? "YES ✓" : "NO ✗"}`);

  // Also check NUMBER_OF_PUBLIC_INPUTS (27 = 0x1b)
  const nPubInputs27 = "000000000000000000000000000000000000000000000000000000000000001b";
  const found27 = bytecode.toLowerCase().includes(nPubInputs27);
  console.log(`NUMBER_OF_PUBLIC_INPUTS=27 pattern found: ${found27 ? "YES ✓" : "NO ✗"}`);
}

main().catch(console.error);
