// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import {BatchVaultV11, IVaultERC20, IAllocationVerifier} from "../src/BatchVaultV11.sol";
import {IBridgeERC20, ICollateralOnramp, ICollateralOfframp} from "../src/PolymarketCollateralBridge.sol";
import {IConditionalTokens} from "../src/interfaces/IConditionalTokens.sol";

/// @notice Deploys a paused v11 pilot vault. Does not change the active v10 deployment.
/// @dev Broadcast only after independent review, verifier proof checks, and Deposit Wallet setup.
contract DeployVaultV11Mainnet is Script {
    address constant USDCE = 0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174;
    address constant PUSD = 0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB;
    address constant CTF = 0x4D97DCd97eC945f40cF65F87097ACe5EA0476045;
    address constant ONRAMP = 0x93070a847efEf7F70739046A929D47a521F5B8ee;
    address constant OFFRAMP = 0x2957922Eb93258b93368531d39fAcCA3B4dC5854;

    function run() external returns (BatchVaultV11 vault) {
        require(block.chainid == 137, "v11: Polygon mainnet only");
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address relayer = vm.envAddress("V11_RELAYER");
        address guardian = vm.envAddress("V11_GUARDIAN");
        address depositWallet = vm.envAddress("V11_DEPOSIT_WALLET");
        address verifier = vm.envAddress("V11_ALLOCATION_VERIFIER");
        require(relayer != address(0) && guardian != address(0) && relayer != guardian, "v11: roles invalid");
        require(depositWallet.code.length > 0 && verifier.code.length > 0, "v11: wallet/verifier undeployed");
        require(USDCE.code.length > 0 && PUSD.code.length > 0 && CTF.code.length > 0 &&
            ONRAMP.code.length > 0 && OFFRAMP.code.length > 0, "v11: Polygon assets missing");

        vm.startBroadcast(deployerKey);
        vault = new BatchVaultV11(
            IVaultERC20(USDCE), IBridgeERC20(PUSD), ICollateralOnramp(ONRAMP),
            ICollateralOfframp(OFFRAMP), IConditionalTokens(CTF), IAllocationVerifier(verifier),
            relayer, guardian, depositWallet
        );
        vm.stopBroadcast();
        require(vault.tradingPaused(), "v11: vault must deploy paused");
        console.log("Paused BatchVaultV11:", address(vault));
    }
}
