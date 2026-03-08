// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "../src/ClaimVerifier.sol";

/// @notice Deploy a new ClaimHonkVerifier (v2) to Polygon mainnet and wire it into BatchVault v10.
///
/// WHY: The previously deployed ClaimHonkVerifier (0xa555AAb4E1BE1a002EDe3150818650B3fE2164A1)
///      was compiled from the OLD claim circuit (is_buy: bool interface). The circuit was later
///      updated to use side: u8 (4 order sides) and ClaimVerifier.sol was regenerated with the
///      new VK_HASH (0x303ee1...). However the new verifier was NEVER deployed on-chain,
///      causing claimWithProof() to fail with SumcheckFailed.
///
/// Prerequisites:
///   - contracts/.env: PRIVATE_KEY, POLYGON_MAINNET_RPC, POLYGONSCAN_API_KEY
///
/// Usage:
///   cd contracts
///   FOUNDRY_PROFILE=size forge script script/DeployClaimVerifierV2Mainnet.s.sol \
///     --rpc-url $POLYGON_MAINNET_RPC \
///     --broadcast \
///     --verify \
///     --etherscan-api-key $POLYGONSCAN_API_KEY \
///     --private-key $PRIVATE_KEY
///
/// After deployment, update Railway env → CLAIM_VERIFIER=<new address>
contract DeployClaimVerifierV2Mainnet is Script {
    // BatchVault v10 — the vault that needs the new claim verifier
    address constant VAULT_V10 = 0x8fD2B227E98F401F55B4252d34905C96eEEAEA1a;

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");

        vm.startBroadcast(deployerKey);

        // Deploy updated ClaimHonkVerifier (VK_HASH = 0x303ee1... matching side: u8 circuit)
        ClaimHonkVerifier verifier = new ClaimHonkVerifier();
        console.log("ClaimHonkVerifier v2:", address(verifier));

        // Wire into BatchVault v10 (relayer = deployer)
        // BatchVault.setClaimVerifier() requires msg.sender == relayer
        (bool ok,) = VAULT_V10.call(
            abi.encodeWithSignature("setClaimVerifier(address)", address(verifier))
        );
        require(ok, "setClaimVerifier failed");
        console.log("setClaimVerifier() called on vault", VAULT_V10);

        vm.stopBroadcast();

        console.log("\n=== Update the following after this deployment ===");
        console.log("relayer/.env               CLAIM_VERIFIER=", address(verifier));
        console.log("Railway dashboard          CLAIM_VERIFIER=", address(verifier));
        console.log("ADAPTER_ADDRESS is unchanged (batch verifier not affected).");
    }
}
