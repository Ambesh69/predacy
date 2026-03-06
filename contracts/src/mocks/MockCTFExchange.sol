// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../interfaces/IPolymarketCTF.sol";

/// @title MockCTFExchange
/// @notice Minimal no-op stub of Polymarket's CTFExchange for unit tests.
///         The vault approves this contract in its constructor (USDC + CTF setApprovalForAll).
///         Tests pass empty clobOrders[], so fillOrders is never called.
///         YES tokens are pre-minted to the vault in setUp() for claim tests.
contract MockCTFExchange {
    function fillOrders(IPolymarketCTF.Order[] calldata, uint256[] calldata) external {}
    function fillOrder(IPolymarketCTF.Order calldata, uint256) external {}
}
