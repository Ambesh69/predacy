// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title IBatchVerifier
/// @notice Interface for the ZK proof verifier (generated from Noir circuit)
/// @dev In prototype: MockBatchVerifier always returns true.
///      In production: replace with nargo codegen-verifier output.
interface IBatchVerifier {
    /// @notice Verify a ZK proof that batch clearing was computed correctly
    /// @param proof The ZK proof bytes
    /// @param publicInputs Array of public inputs:
    ///   [0] = commitmentRoot   (merkle root of all order commitments)
    ///   [1] = clearingPrice    (6 decimal fixed point, e.g. 0.65 = 650000)
    ///   [2] = totalBuyVolume   (USDC, 6 decimals)
    ///   [3] = totalSellVolume  (USDC, 6 decimals)
    ///   [4] = netBuyAmount     (net USDC to spend on Polymarket, 6 decimals)
    /// @return True if proof is valid
    function verify(bytes calldata proof, bytes32[] calldata publicInputs) external view returns (bool);
}
