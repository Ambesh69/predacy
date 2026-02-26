// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title IConditionalTokens
/// @notice Minimal interface for Polymarket's Gnosis Conditional Token Framework
/// @dev Deployed at 0x4D97DCd97eC945f40cF65F87097ACe5EA0476045 on Polygon
interface IConditionalTokens {
    /// @notice Returns the ERC-1155 token ID for a position
    function getPositionId(address collateralToken, bytes32 collectionId) external pure returns (uint256);

    /// @notice Returns the collection ID for a set of outcome slots
    function getCollectionId(bytes32 parentCollectionId, bytes32 conditionId, uint256 indexSet)
        external
        pure
        returns (bytes32);

    /// @notice Returns the condition ID for a given oracle, questionId, and outcomeSlotCount
    function getConditionId(address oracle, bytes32 questionId, uint256 outcomeSlotCount)
        external
        pure
        returns (bytes32);

    /// @notice Splits a position — deposits collateral and mints outcome tokens
    function splitPosition(
        address collateralToken,
        bytes32 parentCollectionId,
        bytes32 conditionId,
        uint256[] calldata partition,
        uint256 amount
    ) external;

    /// @notice Merges positions — burns outcome tokens and withdraws collateral
    function mergePositions(
        address collateralToken,
        bytes32 parentCollectionId,
        bytes32 conditionId,
        uint256[] calldata partition,
        uint256 amount
    ) external;

    /// @notice Redeems positions after a condition has been resolved
    function redeemPositions(
        address collateralToken,
        bytes32 parentCollectionId,
        bytes32 conditionId,
        uint256[] calldata indexSets
    ) external;

    /// @notice Returns the payout numerator for an outcome slot after resolution
    function payoutNumerators(bytes32 conditionId, uint256 index) external view returns (uint256);

    /// @notice Returns the payout denominator for a condition after resolution
    function payoutDenominator(bytes32 conditionId) external view returns (uint256);

    /// @notice ERC-1155 balance query
    function balanceOf(address account, uint256 id) external view returns (uint256);

    /// @notice ERC-1155 batch transfer
    function safeTransferFrom(address from, address to, uint256 id, uint256 amount, bytes calldata data) external;

    /// @notice ERC-1155 approval
    function setApprovalForAll(address operator, bool approved) external;
}
