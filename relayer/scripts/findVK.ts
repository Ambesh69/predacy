/**
 * Find the actual VK_HASH in the deployed ClaimHonkVerifier bytecode.
 */
import { createPublicClient, http } from "viem";
import { polygon } from "viem/chains";

const CLAIM_VERIFIER = "0xa555AAb4E1BE1a002EDe3150818650B3fE2164A1" as `0x${string}`;
const RPC_URL = process.env.RPC_URL!;

const client = createPublicClient({ chain: polygon, transport: http(RPC_URL) });

async function main() {
  const bytecode = await client.getBytecode({ address: CLAIM_VERIFIER });
  if (!bytecode) { console.log("No bytecode!"); return; }

  const hex = bytecode.slice(2).toLowerCase();
  console.log("Bytecode length:", hex.length / 2, "bytes");

  // The VK_HASH is used in a comparison. It appears as a 32-byte (64 hex char) value
  // loaded by PUSH32. Look for PUSH32 (0x7f) followed by 32 bytes.
  // Also, VK_HASH is typically compared with CALLDATALOAD or MLOAD in the verify function.

  // Let's find all PUSH32 opcodes and print the values that follow them
  const push32Values: string[] = [];
  for (let i = 0; i < hex.length - 64; i += 2) {
    if (hex[i] === '7' && hex[i+1] === 'f') { // PUSH32 = 0x7f
      const val = hex.slice(i + 2, i + 2 + 64);
      // Filter: must be non-zero and look like a hash (high entropy)
      if (val !== '0'.repeat(64) && val !== 'f'.repeat(64)) {
        push32Values.push(val);
      }
      i += 64; // skip the 32 bytes
    }
  }

  console.log(`Found ${push32Values.length} PUSH32 values. Showing all unique hashes:`);
  const unique = [...new Set(push32Values)];
  unique.forEach((v, i) => console.log(`  [${i}] 0x${v}`));

  // The VK_HASH should be the first one that matches the HonkVerificationKey struct
  // It's typically the first constant used in the verification
}

main().catch(console.error);
