// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./interfaces/IBatchVerifier.sol";

/// @title MockBatchVerifier
/// @notice Prototype placeholder — always returns true.
///         Replace with the Noir-generated verifier for production.
contract MockBatchVerifier is IBatchVerifier {
    function verify(bytes calldata, bytes32[] calldata) external pure returns (bool) {
        return true;
    }
}
