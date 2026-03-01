// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./interfaces/IBatchVerifier.sol";

/// @title PublicInputAdapter
/// @notice Adapts BatchVault's 6-input format to the 37-input HonkVerifier format.
///
/// Background
/// ----------
/// The Noir circuit (MAX_ORDERS=8, ultra_honk) has 37 public inputs:
///   [0..31] commitmentRoot bytes  -- each byte as its own field element (value 0-255)
///   [32]    clearingPrice
///   [33]    totalBuyVol
///   [34]    totalSellVol
///   [35]    netBuyAmount
///   [36]    orderCount            -- number of real (non-padding) orders
///
/// BatchVault.settleBatch() builds only 6 public inputs:
///   [0]  commitmentRoot (full bytes32 -- not byte-expanded)
///   [1]  clearingPrice
///   [2]  totalBuyVol
///   [3]  totalSellVol
///   [4]  netBuyAmount
///   [5]  netSellYes               -- NOT a circuit public input (ignored here)
///
/// This adapter:
///   1. Expands inputs[0] (bytes32) into 32 individual byte field elements
///   2. Passes scalars [1..4] through unchanged
///   3. Appends orderCount from pendingOrderCount (set by relayer before each settleBatch)
///
/// Workflow
/// --------
/// Before every real-ZK settleBatch call, the relayer calls:
///   adapter.setPendingOrderCount(n)
/// where n = batch.commitmentCount (the on-chain number of orders in the batch).
/// Then settleBatch proceeds as normal; this adapter converts the 6 inputs to 37.
///
/// Security note
/// -------------
/// setPendingOrderCount is restricted to the relayer (owner). The relayer is the
/// only entity that can call settleBatch on BatchVault anyway, so this adds no
/// new trust surface. The commitment_root already cryptographically binds the
/// order count -- an incorrect orderCount would cause proof verification to fail.
contract PublicInputAdapter is IBatchVerifier {
    IBatchVerifier public immutable honk;
    address public immutable owner;

    /// @notice orderCount to use for the next verify() call.
    ///         Relayer must call setPendingOrderCount(n) before each settleBatch().
    uint256 public pendingOrderCount;

    /// @param _honk  Address of the real 37-input HonkVerifier
    /// @param _owner Relayer wallet address (only address permitted to call setPendingOrderCount)
    constructor(address _honk, address _owner) {
        honk  = IBatchVerifier(_honk);
        owner = _owner;
    }

    /// @notice Relayer calls this immediately before settleBatch() to supply orderCount.
    /// @param n  Number of real (non-padding) orders in the batch being settled.
    function setPendingOrderCount(uint256 n) external {
        require(msg.sender == owner, "PublicInputAdapter: not owner");
        pendingOrderCount = n;
    }

    /// @inheritdoc IBatchVerifier
    /// @dev Receives 6-element publicInputs from BatchVault, converts to 37-element
    ///      array expected by the HonkVerifier, then delegates.
    ///
    ///      Input layout from BatchVault (inputs.length == 6):
    ///        [0] commitmentRoot (bytes32)
    ///        [1] clearingPrice
    ///        [2] totalBuyVol
    ///        [3] totalSellVol
    ///        [4] netBuyAmount
    ///        [5] netSellYes        <- ignored (not in circuit)
    ///
    ///      Output layout for HonkVerifier (37 elements):
    ///        [0..31] commitmentRoot bytes (one field element per byte)
    ///        [32]    clearingPrice
    ///        [33]    totalBuyVol
    ///        [34]    totalSellVol
    ///        [35]    netBuyAmount
    ///        [36]    orderCount    <- from pendingOrderCount
    function verify(bytes calldata proof, bytes32[] calldata inputs)
        external
        view
        override
        returns (bool)
    {
        require(inputs.length == 6, "PublicInputAdapter: expected 6 inputs");

        bytes32[] memory real = new bytes32[](37);

        // Expand commitment root: bytes32 -> 32 field elements (one byte each, big-endian)
        // Matches zkProver.ts: _hexToBytes(commitmentRoot, 32) where byte 0 is MSB
        bytes32 root = inputs[0];
        for (uint256 i = 0; i < 32; i++) {
            // Extract byte i (0 = most significant) and store as a 32-byte field element
            real[i] = bytes32(uint256(uint8(root[i])));
        }

        // Scalar public inputs pass through unchanged
        real[32] = inputs[1]; // clearingPrice
        real[33] = inputs[2]; // totalBuyVol
        real[34] = inputs[3]; // totalSellVol
        real[35] = inputs[4]; // netBuyAmount
        // inputs[5] = netSellYes -> NOT a circuit public input, skipped

        // Order count supplied by relayer via setPendingOrderCount()
        real[36] = bytes32(pendingOrderCount);

        return honk.verify(proof, real);
    }
}
