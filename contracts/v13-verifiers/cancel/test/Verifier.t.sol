// SPDX-License-Identifier: MIT
pragma solidity ^0.8.21;

import "forge-std/Test.sol";
import "../src/Verifier.sol";

contract V13CancelVerifierTest is Test {
    function testRealCancelProofVerifies() public {
        HonkVerifier verifier = new HonkVerifier();
        string[] memory command = new string[](6);
        command[0] = "/usr/bin/env"; command[1] = "node"; command[2] = "--import";
        command[3] = "../../../relayer/node_modules/tsx/dist/loader.mjs";
        command[4] = "../../../relayer/scripts/generateV13Proof.ts"; command[5] = "cancel";
        (bytes memory proof, bytes32[] memory inputs) = abi.decode(vm.ffi(command), (bytes, bytes32[]));
        assertEq(inputs.length, 9); assertTrue(verifier.verify(proof, inputs));
    }
}
