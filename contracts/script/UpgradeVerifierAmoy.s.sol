// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "../src/BatchVerifier.sol";
import "../src/PublicInputAdapter.sol";
import "../src/BatchVault.sol";
// Note: ClaimVerifier.sol not imported — naming conflict with BatchVerifier.sol.
// Deployed via vm.deployCode() instead.

/// @notice Upgrade the existing Amoy BatchVault to use real ZK verifiers.
///
/// Keeps the existing vault address intact — no need to re-mint USDC or
/// update VAULT_ADDRESS in Railway/frontend.
///
/// Deploys:
///   - HonkVerifier (batch clearing, 37 public inputs)
///   - PublicInputAdapter (bridges BatchVault 6 inputs → HonkVerifier 37 inputs)
///   - ClaimHonkVerifier (claim proofs, 11 public inputs, no adapter needed)
///
/// Then swaps both verifiers on the vault via setVerifier / setClaimVerifier.
///
/// Prerequisites:
///   - PRIVATE_KEY in contracts/.env must be the relayer wallet
///     (setVerifier and setClaimVerifier are onlyRelayer)
///   - Deployer needs ~0.1 MATIC on Amoy for gas
///
/// Usage:
///   cd contracts
///   FOUNDRY_PROFILE=size forge script script/UpgradeVerifierAmoy.s.sol \
///     --rpc-url https://rpc-amoy.polygon.technology/ \
///     --broadcast \
///     --private-key $PRIVATE_KEY
///
/// After deployment:
///   Set USE_REAL_ZK=true and ADAPTER_ADDRESS=<printed> in Railway env vars.
contract UpgradeVerifierAmoy is Script {
    // BatchVault v4 on Polygon Amoy
    address constant VAULT = 0x2A3fa469D3F80ca64624B22EFed72a5FC89E6759;

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address deployer    = vm.addr(deployerKey);

        vm.startBroadcast(deployerKey);

        // 1. Batch clearing ZK verifier
        //    Forge auto-links ZKTranscriptLib, RelationsLib, CommitmentSchemeLib.
        HonkVerifier batchVerifier = new HonkVerifier();
        console.log("HonkVerifier (batch):     ", address(batchVerifier));

        // 2. PublicInputAdapter — expands 6 inputs from settleBatch() to 37 for HonkVerifier.
        //    Relayer must call adapter.setPendingOrderCount(n) before each settleBatch().
        PublicInputAdapter adapter = new PublicInputAdapter(address(batchVerifier), deployer);
        console.log("PublicInputAdapter:       ", address(adapter));

        // 3. Claim ZK verifier — no adapter needed (vault passes 11 inputs directly).
        //    Deployed via vm.deployCode() to avoid naming conflicts with BatchVerifier.sol.
        address claimVerifier = deployCode("ClaimVerifier.sol:ClaimHonkVerifier");
        console.log("ClaimHonkVerifier (claim):", claimVerifier);

        // 4. Swap verifiers on the existing vault (both calls are onlyRelayer).
        BatchVault(VAULT).setVerifier(address(adapter));
        console.log("setVerifier(adapter) done on vault:", VAULT);

        BatchVault(VAULT).setClaimVerifier(claimVerifier);
        console.log("setClaimVerifier() done on vault:", VAULT);

        vm.stopBroadcast();

        console.log("\n=== Update Railway env vars ===");
        console.log("USE_REAL_ZK=true");
        console.log("ADAPTER_ADDRESS=", address(adapter));
        console.log("CLAIM_VERIFIER=", claimVerifier);
    }
}
