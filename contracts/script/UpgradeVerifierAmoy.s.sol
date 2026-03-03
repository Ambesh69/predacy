// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "../src/BatchVerifier.sol";
import "../src/PublicInputAdapter.sol";
import "../src/BatchVault.sol";
// Note: ClaimVerifier.sol cannot be imported here — it shares top-level library names
// with BatchVerifier.sol (ZKTranscriptLib, RelationsLib, CommitmentSchemeLib, etc.).
// Deploy ClaimHonkVerifier first via script/DeployClaimVerifier.s.sol, then set
// CLAIM_VERIFIER=<address> in the environment before running this script.

/// @notice Upgrade the existing Amoy BatchVault to use real ZK verifiers.
///
/// Keeps the existing vault address intact — no need to re-mint USDC or
/// update VAULT_ADDRESS in Railway/frontend.
///
/// Deploys:
///   - HonkVerifier (batch clearing, 37 public inputs)
///   - PublicInputAdapter (bridges BatchVault 6 inputs → HonkVerifier 37 inputs)
///
/// Then swaps both verifiers on the vault via setVerifier / setClaimVerifier.
/// ClaimHonkVerifier must be pre-deployed via DeployClaimVerifier.s.sol.
///
/// Prerequisites:
///   - PRIVATE_KEY in contracts/.env must be the relayer wallet
///     (setVerifier and setClaimVerifier are onlyRelayer)
///   - CLAIM_VERIFIER env var set to the pre-deployed ClaimHonkVerifier address
///   - Deployer needs ~0.1 MATIC on Amoy for gas
///
/// Usage:
///   cd contracts
///   # Step 1: deploy ClaimHonkVerifier (run once, note the printed address)
///   FOUNDRY_PROFILE=size forge script script/DeployClaimVerifier.s.sol \
///     --rpc-url $POLYGON_AMOY_RPC --broadcast --private-key $PRIVATE_KEY
///
///   # Step 2: upgrade the vault
///   CLAIM_VERIFIER=0x... FOUNDRY_PROFILE=size forge script script/UpgradeVerifierAmoy.s.sol \
///     --rpc-url $POLYGON_AMOY_RPC --broadcast --private-key $PRIVATE_KEY
///
/// After deployment:
///   Set USE_REAL_ZK=true, ADAPTER_ADDRESS=<printed>, CLAIM_VERIFIER=<printed> in Railway.
contract UpgradeVerifierAmoy is Script {
    // BatchVault v4 on Polygon Amoy
    address constant VAULT = 0x2A3fa469D3F80ca64624B22EFed72a5FC89E6759;

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address deployer    = vm.addr(deployerKey);

        // ClaimHonkVerifier must be pre-deployed via DeployClaimVerifier.s.sol.
        address claimVerifier = vm.envAddress("CLAIM_VERIFIER");
        require(claimVerifier != address(0), "CLAIM_VERIFIER env var not set");

        vm.startBroadcast(deployerKey);

        // 1. Batch clearing ZK verifier
        //    Forge auto-links ZKTranscriptLib, RelationsLib, CommitmentSchemeLib.
        HonkVerifier batchVerifier = new HonkVerifier();
        console.log("HonkVerifier (batch):     ", address(batchVerifier));

        // 2. PublicInputAdapter — expands 6 inputs from settleBatch() to 37 for HonkVerifier.
        //    Relayer must call adapter.setPendingOrderCount(n) before each settleBatch().
        PublicInputAdapter adapter = new PublicInputAdapter(address(batchVerifier), deployer);
        console.log("PublicInputAdapter:       ", address(adapter));

        console.log("ClaimHonkVerifier (claim):", claimVerifier);

        // 3. Swap verifiers on the existing vault (both calls are onlyRelayer).
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
