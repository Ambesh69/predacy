// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "../src/BatchVerifier.sol";
import "../src/BatchVault.sol";

/// @notice Deploy Predacy to Polygon mainnet.
///
/// Prerequisites:
///   - Relayer wallet must have ~0.15 MATIC for deployment gas
///     (4 contracts deployed: ZKTranscriptLib, RelationsLib, CommitmentSchemeLib, HonkVerifier + BatchVault)
///   - MARKET_ID must be a valid Polymarket condition ID on Polygon
///   - Polymarket CLOB API keys must be set in relayer .env
///
/// Deployment order (Forge auto-links library contracts before HonkVerifier):
///   1. ZKTranscriptLib  (7,843 bytes)  — Fiat-Shamir transcript generation
///   2. RelationsLib     (10,316 bytes) — UltraHonk relation accumulation
///   3. CommitmentSchemeLib (1,076 bytes) — Gemini/Shplemini commitment scheme helpers
///   4. HonkVerifier    (16,613 bytes) — Main verifier (calls libs via DELEGATECALL)
///   5. BatchVault      — Core Predacy contract
///   All contracts < 24,576-byte EIP-170 limit.
///
/// Note: Uses the real HonkVerifier generated from the Noir batch_clearing circuit.
///   Re-generate with: cd circuits/batch_clearing && nargo build
///     bb write_vk -b target/batch_clearing.json -o target/vk -t evm
///     bb write_solidity_verifier -k target/vk/vk -o target/Verifier.sol -t evm
///   Then copy target/Verifier.sol → contracts/src/BatchVerifier.sol and redeploy.
///
/// ZK pipeline test (run before mainnet deploy to confirm proofs verify):
///   cd contracts && forge test --match-contract HonkVerifierTest --ffi -vv
///   Requires: bb installed + circuits/batch_clearing/ compiled (nargo build)
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

        // 1. ZK library contracts + HonkVerifier
        //    Forge auto-deploys ZKTranscriptLib, RelationsLib, CommitmentSchemeLib
        //    and links their addresses into HonkVerifier before broadcasting it.
        //    Each contract is < 24,576 bytes (EIP-170 limit). Library deployment
        //    addresses appear in broadcast/DeployMainnet.s.sol/<chainId>/run-latest.json.
        HonkVerifier verifier = new HonkVerifier();
        console.log("HonkVerifier:       ", address(verifier));

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
