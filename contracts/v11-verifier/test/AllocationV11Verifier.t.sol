// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import {HonkVerifier as AllocationVerifier} from "../src/Verifier.sol";

contract AllocationV11VerifierTest is Test {
    AllocationVerifier verifier;

    function setUp() public {
        verifier = new AllocationVerifier();
    }

    function test_runtimeFitsEvmLimit() public view {
        assertLt(address(verifier).code.length, 24_576);
    }

    function test_realPartialNoBuyProof() public {
        (bytes memory initialProof, bytes32[] memory initialInputs, bytes memory proof, bytes32[] memory inputs) =
            _proofs();
        assertTrue(verifier.verify(initialProof, initialInputs));
        assertEq(initialInputs.length, 9);
        assertEq(uint256(initialInputs[6]), 0);
        assertEq(uint256(initialInputs[7]), 0);
        assertEq(uint256(initialInputs[8]), 410_000);
        assertEq(inputs.length, 9);
        assertEq(uint256(inputs[4]), 2); // NO_BUY
        assertEq(uint256(inputs[5]), 410_000); // deposit
        assertEq(uint256(inputs[6]), 1_000_000); // shares
        assertEq(uint256(inputs[7]), 405_000); // actual USDC spent
        assertEq(uint256(inputs[8]), 5_000); // refund
        assertTrue(verifier.verify(proof, inputs));
    }

    function _proofs() private returns (bytes memory, bytes32[] memory, bytes memory, bytes32[] memory) {
        string[] memory args = new string[](4);
        args[0] = "node";
        args[1] = "--import";
        args[2] = "../../relayer/node_modules/tsx/dist/loader.mjs";
        args[3] = "../../relayer/scripts/generateAllocationProof.ts";
        return abi.decode(vm.ffi(args), (bytes, bytes32[], bytes, bytes32[]));
    }
}
