// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "../src/mocks/MockUSDC.sol";
import "../src/mocks/MockCTF.sol";
import "../src/BatchVerifier.sol";
import "../src/BatchVault.sol";

/// @notice Deploy Predacy to Polygon Amoy with the REAL HonkVerifier.
///
/// Use this to validate that USE_REAL_ZK=true proof generation works end-to-end
/// before deploying to mainnet. Uses mock USDC + CTF (Amoy has no real Polymarket).
///
/// Note: Deploys 4 library/verifier contracts (all < 24 KB after split):
///   ZKTranscriptLib, RelationsLib, CommitmentSchemeLib, HonkVerifier
///   Forge auto-links them during broadcast — no manual library management needed.
///
/// Prerequisites:
///   - Deployer wallet needs ~0.1 MATIC on Polygon Amoy
///     Faucet: https://faucet.polygon.technology/
///   - PRIVATE_KEY set in contracts/.env
///
/// Usage:
///   cd contracts
///   forge script script/DeployAmoyHonk.s.sol \
///     --rpc-url $POLYGON_AMOY_RPC \
///     --broadcast \
///     --private-key $PRIVATE_KEY
///
/// After deployment:
///   1. Update relayer .env: VAULT_ADDRESS, CHAIN_ID=80002, USE_REAL_ZK=true
///   2. Run relayer locally and submit a test order
///   3. Confirm settleBatch() succeeds (HonkVerifier.verify() returns true)
///   4. If it passes → deploy DeployMainnet.s.sol to Polygon mainnet
contract DeployAmoyHonk is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address deployer    = vm.addr(deployerKey);

        vm.startBroadcast(deployerKey);

        // 1. Mock USDC — 6 decimals, public mint() for testing
        MockUSDC usdc = new MockUSDC();
        console.log("MockUSDC:           ", address(usdc));

        // 2. Mock CTF — minimal Gnosis Conditional Token Framework
        MockCTF ctf = new MockCTF();
        console.log("MockCTF:            ", address(ctf));

        // 3. Real HonkVerifier (+ auto-deployed ZKTranscriptLib, RelationsLib, CommitmentSchemeLib)
        //    Generated from circuits/batch_clearing/src/main.nr. Forge broadcasts all 4 contracts.
        //    This is the critical test: settleBatch() must pass verify() with a real proof.
        HonkVerifier verifier = new HonkVerifier();
        console.log("HonkVerifier:       ", address(verifier));

        // 4. BatchVault — deployer is the relayer for this test deploy
        BatchVault vault = new BatchVault(
            address(usdc),
            address(ctf),
            deployer,        // relayer = deployer wallet for testing
            address(verifier),
            address(verifier) // claimVerifier — same mock for now, update after claim circuit deploy
        );
        console.log("BatchVault:         ", address(vault));

        // 5. Open first batch with marketId = bytes32(0) (generic test market)
        //    Pass matching marketId to relayer: MARKET_ID=0x000...0
        vault.openBatch(bytes32(0));
        console.log("Batch #1 opened with marketId = bytes32(0)");

        vm.stopBroadcast();

        console.log("\n=== Update relayer .env with these values ===");
        console.log("VAULT_ADDRESS=", address(vault));
        console.log("CHAIN_ID=80002");
        console.log("RPC_URL=https://rpc-amoy.polygon.technology/");
        console.log("MARKET_ID=0x0000000000000000000000000000000000000000000000000000000000000000");
        console.log("USE_REAL_ZK=true");
        console.log("");
        console.log("=== Mint test USDC to your test trader wallet ===");
        console.log("cast send", address(usdc), "\"mint(address,uint256)\" <TRADER_ADDR> 1000000000 --rpc-url $POLYGON_AMOY_RPC --private-key $PRIVATE_KEY");
    }
}
