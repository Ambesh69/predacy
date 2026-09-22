// SPDX-License-Identifier: MIT
pragma solidity ^0.8.21;

import "forge-std/Test.sol";
import "../src/Verifier.sol";

contract ShieldedBuyBatchVerifierTest is Test {
    function test_realV12BuyBatchProofVerifies() public {
        HonkVerifier verifier = new HonkVerifier();
        string[] memory command = new string[](6);
        command[0] = "/usr/bin/env";
        command[1] = "BB_BACKEND=wasm";
        command[2] = "node";
        command[3] = "--import";
        command[4] = "../../relayer/node_modules/tsx/dist/loader.mjs";
        command[5] = "../../relayer/scripts/generateV12BuyBatchProof.ts";
        (bytes memory proof, bytes32[] memory publicInputs) = abi.decode(vm.ffi(command), (bytes, bytes32[]));

        assertEq(publicInputs.length, 20);
        assertTrue(verifier.verify(proof, publicInputs));
    }
}
