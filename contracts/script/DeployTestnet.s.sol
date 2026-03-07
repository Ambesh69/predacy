// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "../src/mocks/MockUSDC.sol";
import "../src/mocks/MockCTF.sol";
import "../src/MockBatchVerifier.sol";
import "../src/BatchVault.sol";

/// @notice Deploy Predacy to Polygon Amoy testnet.
///
/// Usage:
///   forge script script/DeployTestnet.s.sol \
///     --rpc-url $POLYGON_AMOY_RPC \
///     --broadcast \
///     --private-key $PRIVATE_KEY
///
/// The deployer wallet becomes the relayer (trusted batch processor).
/// After deployment a first batch is opened immediately so the UI has a live timer.
contract DeployTestnet is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address deployer    = vm.addr(deployerKey);

        vm.startBroadcast(deployerKey);

        // 1. Mock USDC — 6 decimals, public faucet
        MockUSDC usdc = new MockUSDC();
        console.log("MockUSDC:          ", address(usdc));

        // 2. Mock CTF — minimal Gnosis Conditional Token Framework
        MockCTF ctf = new MockCTF();
        console.log("MockCTF:           ", address(ctf));

        // 3. Mock ZK verifier — always returns true (swap for Noir verifier on mainnet)
        MockBatchVerifier verifier = new MockBatchVerifier();
        console.log("MockBatchVerifier: ", address(verifier));

        // 4. BatchVault — deployer is relayer for testnet (v7.3: no CTFExchange param)
        BatchVault vault = new BatchVault(
            address(usdc),
            address(ctf),
            deployer,   // relayer
            address(verifier),
            address(verifier) // claimVerifier — same mock for now
        );
        console.log("BatchVault:        ", address(vault));

        // 5. Open the first batch (marketId = bytes32(0) = generic test market)
        //    Users can submit commitments as soon as the deploy tx confirms.
        vault.openBatch(bytes32(0));
        console.log("Batch #1 opened with marketId = bytes32(0)");

        vm.stopBroadcast();

        console.log("\n--- Copy these into frontend/lib/contracts.ts ---");
        console.log("batchVault:", address(vault));
        console.log("usdc:      ", address(usdc));
        console.log("ctf:       ", address(ctf));
    }
}
