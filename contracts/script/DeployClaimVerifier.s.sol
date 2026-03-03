// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "../src/ClaimVerifier.sol";

/// @notice Deploy ClaimHonkVerifier in isolation.
///
/// ClaimVerifier.sol and BatchVerifier.sol define identical top-level library names
/// (ZKTranscriptLib, RelationsLib, CommitmentSchemeLib, Honk, FrLib, HonkVerificationKey)
/// so they cannot be imported in the same Solidity file. This script imports only
/// ClaimVerifier.sol, letting Forge auto-deploy and link its libraries.
///
/// Run this BEFORE the main deploy/upgrade script, then set CLAIM_VERIFIER=<address>.
///
/// Usage:
///   cd contracts
///   FOUNDRY_PROFILE=size forge script script/DeployClaimVerifier.s.sol \
///     --rpc-url $POLYGON_AMOY_RPC \
///     --broadcast \
///     --private-key $PRIVATE_KEY
///
///   # Copy the printed CLAIM_VERIFIER address, then run UpgradeVerifierAmoy / DeployMainnet.
contract DeployClaimVerifier is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(deployerKey);

        ClaimHonkVerifier verifier = new ClaimHonkVerifier();

        vm.stopBroadcast();

        console.log("ClaimHonkVerifier:", address(verifier));
        console.log("");
        console.log("Set in env before running the main script:");
        console.log("CLAIM_VERIFIER=", address(verifier));
    }
}
