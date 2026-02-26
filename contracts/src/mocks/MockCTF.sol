// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../interfaces/IConditionalTokens.sol";

/// @title MockCTF
/// @notice Minimal mock of Polymarket's Gnosis Conditional Token Framework
///         for use on Polygon Amoy testnet. Implements the IConditionalTokens
///         interface so BatchVault compiles and deploys correctly.
///
/// In the testnet demo we only reach settlement if the relayer is running,
/// so the critical path is: splitPosition (mints YES+NO tokens to BatchVault)
/// and safeTransferFrom (sends YES tokens to users on claim).
contract MockCTF is IConditionalTokens {

    // ERC-1155 style balance store: account => tokenId => balance
    mapping(address => mapping(uint256 => uint256)) private _balances;

    // ERC-1155 operator approvals
    mapping(address => mapping(address => bool)) private _operatorApprovals;

    event TransferSingle(
        address indexed operator,
        address indexed from,
        address indexed to,
        uint256 id,
        uint256 value
    );

    // ── IConditionalTokens — pure view functions ──────────────────────────────
    // These replicate the same deterministic math used by the real Gnosis CTF.

    function getCollectionId(
        bytes32 parentCollectionId,
        bytes32 conditionId,
        uint256 indexSet
    ) external pure override returns (bytes32) {
        return keccak256(abi.encodePacked(parentCollectionId, conditionId, indexSet));
    }

    function getPositionId(
        address collateralToken,
        bytes32 collectionId
    ) external pure override returns (uint256) {
        return uint256(keccak256(abi.encodePacked(collateralToken, collectionId)));
    }

    function getConditionId(
        address oracle,
        bytes32 questionId,
        uint256 outcomeSlotCount
    ) external pure override returns (bytes32) {
        return keccak256(abi.encodePacked(oracle, questionId, outcomeSlotCount));
    }

    // ── IConditionalTokens — state-mutating functions ─────────────────────────

    /// @notice Pulls USDC from msg.sender and mints YES + NO tokens.
    ///         Partition[0] = YES index set, partition[1] = NO index set.
    function splitPosition(
        address collateralToken,
        bytes32 parentCollectionId,
        bytes32 conditionId,
        uint256[] calldata partition,
        uint256 amount
    ) external override {
        // Pull collateral from caller (BatchVault approves this)
        _pullERC20(collateralToken, msg.sender, amount);

        // Mint outcome tokens for each partition slot
        for (uint256 i = 0; i < partition.length; i++) {
            bytes32 collectionId = keccak256(
                abi.encodePacked(parentCollectionId, conditionId, partition[i])
            );
            uint256 tokenId = uint256(
                keccak256(abi.encodePacked(collateralToken, collectionId))
            );
            _balances[msg.sender][tokenId] += amount;
            emit TransferSingle(msg.sender, address(0), msg.sender, tokenId, amount);
        }
    }

    /// @notice Burns outcome tokens and returns collateral (not used in testnet demo).
    function mergePositions(
        address,
        bytes32,
        bytes32,
        uint256[] calldata,
        uint256
    ) external pure override {
        revert("MockCTF: mergePositions not implemented");
    }

    /// @notice Redeems resolved positions (not used in testnet demo).
    function redeemPositions(
        address,
        bytes32,
        bytes32,
        uint256[] calldata
    ) external pure override {
        revert("MockCTF: redeemPositions not implemented");
    }

    // ── ERC-1155 ──────────────────────────────────────────────────────────────

    function balanceOf(address account, uint256 id)
        external view override returns (uint256)
    {
        return _balances[account][id];
    }

    function safeTransferFrom(
        address from,
        address to,
        uint256 id,
        uint256 amount,
        bytes calldata
    ) external override {
        require(
            from == msg.sender || _operatorApprovals[from][msg.sender],
            "MockCTF: not approved"
        );
        require(_balances[from][id] >= amount, "MockCTF: insufficient balance");
        _balances[from][id]  -= amount;
        _balances[to][id]    += amount;
        emit TransferSingle(msg.sender, from, to, id, amount);
    }

    function setApprovalForAll(address operator, bool approved) external override {
        _operatorApprovals[msg.sender][operator] = approved;
    }

    // ── Payout stubs (required by interface, not used in demo) ────────────────

    function payoutNumerators(bytes32, uint256) external pure override returns (uint256) {
        return 0;
    }

    function payoutDenominator(bytes32) external pure override returns (uint256) {
        return 0;
    }

    // ── Internal ─────────────────────────────────────────────────────────────

    function _pullERC20(address token, address from, uint256 amount) internal {
        (bool ok, bytes memory data) = token.call(
            abi.encodeWithSignature("transferFrom(address,address,uint256)", from, address(this), amount)
        );
        require(ok && (data.length == 0 || abi.decode(data, (bool))), "MockCTF: transferFrom failed");
    }
}
