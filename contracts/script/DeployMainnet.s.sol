// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "../src/BatchVerifier.sol";
import "../src/PublicInputAdapter.sol";
import "../src/BatchVault.sol";
// Note: ClaimVerifier.sol is NOT imported here — it shares top-level library names with
// BatchVerifier.sol (both are generated HonkVerifier files). Importing both in the same
// Solidity file causes "identifier already declared" errors. Instead we use vm.deployCode()
// to deploy ClaimHonkVerifier by artifact path, which bypasses the naming conflict.

/// @notice Deploy Predacy to Polygon mainnet.
///
/// Prerequisites:
///   - Relayer wallet must have ~0.2 MATIC for deployment gas
///     Contracts deployed: ZKTranscriptLib, RelationsLib, CommitmentSchemeLib,
///     HonkVerifier, PublicInputAdapter, ClaimHonkVerifier, BatchVault (7 total)
///   - MARKET_ID must be a valid Polymarket condition ID on Polygon
///   - Polymarket CLOB API keys must be set in relayer .env
///
/// Deployment order:
///   1. ZKTranscriptLib  — Fiat-Shamir transcript generation (auto-linked by Forge)
///   2. RelationsLib     — UltraHonk relation accumulation (auto-linked by Forge)
///   3. CommitmentSchemeLib — Gemini/Shplemini helpers (auto-linked by Forge)
///   4. HonkVerifier     — Batch clearing ZK verifier (37 public inputs)
///   5. PublicInputAdapter — Bridges BatchVault (6 inputs) → HonkVerifier (37 inputs)
///   6. ClaimHonkVerifier — Claim ZK verifier (11 public inputs, no adapter needed)
///   7. BatchVault       — Core Predacy contract
///   All contracts < 24,576-byte EIP-170 limit.
///
/// Why PublicInputAdapter:
///   BatchVault.settleBatch() builds 6 public inputs; HonkVerifier expects 37
///   (32 bytes of commitmentRoot + 5 scalars). The adapter expands + appends orderCount
///   (supplied by relayer via setPendingOrderCount() before each settleBatch).
///   ClaimHonkVerifier.verify() expects exactly 11 inputs — no adapter needed.
///
/// Re-generate verifiers from circuits:
///   cd circuits/batch_clearing && nargo build
///   bb write_vk -b target/batch_clearing.json -o target/vk -t evm
///   bb write_solidity_verifier -k target/vk/vk -o target/HonkVerifier.sol -t evm
///   cp target/HonkVerifier.sol ../contracts/src/BatchVerifier.sol
///   (repeat for circuits/claim → ClaimVerifier.sol)
///
/// ZK pipeline test (run before mainnet deploy):
///   cd contracts && forge test --match-contract HonkVerifierTest --ffi -vv
///
/// Usage:
///   FOUNDRY_PROFILE=size forge script script/DeployMainnet.s.sol \
///     --rpc-url $POLYGON_MAINNET_RPC \
///     --broadcast \
///     --verify \
///     --etherscan-api-key $POLYGONSCAN_API_KEY \
///     --private-key $PRIVATE_KEY
///
/// After deployment, update frontend/lib/contracts.ts and relayer .env with printed addresses.
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

        // 1. Batch clearing ZK verifier
        //    Forge auto-links ZKTranscriptLib, RelationsLib, CommitmentSchemeLib.
        HonkVerifier batchVerifier = new HonkVerifier();
        console.log("HonkVerifier (batch):     ", address(batchVerifier));

        // 2. PublicInputAdapter — BatchVault passes 6 inputs to settleBatch();
        //    this adapter expands them to the 37 inputs HonkVerifier.verify() expects.
        //    Relayer must call adapter.setPendingOrderCount(n) before each settleBatch().
        PublicInputAdapter adapter = new PublicInputAdapter(address(batchVerifier), deployer);
        console.log("PublicInputAdapter:       ", address(adapter));

        // 3. Claim ZK verifier — BatchVault passes 11 inputs directly, no adapter needed.
        //    Deployed via vm.deployCode() to avoid naming conflicts with BatchVerifier.sol.
        address claimVerifier = deployCode("ClaimVerifier.sol:ClaimHonkVerifier");
        console.log("ClaimHonkVerifier (claim):", claimVerifier);

        // 4. BatchVault — points to real USDC + Polymarket CTF
        //    verifier = adapter (not batchVerifier directly)
        BatchVault vault = new BatchVault(
            REAL_USDC,
            REAL_CTF,
            deployer,             // relayer — use a dedicated relayer wallet
            address(adapter),     // batch verifier: PublicInputAdapter wrapping HonkVerifier
            claimVerifier
        );
        console.log("BatchVault:               ", address(vault));

        // 5. Open first batch so the UI has a live timer immediately
        vault.openBatch(marketId);
        console.log("Batch #1 opened for market:", vm.toString(marketId));

        vm.stopBroadcast();

        console.log("\n=== Copy these into frontend/lib/contracts.ts ===");
        console.log("[polygon.id].batchVault:", address(vault));
        console.log("[polygon.id].usdc:       ", REAL_USDC, "(already set)");
        console.log("[polygon.id].ctf:        ", REAL_CTF,  "(already set)");
        console.log("\n=== Copy these into relayer .env ===");
        console.log("VAULT_ADDRESS=", address(vault));
        console.log("ADAPTER_ADDRESS=", address(adapter));
        console.log("CLAIM_VERIFIER=", claimVerifier);
        console.log("CHAIN_ID=137");
        console.log("RPC_URL=https://polygon-rpc.com/");
        console.log("MARKET_ID=", vm.toString(marketId));
        console.log("USE_REAL_ZK=true");
    }
}
