// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import {HonkVerifier} from "../src/Verifier.sol";

contract DeployVerifier is Script {
    function run() external returns (HonkVerifier verifier) {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(deployerKey);
        verifier = new HonkVerifier();
        vm.stopBroadcast();
        require(address(verifier).code.length > 0, "v12: verifier deployment failed");
        console.log("HonkVerifier:", address(verifier));
    }
}
