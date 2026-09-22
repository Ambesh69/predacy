// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console} from "forge-std/Script.sol";
import {
    ShieldedPoolV2,
    IShieldedPoolV2ERC20,
    IShieldedPoolV2CTF,
    IShieldedPoolV2Verifier,
    IShieldedPoolV2ExecutionAdapter
} from "../src/ShieldedPoolV2.sol";
import {ShieldedPolymarketAdapter, IShieldedAdapterERC20} from "../src/ShieldedPolymarketAdapter.sol";
import {IBridgeERC20, ICollateralOnramp, ICollateralOfframp} from "../src/PolymarketCollateralBridge.sol";

/// @notice Deploys v13 in a paused state after all six verifier addresses are independently deployed.
contract DeployShieldedV13Mainnet is Script {
    address constant USDCE = 0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174;
    address constant PUSD = 0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB;
    address constant CTF = 0x4D97DCd97eC945f40cF65F87097ACe5EA0476045;
    address constant ONRAMP = 0x93070a847efEf7F70739046A929D47a521F5B8ee;
    address constant OFFRAMP = 0x2957922Eb93258b93368531d39fAcCA3B4dC5854;

    function run() external returns (ShieldedPoolV2 pool, ShieldedPolymarketAdapter adapter) {
        require(block.chainid == 137, "v13: Polygon mainnet only");
        uint256 maxGasPrice = vm.envOr("V13_MAX_GAS_PRICE_WEI", uint256(5 gwei));
        require(block.basefee <= maxGasPrice && tx.gasprice <= maxGasPrice, "v13: gas price exceeds cap");
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address relayer = vm.envAddress("V13_RELAYER");
        address guardian = vm.envAddress("V13_GUARDIAN");
        address depositWallet = vm.envAddress("V13_DEPOSIT_WALLET");
        address withdrawVerifier = vm.envAddress("V13_WITHDRAW_VERIFIER");
        address transferVerifier = vm.envAddress("V13_TRANSFER_VERIFIER");
        address orderVerifier = vm.envAddress("V13_ORDER_VERIFIER");
        address routeVerifier = vm.envAddress("V13_ROUTE_VERIFIER");
        address settlementVerifier = vm.envAddress("V13_SETTLEMENT_VERIFIER");
        address cancelVerifier = vm.envAddress("V13_CANCEL_VERIFIER");

        require(relayer != address(0) && guardian != address(0) && relayer != guardian, "v13: roles invalid");
        require(depositWallet.code.length > 0, "v13: Deposit Wallet undeployed");
        require(
            withdrawVerifier.code.length > 0 && transferVerifier.code.length > 0 && orderVerifier.code.length > 0
                && routeVerifier.code.length > 0 && settlementVerifier.code.length > 0
                && cancelVerifier.code.length > 0,
            "v13: verifier undeployed"
        );

        vm.startBroadcast(deployerKey);
        adapter = new ShieldedPolymarketAdapter(
            IShieldedAdapterERC20(USDCE), IBridgeERC20(PUSD), ICollateralOnramp(ONRAMP),
            ICollateralOfframp(OFFRAMP), relayer, guardian, depositWallet
        );
        pool = new ShieldedPoolV2(
            IShieldedPoolV2ERC20(USDCE), IShieldedPoolV2CTF(CTF),
            IShieldedPoolV2Verifier(withdrawVerifier), IShieldedPoolV2Verifier(transferVerifier),
            IShieldedPoolV2Verifier(orderVerifier), IShieldedPoolV2Verifier(routeVerifier),
            IShieldedPoolV2Verifier(settlementVerifier), IShieldedPoolV2Verifier(cancelVerifier),
            IShieldedPoolV2ExecutionAdapter(address(adapter)), relayer, guardian
        );
        adapter.bindPool(address(pool));
        vm.stopBroadcast();

        require(pool.paused(), "v13: pool must deploy paused");
        require(adapter.pool() == address(pool), "v13: adapter binding failed");
        console.log("Paused ShieldedPoolV2:", address(pool));
        console.log("ShieldedPolymarketAdapter:", address(adapter));
    }
}
