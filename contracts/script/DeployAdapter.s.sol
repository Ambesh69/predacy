// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "../src/PublicInputAdapter.sol";
import "../src/interfaces/IBatchVerifier.sol";

/// @notice Deploy PublicInputAdapter and wire it to the BatchVault.
///
/// Usage:
///   forge script script/DeployAdapter.s.sol \
///     --rpc-url $RPC_URL --private-key $RELAYER_PRIVATE_KEY \
///     --broadcast --verify --verifier-url ...
///
/// Set these env vars before running:
///   HONK_VERIFIER_ADDRESS  = 0x3594DD45fCcc19108c71071a0dDf824ce8fbA6F7 (current 37-input verifier)
///   VAULT_ADDRESS          = 0x704314474E34C01F99b98e5A4C956B7748e34e44
///
/// After deployment, copy the logged ADAPTER_ADDRESS into Railway env vars.
contract DeployAdapter is Script {
    function run() external {
        address honk  = vm.envAddress("HONK_VERIFIER_ADDRESS");
        address vault = vm.envAddress("VAULT_ADDRESS");

        vm.startBroadcast();

        // Deploy the adapter; owner = msg.sender (relayer wallet)
        PublicInputAdapter adapter = new PublicInputAdapter(honk, msg.sender);
        console2.log("PublicInputAdapter deployed at:", address(adapter));
        console2.log("  honk  =", honk);
        console2.log("  owner =", msg.sender);

        // Wire the vault to use the adapter as its verifier
        // BatchVault.setVerifier(address) is restricted to msg.sender == relayer
        (bool ok, ) = vault.call(
            abi.encodeWithSignature("setVerifier(address)", address(adapter))
        );
        require(ok, "setVerifier failed");
        console2.log("Vault verifier updated to adapter:", address(adapter));
        console2.log("");
        console2.log(">>> Add to Railway env vars:");
        console2.log("    ADAPTER_ADDRESS =", address(adapter));

        vm.stopBroadcast();
    }
}
