// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import {ShieldedPoolV1, IShieldedPoolERC20, IShieldedPoolCTF, IShieldedWithdrawVerifier, IShieldedExecutionAdapter}
    from "../src/ShieldedPoolV1.sol";
import {ShieldedPolymarketAdapter, IShieldedAdapterERC20} from "../src/ShieldedPolymarketAdapter.sol";
import {IBridgeERC20, ICollateralOnramp, ICollateralOfframp} from "../src/PolymarketCollateralBridge.sol";

/// @notice Deploys the v12 private pool and Deposit Wallet adapter in the paused state.
/// @dev Verifiers are deployed from their isolated Foundry projects and supplied by address.
contract DeployShieldedV12Mainnet is Script {
    address constant USDCE = 0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174;
    address constant PUSD = 0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB;
    address constant CTF = 0x4D97DCd97eC945f40cF65F87097ACe5EA0476045;
    address constant ONRAMP = 0x93070a847efEf7F70739046A929D47a521F5B8ee;
    address constant OFFRAMP = 0x2957922Eb93258b93368531d39fAcCA3B4dC5854;

    function run() external returns (ShieldedPoolV1 pool, ShieldedPolymarketAdapter adapter) {
        require(block.chainid == 137, "v12: Polygon mainnet only");
        uint256 maxGasPrice = vm.envOr("V12_MAX_GAS_PRICE_WEI", uint256(5 gwei));
        require(block.basefee <= maxGasPrice, "v12: Polygon gas exceeds deployment cap");
        require(tx.gasprice <= maxGasPrice, "v12: transaction gas price exceeds deployment cap");
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address relayer = vm.envAddress("V12_RELAYER");
        address guardian = vm.envAddress("V12_GUARDIAN");
        address depositWallet = vm.envAddress("V12_DEPOSIT_WALLET");
        address withdrawVerifier = vm.envAddress("V12_WITHDRAW_VERIFIER");
        address transferVerifier = vm.envAddress("V12_TRANSFER_VERIFIER");
        address orderVerifier = vm.envAddress("V12_ORDER_VERIFIER");
        address batchVerifier = vm.envAddress("V12_BUY_BATCH_VERIFIER");

        require(relayer != address(0) && guardian != address(0) && relayer != guardian, "v12: roles invalid");
        require(depositWallet.code.length > 0, "v12: Deposit Wallet undeployed");
        require(
            withdrawVerifier.code.length > 0 && transferVerifier.code.length > 0 && orderVerifier.code.length > 0
                && batchVerifier.code.length > 0,
            "v12: verifier undeployed"
        );
        require(
            USDCE.code.length > 0 && PUSD.code.length > 0 && CTF.code.length > 0 && ONRAMP.code.length > 0
                && OFFRAMP.code.length > 0,
            "v12: Polygon assets missing"
        );

        vm.startBroadcast(deployerKey);
        adapter = new ShieldedPolymarketAdapter(
            IShieldedAdapterERC20(USDCE),
            IBridgeERC20(PUSD),
            ICollateralOnramp(ONRAMP),
            ICollateralOfframp(OFFRAMP),
            relayer,
            guardian,
            depositWallet
        );
        pool = new ShieldedPoolV1(
            IShieldedPoolERC20(USDCE),
            IShieldedPoolCTF(CTF),
            IShieldedWithdrawVerifier(withdrawVerifier),
            IShieldedWithdrawVerifier(transferVerifier),
            IShieldedWithdrawVerifier(orderVerifier),
            IShieldedWithdrawVerifier(batchVerifier),
            IShieldedExecutionAdapter(address(adapter)),
            relayer,
            guardian
        );
        adapter.bindPool(address(pool));
        vm.stopBroadcast();

        require(pool.paused(), "v12: pool must deploy paused");
        require(adapter.pool() == address(pool), "v12: adapter binding failed");
        console.log("Paused ShieldedPoolV1:", address(pool));
        console.log("ShieldedPolymarketAdapter:", address(adapter));
    }
}
