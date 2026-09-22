// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import {HonkVerifier} from "../src/Verifier.sol";

contract DeployVerifier is Script {
    address constant TRANSCRIPT_LIBRARY = 0x9A2abcf4ca811335cFF4ed1b1d0D4d4034889350;

    function run() external returns (HonkVerifier verifier) {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        uint256 maxGasPrice = vm.envOr("V12_MAX_GAS_PRICE_WEI", uint256(5 gwei));
        require(block.basefee <= maxGasPrice, "v12: Polygon gas exceeds deployment cap");
        require(tx.gasprice <= maxGasPrice, "v12: transaction gas price exceeds deployment cap");
        require(TRANSCRIPT_LIBRARY.code.length > 0, "v12: shared transcript library missing");
        vm.startBroadcast(deployerKey);
        verifier = new HonkVerifier();
        vm.stopBroadcast();
        require(address(verifier).code.length > 0, "v12: verifier deployment failed");
        console.log("HonkVerifier:", address(verifier));
    }
}
