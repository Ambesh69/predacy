// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "../src/MockBatchVerifier.sol";
import "../src/BatchVault.sol";

/// @notice Deploy Predacy to Polygon mainnet.
///
/// Prerequisites:
///   - Relayer wallet must have ~0.1 MATIC for deployment gas
///   - MARKET_ID must be a valid Polymarket condition ID on Polygon
///   - Polymarket CLOB API keys must be set in relayer .env
///
/// Note: MockBatchVerifier is used as an interim verifier.
///   Swap to the real Noir-generated verifier once the circuit is compiled:
///     cd circuits/batch_clearing && nargo build
///     bb write_vk -b target/batch_clearing.json && bb contract
///   Then: vault.setVerifier(<new_verifier_address>)
///
/// Usage:
///   forge script script/DeployMainnet.s.sol \
///     --rpc-url $POLYGON_MAINNET_RPC \
///     --broadcast \
///     --verify \
///     --etherscan-api-key $POLYGONSCAN_API_KEY \
///     --private-key $PRIVATE_KEY
///
/// After deployment, update frontend/lib/contracts.ts with the new addresses.
contract DeployMainnet is Script {
    // Polygon mainnet — these never change
    address constant REAL_USDC = 0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174;
    address constant REAL_CTF  = 0x4D97DCd97eC945f40cF65F87097ACe5EA0476045;

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address deployer    = vm.addr(deployerKey);

        // MARKET_ID must be a real Polymarket condition ID (32 bytes)
        // e.g. the conditionId from Polymarket Gamma API: /markets?condition_id=...
        bytes32 marketId = vm.envBytes32("MARKET_ID");
        require(marketId != bytes32(0), "DeployMainnet: MARKET_ID env var not set");

        vm.startBroadcast(deployerKey);

        // 1. MockBatchVerifier — interim until Noir circuit is compiled
        //    Replace with: cd circuits/batch_clearing && nargo build && bb contract
        MockBatchVerifier verifier = new MockBatchVerifier();
        console.log("MockBatchVerifier:  ", address(verifier));
        console.log("  (interim — swap for real Noir verifier after circuit compilation)");

        // 2. BatchVault — points to real USDC + Polymarket CTF
        //    Deployer wallet is the trusted relayer
        BatchVault vault = new BatchVault(
            REAL_USDC,
            REAL_CTF,
            deployer,        // relayer — should be a dedicated relayer wallet, not user wallet
            address(verifier)
        );
        console.log("BatchVault:         ", address(vault));

        // 3. Open first batch so the UI has a live timer immediately
        vault.openBatch(marketId);
        console.log("Batch #1 opened for market:", vm.toString(marketId));

        vm.stopBroadcast();

        console.log("\n=== Copy these into frontend/lib/contracts.ts ===");
        console.log("[polygon.id].batchVault:", address(vault));
        console.log("[polygon.id].usdc:       ", REAL_USDC, "(already set)");
        console.log("[polygon.id].ctf:        ", REAL_CTF,  "(already set)");
        console.log("\n=== Copy these into relayer .env ===");
        console.log("VAULT_ADDRESS=", address(vault));
        console.log("CHAIN_ID=137");
        console.log("RPC_URL=https://polygon-rpc.com/");
        console.log("MARKET_ID=", vm.toString(marketId));
    }
}
