// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "../src/mocks/MockUSDC.sol";
import "../src/mocks/MockCTF.sol";
import "../src/BatchVerifier.sol";
import "../src/PublicInputAdapter.sol";
import "../src/BatchVault.sol";
// Note: ClaimVerifier.sol not imported — naming conflict with BatchVerifier.sol.
// Deployed via vm.deployCode() instead.

/// @notice Fresh deploy to Polygon Amoy with real ZK verifiers (end-to-end test).
///
/// Use this to validate the full ZK pipeline before deploying to mainnet.
/// Uses mock USDC + CTF (Amoy has no real Polymarket).
///
/// Deploys:
///   ZKTranscriptLib, RelationsLib, CommitmentSchemeLib (auto-linked by Forge)
///   HonkVerifier (batch), PublicInputAdapter, ClaimHonkVerifier, BatchVault
///
/// Why PublicInputAdapter:
///   BatchVault.settleBatch() builds 6 public inputs; HonkVerifier.verify() expects 37.
///   The adapter expands commitmentRoot to 32 byte fields and appends orderCount.
///   Relayer supplies orderCount via adapter.setPendingOrderCount(n) before settleBatch().
///
/// Prerequisites:
///   - ~0.15 MATIC on Polygon Amoy (faucet: https://faucet.polygon.technology/)
///   - PRIVATE_KEY set in contracts/.env
///
/// Usage:
///   cd contracts
///   FOUNDRY_PROFILE=size forge script script/DeployAmoyHonk.s.sol \
///     --rpc-url $POLYGON_AMOY_RPC \
///     --broadcast \
///     --private-key $PRIVATE_KEY
///
/// After deployment:
///   1. Update relayer .env with printed VAULT_ADDRESS, ADAPTER_ADDRESS
///   2. Set USE_REAL_ZK=true, CHAIN_ID=80002
///   3. Run relayer locally and submit a test order
///   4. Confirm settleBatch() succeeds (HonkVerifier.verify() returns true)
///   5. If it passes → deploy DeployMainnet.s.sol to Polygon mainnet
contract DeployAmoyHonk is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address deployer    = vm.addr(deployerKey);

        vm.startBroadcast(deployerKey);

        // 1. Mock USDC — 6 decimals, public mint() for testing
        MockUSDC usdc = new MockUSDC();
        console.log("MockUSDC:                 ", address(usdc));

        // 2. Mock CTF — minimal Gnosis Conditional Token Framework
        MockCTF ctf = new MockCTF();
        console.log("MockCTF:                  ", address(ctf));

        // 3. Batch clearing ZK verifier
        //    Forge auto-links ZKTranscriptLib, RelationsLib, CommitmentSchemeLib.
        HonkVerifier batchVerifier = new HonkVerifier();
        console.log("HonkVerifier (batch):     ", address(batchVerifier));

        // 4. PublicInputAdapter — expands 6 inputs from settleBatch() to 37 for HonkVerifier.
        PublicInputAdapter adapter = new PublicInputAdapter(address(batchVerifier), deployer);
        console.log("PublicInputAdapter:       ", address(adapter));

        // 5. Claim ZK verifier — vault passes 11 inputs directly, no adapter needed.
        //    Deployed via vm.deployCode() to avoid naming conflicts with BatchVerifier.sol.
        address claimVerifier = deployCode("ClaimVerifier.sol:ClaimHonkVerifier");
        console.log("ClaimHonkVerifier (claim):", claimVerifier);

        // 6. BatchVault — deployer is relayer for this test deploy
        BatchVault vault = new BatchVault(
            address(usdc),
            address(ctf),
            deployer,             // relayer = deployer wallet for testing
            address(adapter),     // batch verifier: PublicInputAdapter wrapping HonkVerifier
            claimVerifier
        );
        console.log("BatchVault:               ", address(vault));

        // 7. Open first batch with marketId = bytes32(0) (generic test market)
        vault.openBatch(bytes32(0));
        console.log("Batch #1 opened with marketId = bytes32(0)");

        vm.stopBroadcast();

        console.log("\n=== Update relayer .env with these values ===");
        console.log("VAULT_ADDRESS=", address(vault));
        console.log("ADAPTER_ADDRESS=", address(adapter));
        console.log("CLAIM_VERIFIER=", claimVerifier);
        console.log("CHAIN_ID=80002");
        console.log("RPC_URL=https://rpc-amoy.polygon.technology/");
        console.log("MARKET_ID=0x0000000000000000000000000000000000000000000000000000000000000000");
        console.log("USE_REAL_ZK=true");
        console.log("");
        console.log("=== Mint test USDC to your test trader wallet ===");
        console.log("cast send", address(usdc), "\"mint(address,uint256)\" <TRADER_ADDR> 1000000000 --rpc-url $POLYGON_AMOY_RPC --private-key $PRIVATE_KEY");
    }
}
