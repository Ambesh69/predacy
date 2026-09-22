// SPDX-License-Identifier: MIT
pragma solidity ^0.8.21;

import "forge-std/Script.sol";
import {HonkVerifier} from "../src/Verifier.sol";

/// @notice Deploys the generated allocation verifier; this does not enable trading.
contract DeployAllocationV11Verifier is Script {
    function run() external returns (HonkVerifier verifier) {
        require(block.chainid == 137, "v11 verifier: Polygon mainnet only");
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(deployerKey);
        verifier = new HonkVerifier();
        vm.stopBroadcast();
        console.log("Allocation v11 verifier:", address(verifier));
    }
}
