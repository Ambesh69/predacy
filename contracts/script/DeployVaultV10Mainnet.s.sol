// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "../src/BatchVault.sol";

/// @notice Deploy BatchVault v10 to Polygon mainnet.
///
/// Reuses all existing v9 verifiers (ZK circuits unchanged) and infrastructure.
/// Only deploys the new vault contract.
///
/// Prerequisites:
///   - contracts/.env: PRIVATE_KEY, POLYGON_MAINNET_RPC, POLYGONSCAN_API_KEY, MARKET_ID
///
/// Usage:
///   cd contracts
///   FOUNDRY_PROFILE=size forge script script/DeployVaultV10Mainnet.s.sol \
///     --rpc-url $POLYGON_MAINNET_RPC \
///     --broadcast \
///     --verify \
///     --etherscan-api-key $POLYGONSCAN_API_KEY \
///     --private-key $PRIVATE_KEY
///
/// After deployment:
///   - Update frontend/lib/contracts.ts → polygon.batchVault = <new address>
///   - Update relayer/.env → VAULT_ADDRESS=<new address>
///   - Update Railway env → VAULT_ADDRESS=<new address>
///   - Push code → Railway auto-deploys relayer
///   - Relayer startup will call:
///       ensureApprovals()         → CTF/USDC approvals for new vault
///       ensureMarketTokenIds()    → registers NegRisk token IDs on new vault
contract DeployVaultV10Mainnet is Script {
    // ── Polygon mainnet — never change ──────────────────────────────────────
    address constant REAL_USDC = 0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174; // USDC.e
    address constant REAL_CTF  = 0x4D97DCd97eC945f40cF65F87097ACe5EA0476045; // Gnosis CTF

    // ── Reuse v9 verifiers (ZK circuits unchanged in v10) ───────────────────
    // PublicInputAdapter wrapping HonkVerifier (batch clearing, 37 public inputs)
    address constant ADAPTER_V9   = 0x6D7FA6692f0Ea7306E6289e5D045B455bbA85aF1;
    // ClaimHonkVerifier (ZK claim proofs, 11 public inputs)
    address constant CLAIM_VER_V9 = 0xa555AAb4E1BE1a002EDe3150818650B3fE2164A1;

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address deployer    = vm.addr(deployerKey);

        bytes32 marketId = vm.envBytes32("MARKET_ID");
        require(marketId != bytes32(0), "DeployVaultV10Mainnet: MARKET_ID not set");

        vm.startBroadcast(deployerKey);

        // Deploy BatchVault v10 — reusing all existing verifiers
        BatchVault vault = new BatchVault(
            REAL_USDC,
            REAL_CTF,
            deployer,      // relayer == deployer (same private key)
            ADAPTER_V9,    // batch verifier: PublicInputAdapter → HonkVerifier
            CLAIM_VER_V9   // claim verifier: ClaimHonkVerifier
        );
        console.log("BatchVault v10:        ", address(vault));

        // Open first batch so the frontend has a live timer immediately.
        // Relayer will call ensureMarketTokenIds() at startup to register
        // the NegRisk token IDs before any orders can be committed.
        vault.openBatch(marketId);
        console.log("Batch #1 opened for:   ", vm.toString(marketId));

        vm.stopBroadcast();

        console.log("\n=== Update the following after this deployment ===");
        console.log("frontend/lib/contracts.ts  [polygon.id].batchVault:", address(vault));
        console.log("relayer/.env               VAULT_ADDRESS=",           address(vault));
        console.log("Railway dashboard          VAULT_ADDRESS=",           address(vault));
        console.log("\nADAPTER_ADDRESS and CLAIM_VERIFIER are unchanged from v9.");
    }
}
