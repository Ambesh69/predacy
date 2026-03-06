// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "../src/BatchVault.sol";

/// @notice Wire up the already-deployed real ZK verifiers to BatchVault v6 on Amoy.
///
/// All three contracts are already live — this script just calls setVerifier + setClaimVerifier.
/// No new deployments. Both functions are onlyRelayer, so PRIVATE_KEY must be the relayer wallet.
///
/// Deployed addresses (Amoy):
///   BatchVault v6:        0xE51dEB3a32d19fB5b9F9B7f1683F51363fdde98B
///   HonkVerifier (batch): 0xcb7a99c35E3e5F55e1F58205d867E881eD198111
///   PublicInputAdapter:   0xBc84e220129BCe680ebf38bCdBa78afba96D08bc
///   ClaimHonkVerifier:    0xF5384A8035a894Ab4151Ff557bA57533937F9ba3
///
/// Usage:
///   cd contracts
///   forge script script/ActivateZKAmoy.s.sol \
///     --rpc-url $POLYGON_AMOY_RPC --broadcast --private-key $PRIVATE_KEY
///
/// After running:
///   Set ADAPTER_ADDRESS=0xBc84e220129BCe680ebf38bCdBa78afba96D08bc in Railway.
///   USE_REAL_ZK=true should already be set.
contract ActivateZKAmoy is Script {
    // BatchVault v6 on Polygon Amoy
    address constant VAULT = 0xE51dEB3a32d19fB5b9F9B7f1683F51363fdde98B;

    // PublicInputAdapter — bridges BatchVault 6 public inputs → HonkVerifier 37 inputs.
    // Relayer must call adapter.setPendingOrderCount(n) before each settleBatch()
    // (triggered automatically when ADAPTER_ADDRESS env var is set on Railway).
    address constant ADAPTER = 0xBc84e220129BCe680ebf38bCdBa78afba96D08bc;

    // ClaimHonkVerifier — UltraHonk verifier for the claim circuit (11 public inputs).
    // No adapter needed: BatchVault passes inputs directly.
    address constant CLAIM_HONK = 0xF5384A8035a894Ab4151Ff557bA57533937F9ba3;

    function run() external {
        vm.startBroadcast(vm.envUint("PRIVATE_KEY"));

        BatchVault(VAULT).setVerifier(ADAPTER);
        console.log("setVerifier -> PublicInputAdapter:", ADAPTER);

        BatchVault(VAULT).setClaimVerifier(CLAIM_HONK);
        console.log("setClaimVerifier -> ClaimHonkVerifier:", CLAIM_HONK);

        vm.stopBroadcast();

        console.log("\n=== Done - BatchVault v6 is now using real ZK verifiers ===");
        console.log("Set in Railway:");
        console.log("  ADAPTER_ADDRESS =", ADAPTER);
        console.log("  USE_REAL_ZK     = true (already set)");
    }
}
