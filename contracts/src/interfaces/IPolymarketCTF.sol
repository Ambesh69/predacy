// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title IPolymarketCTF
/// @notice Minimal interface for Polymarket's CTF Exchange
/// @dev Deployed at 0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E on Polygon
interface IPolymarketCTF {
    /// @notice Order struct matching Polymarket's CLOB format
    struct Order {
        uint256 salt;           // Unique order salt
        address maker;          // Order creator
        address signer;         // Order signer (can differ from maker for API keys)
        address taker;          // Allowed taker (0 = anyone)
        uint256 tokenId;        // CTF ERC-1155 token ID (YES or NO share)
        uint256 makerAmount;    // Amount of collateral (USDC) maker provides
        uint256 takerAmount;    // Amount of outcome tokens maker wants
        uint256 expiration;     // Unix timestamp (0 = no expiry)
        uint256 nonce;          // Maker nonce for order cancellation
        uint256 feeRateBps;     // Fee rate in basis points
        uint8 side;             // 0 = BUY, 1 = SELL
        uint8 signatureType;    // 0 = EOA, 1 = POLY_PROXY, 2 = POLY_GNOSIS_SAFE
        bytes signature;        // EIP-712 signature
    }

    /// @notice Fill multiple orders atomically
    function fillOrders(Order[] calldata orders, uint256[] calldata fillAmounts) external;

    /// @notice Fill a single order
    function fillOrder(Order calldata order, uint256 fillAmount) external;

    /// @notice Cancel an order
    function cancelOrder(Order calldata order) external;

    /// @notice Get the filled amount for an order hash
    function getOrderStatus(bytes32 orderHash) external view returns (bool isFilledOrCancelled, uint256 remaining);
}
