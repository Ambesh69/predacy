// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "../src/BatchVerifier.sol";
import "../src/BatchVault.sol";

/// @notice Deploy the real HonkVerifier and swap it into the existing BatchVault.
///
/// Keeps the existing vault address intact — no need to re-mint USDC or
/// update VAULT_ADDRESS in Railway/frontend.
///
/// Prerequisites:
///   - PRIVATE_KEY in contracts/.env must be the relayer wallet (setVerifier
///     is onlyRelayer)
///   - Deployer needs ~0.05 MATIC on Amoy for gas
///
/// Usage:
///   cd contracts
///   FOUNDRY_PROFILE=size forge script script/UpgradeVerifierAmoy.s.sol \
///     --rpc-url https://rpc-amoy.polygon.technology/ \
///     --broadcast \
///     --private-key $PRIVATE_KEY
///
/// After deployment:
///   Set USE_REAL_ZK=true in Railway env vars to enable real proof generation.
contract UpgradeVerifierAmoy is Script {
    address constant VAULT = 0x704314474E34C01F99b98e5A4C956B7748e34e44;

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");

        vm.startBroadcast(deployerKey);

        // Deploy real HonkVerifier (forge auto-links ZKTranscriptLib,
        // RelationsLib, CommitmentSchemeLib as separate contracts).
        HonkVerifier verifier = new HonkVerifier();
        console.log("HonkVerifier:  ", address(verifier));

        // Swap the verifier in the existing vault (onlyRelayer).
        BatchVault(VAULT).setVerifier(address(verifier));
        console.log("setVerifier() done on vault:", VAULT);

        vm.stopBroadcast();

        console.log("\n=== Next step ===");
        console.log("Set USE_REAL_ZK=true in Railway env vars");
    }
}
