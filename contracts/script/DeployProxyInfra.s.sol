// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "../src/ProxyWalletFactory.sol";
import "../src/WrappedCTFFactory.sol";

/// @notice Deploy ProxyWalletFactory + WrappedCTFFactory to Polygon mainnet.
///
/// These two contracts are the foundation of the full privacy flow:
///   Alice → Railgun → ephemeral EOA
///      → ProxyWallet (CREATE2 via ProxyWalletFactory)
///      → commitOrderFor on BatchVault
///      → [batch settles] YES/NO tokens → ProxyWallet via ZK claim
///      → WrappedCTFToken.wrap() (via WrappedCTFFactory)
///      → RailgunSmartWallet.shield()
///      → Alice privately withdraws
///
/// Usage:
///   cd contracts
///   FOUNDRY_PROFILE=default forge script script/DeployProxyInfra.s.sol \
///     --rpc-url $POLYGON_MAINNET_RPC \
///     --broadcast \
///     --verify \
///     --etherscan-api-key $POLYGONSCAN_API_KEY \
///     --private-key $PRIVATE_KEY
///
/// After deployment, update:
///   - frontend/.env.local: NEXT_PUBLIC_PROXY_WALLET_FACTORY=<address>
///   - relayer/.env:        PROXY_WALLET_FACTORY=<address>
///                          WRAPPED_CTF_FACTORY=<address>
contract DeployProxyInfra is Script {

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address deployer    = vm.addr(deployerKey);

        console.log("Deployer:", deployer);
        console.log("Chain ID:", block.chainid);

        vm.startBroadcast(deployerKey);

        // 1. ProxyWalletFactory — deploys deterministic ProxyWallets (CREATE2)
        ProxyWalletFactory proxyFactory = new ProxyWalletFactory();
        console.log("ProxyWalletFactory:", address(proxyFactory));

        // 2. WrappedCTFFactory — deploys ERC-20 wrappers for CTF ERC-1155 positions
        WrappedCTFFactory wrappedFactory = new WrappedCTFFactory();
        console.log("WrappedCTFFactory: ", address(wrappedFactory));

        vm.stopBroadcast();

        console.log("\n=== Update frontend/.env.local ===");
        console.log("NEXT_PUBLIC_PROXY_WALLET_FACTORY=", address(proxyFactory));

        console.log("\n=== Update relayer/.env ===");
        console.log("PROXY_WALLET_FACTORY=", address(proxyFactory));
        console.log("WRAPPED_CTF_FACTORY=",  address(wrappedFactory));
    }
}
