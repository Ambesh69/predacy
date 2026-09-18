// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";

interface IDeployedClaimVerifier {
    function verify(bytes calldata proof, bytes32[] calldata publicInputs) external view returns (bool);
}

contract DeployedClaimVerifierForkTest is Test {
    // Read from BatchVault.claimVerifier() on Polygon mainnet.
    address constant CLAIM_VERIFIER = 0xA50409A331E3CA9Db7fDfB96028BAeFF3AF48bBd;

    function test_freshProofVerifiesOnActiveMainnetVerifier() public {
        if (CLAIM_VERIFIER.code.length == 0) vm.skip(true);

        string[] memory args = new string[](4);
        args[0] = "node";
        args[1] = "--import";
        args[2] = "../relayer/node_modules/tsx/dist/loader.mjs";
        args[3] = "../relayer/scripts/generateClaimProof.ts";
        (bytes memory proof, bytes32[] memory publicInputs) =
            abi.decode(vm.ffi(args), (bytes, bytes32[]));

        assertEq(publicInputs.length, 11);
        assertTrue(IDeployedClaimVerifier(CLAIM_VERIFIER).verify(proof, publicInputs));
    }
}
