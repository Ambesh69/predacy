// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "../src/BatchVerifier.sol";
import "../src/PublicInputAdapter.sol";

/// @notice Upgrade batch + claim verifiers on mainnet (without redeploying BatchVault).
///
/// Deploys:
///   1. HonkVerifier (new batch VK -- v8 4-sided orders)
///   2. PublicInputAdapter (wraps HonkVerifier, expands 6-input -> 37-input)
///
/// Then calls:
///   3. BatchVault.setVerifier(adapter)   -- relayer-restricted
///   4. BatchVault.setClaimVerifier(...)  -- relayer-restricted
///
/// Prerequisites:
///   VAULT_ADDRESS       = deployed BatchVault v8
///   CLAIM_VERIFIER      = newly deployed ClaimHonkVerifier (run DeployClaimVerifier.s.sol first)
///
/// Usage:
///   cd contracts
///   FOUNDRY_PROFILE=size forge script script/UpgradeVerifiersMainnet.s.sol \
///     --rpc-url $POLYGON_MAINNET_RPC \
///     --broadcast \
///     --private-key $PRIVATE_KEY
contract UpgradeVerifiersMainnet is Script {
    function run() external {
        address vault         = vm.envAddress("VAULT_ADDRESS");
        address claimVerifier = vm.envAddress("CLAIM_VERIFIER");

        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address deployer    = vm.addr(deployerKey);

        vm.startBroadcast(deployerKey);

        // 1. New batch ZK verifier (v8 VK: 4-sided orders, 54 public inputs)
        HonkVerifier honkVerifier = new HonkVerifier();
        console.log("HonkVerifier (batch v8):", address(honkVerifier));

        // 2. New PublicInputAdapter wrapping the new HonkVerifier
        //    Relayer must call adapter.setPendingOrderCount(n) before each settleBatch.
        PublicInputAdapter adapter = new PublicInputAdapter(address(honkVerifier), deployer);
        console.log("PublicInputAdapter:     ", address(adapter));

        // 3. Wire vault to use the new adapter as its batch verifier
        (bool ok1, ) = vault.call(
            abi.encodeWithSignature("setVerifier(address)", address(adapter))
        );
        require(ok1, "setVerifier failed");
        console.log("Vault batch verifier -> adapter");

        // 4. Update the claim verifier (v8 VK: side: u8 instead of is_buy: bool)
        (bool ok2, ) = vault.call(
            abi.encodeWithSignature("setClaimVerifier(address)", claimVerifier)
        );
        require(ok2, "setClaimVerifier failed");
        console.log("Vault claim verifier -> ClaimHonkVerifier");

        vm.stopBroadcast();

        console.log("\n=== Update Railway env vars ===");
        console.log("ADAPTER_ADDRESS=", address(adapter));
        console.log("CLAIM_VERIFIER=", claimVerifier);
        console.log("USE_REAL_ZK=true");
    }
}
