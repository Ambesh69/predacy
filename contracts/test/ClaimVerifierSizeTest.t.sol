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
        // Polygon PoS PIP-30 raised the runtime code limit to 32 KiB.
        assertLe(size, 32768, "ClaimHonkVerifier must fit Polygon PoS code-size limit");
    }
}
