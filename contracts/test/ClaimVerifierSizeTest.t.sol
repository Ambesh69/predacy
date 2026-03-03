// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
import "forge-std/Test.sol";
import "../src/ClaimVerifier.sol";

contract ClaimVerifierSizeTest is Test {
    ClaimHonkVerifier public verifier;
    function setUp() public { verifier = new ClaimHonkVerifier(); }
    function test_size() public {
        address v = address(verifier);
        uint256 size;
        assembly { size := extcodesize(v) }
        emit log_named_uint("ClaimHonkVerifier size (bytes)", size);
        assertLt(size, 24576, "ClaimHonkVerifier must be under EIP-170 limit");
    }
}
