// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "../src/BatchVault.sol";
// Note: Do NOT import BatchVerifier.sol or ClaimVerifier.sol here — they share
// top-level library names and cannot be co-imported. Both verifiers are pre-deployed.

/// @notice Deploy a fresh BatchVault on Amoy, reusing existing verifier + token contracts.
///
/// Why a new vault?
///   The previously deployed vault (v4) had a bug in _buildMerkleRoot: it used
///   `uint256 n = 1; while (n < count) n <<= 1;` (smallest power-of-2 >= count).
///   For a 1-order batch this returns the leaf hash itself (depth-0 tree).
///   The claim circuit requires a fixed DEPTH=9 (512-leaf) tree, so roots never matched.
///   Current BatchVault.sol is fixed: `uint256 n = 512` is hardcoded.
///
/// Reuses:
///   MockUSDC:         0x3a863f9483217Ec2A909580747c3b5a299462b7A
///   MockCTF:          0xCa35b74F92432A4c8A51452AA36f6beE7d503D07
///   PublicInputAdapter: read from ADAPTER_ADDRESS env var
///   ClaimHonkVerifier:  read from CLAIM_VERIFIER env var
///
/// Prerequisites:
///   - PRIVATE_KEY in contracts/.env
///   - ADAPTER_ADDRESS=0xBc84e220129BCe680ebf38bCdBa78afba96D08bc (existing adapter)
///   - CLAIM_VERIFIER=0xF5384A8035a894Ab4151Ff557bA57533937F9ba3 (existing claim verifier)
///
/// Usage:
///   cd contracts
///   ADAPTER_ADDRESS=0xBc84e220129BCe680ebf38bCdBa78afba96D08bc \
///   CLAIM_VERIFIER=0xF5384A8035a894Ab4151Ff557bA57533937F9ba3 \
///   FOUNDRY_PROFILE=size forge script script/DeployNewVaultAmoy.s.sol \
///     --rpc-url $POLYGON_AMOY_RPC --broadcast --private-key $PRIVATE_KEY
///
/// After deployment:
///   1. Update relayer/.env: VAULT_ADDRESS=<new>
///   2. Update Railway: VAULT_ADDRESS=<new>
///   3. Update frontend/lib/contracts.ts: polygonAmoy.batchVault = <new>
///   4. Mint test USDC to trader wallet if needed
contract DeployNewVaultAmoy is Script {
    // Existing Amoy mock tokens (reused)
    address constant MOCK_USDC = 0x3a863f9483217Ec2A909580747c3b5a299462b7A;
    address constant MOCK_CTF  = 0xCa35b74F92432A4c8A51452AA36f6beE7d503D07;

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address deployer    = vm.addr(deployerKey);

        address adapter      = vm.envAddress("ADAPTER_ADDRESS");
        address claimVerifier = vm.envAddress("CLAIM_VERIFIER");

        require(adapter       != address(0), "ADAPTER_ADDRESS env var not set");
        require(claimVerifier != address(0), "CLAIM_VERIFIER env var not set");

        console.log("Deployer:              ", deployer);
        console.log("MockUSDC (reused):     ", MOCK_USDC);
        console.log("MockCTF (reused):      ", MOCK_CTF);
        console.log("PublicInputAdapter:    ", adapter);
        console.log("ClaimHonkVerifier:     ", claimVerifier);

        vm.startBroadcast(deployerKey);

        // v7.3: no MockCTFExchange needed — relayer-intermediary settlement.
        BatchVault vault = new BatchVault(
            MOCK_USDC,
            MOCK_CTF,
            deployer,       // relayer = deployer wallet for testing
            adapter,        // batch verifier: PublicInputAdapter wrapping HonkVerifier
            claimVerifier
        );
        console.log("BatchVault (new):      ", address(vault));

        // Open first batch with marketId = bytes32(0) (generic test market)
        vault.openBatch(bytes32(0));
        console.log("Batch #1 opened with marketId = bytes32(0)");

        vm.stopBroadcast();

        console.log("\n=== Update these values everywhere ===");
        console.log("VAULT_ADDRESS=", address(vault));
        console.log("");
        console.log("relayer/.env:          VAULT_ADDRESS=", address(vault));
        console.log("Railway env:           VAULT_ADDRESS=", address(vault));
        console.log("frontend/lib/contracts.ts polygonAmoy.batchVault");
        console.log("");
        console.log("=== Mint test USDC to trader wallet if needed ===");
        console.log("cast send", MOCK_USDC, "\"mint(address,uint256)\" <TRADER_ADDR> 1000000000 --rpc-url $POLYGON_AMOY_RPC --private-key $PRIVATE_KEY");
    }
}
