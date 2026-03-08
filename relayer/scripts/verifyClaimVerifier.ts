/**
 * Verify the deployed ClaimHonkVerifier is correctly wired into the v10 vault.
 */
import { createPublicClient, http } from "viem";
import { polygon } from "viem/chains";

const VAULT_V10        = "0x8fD2B227E98F401F55B4252d34905C96eEEAEA1a" as `0x${string}`;
const NEW_CLAIM_VER    = "0xf5Fda423f9f50708e6F55AaDA464239D7232dE2a";
const RPC_URL          = process.env.RPC_URL!;

const client = createPublicClient({ chain: polygon, transport: http(RPC_URL) });

async function main() {
  // Read claimVerifier from vault storage slot (or via ABI call)
  const result = await client.readContract({
    address: VAULT_V10,
    abi: [{
      name: "claimVerifier",
      type: "function",
      inputs: [],
      outputs: [{ type: "address" }],
      stateMutability: "view",
    }],
    functionName: "claimVerifier",
  });

  console.log(`Vault v10 claimVerifier: ${result}`);
  const ok = result.toLowerCase() === NEW_CLAIM_VER.toLowerCase();
  console.log(`Expected:                ${NEW_CLAIM_VER}`);
  console.log(`Match: ${ok ? "YES ✓" : "NO ✗ — setClaimVerifier not applied yet"}`);

  // Also check VK_HASH in new verifier bytecode
  const bytecode = await client.getBytecode({ address: NEW_CLAIM_VER as `0x${string}` });
  const vkHash = "303ee1bacab6ee5e29fa9819707085112fceda2609c5b87015695bfd613ef95a";
  const found = bytecode?.toLowerCase().includes(vkHash);
  console.log(`\nNew verifier VK_HASH (303ee1...) in bytecode: ${found ? "YES ✓" : "NO ✗"}`);
}

main().catch(console.error);
