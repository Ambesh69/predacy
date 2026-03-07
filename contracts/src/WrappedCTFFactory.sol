// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {WrappedCTFToken} from "./WrappedCTFToken.sol";

/// @title WrappedCTFFactory
/// @notice CREATE2 factory for deterministic WrappedCTFToken deployment.
///
/// ## Usage (per market, called once at market creation)
///   factory.deploy(ctf, yesTokenId, "Wrapped YES: Chelsea EPL", "wYES-CHELSEA")
///   factory.deploy(ctf, noTokenId,  "Wrapped NO: Chelsea EPL",  "wNO-CHELSEA")
///
/// ## Address prediction (before funding)
///   factory.computeAddress(ctf, yesTokenId)  → wYES token address
///   factory.computeAddress(ctf, noTokenId)   → wNO token address
///
/// ## Uniqueness
///   salt = keccak256(abi.encode(ctf, positionId))
///   → each (ctf, positionId) pair has exactly one wrapper address, ever.

contract WrappedCTFFactory {

    // ── Events ────────────────────────────────────────────────────────────────

    event WrapperDeployed(
        address indexed ctf,
        uint256 indexed positionId,
        address         wrapper,
        string          symbol
    );

    // ── Errors ────────────────────────────────────────────────────────────────

    error AlreadyDeployed();

    // ── State ─────────────────────────────────────────────────────────────────

    /// @notice (ctf, positionId) → WrappedCTFToken address. Zero if not yet deployed.
    mapping(address => mapping(uint256 => address)) public wrapperOf;

    // ── Deployment ────────────────────────────────────────────────────────────

    /// @notice Deploy a WrappedCTFToken for a (ctf, positionId) pair.
    /// @param ctf        Address of the Gnosis CTF ERC-1155 contract.
    /// @param positionId ERC-1155 token ID of the position to wrap.
    /// @param name       Full name, e.g. "Wrapped YES: Chelsea EPL".
    /// @param symbol     Short ticker, e.g. "wYES" or "wNO".
    /// @return wrapper   Deployed WrappedCTFToken address.
    function deploy(
        address ctf,
        uint256 positionId,
        string  calldata name,
        string  calldata symbol
    ) external returns (address wrapper) {
        if (wrapperOf[ctf][positionId] != address(0)) revert AlreadyDeployed();

        bytes32 salt = _salt(ctf, positionId);
        wrapper = address(
            new WrappedCTFToken{salt: salt}(ctf, positionId, name, symbol)
        );

        wrapperOf[ctf][positionId] = wrapper;
        emit WrapperDeployed(ctf, positionId, wrapper, symbol);
    }

    // ── Address Prediction ────────────────────────────────────────────────────

    /// @notice Predict the wrapper address for a (ctf, positionId) pair.
    ///         Works whether or not the wrapper has been deployed yet.
    ///         NOTE: requires `name` and `symbol` to match the eventual deploy call
    ///         because they are abi-encoded into the init code.
    ///         For simple lookup when wrapper is already deployed, prefer `wrapperOf`.
    function computeAddress(
        address ctf,
        uint256 positionId,
        string  calldata name,
        string  calldata symbol
    ) external view returns (address) {
        bytes32 salt = _salt(ctf, positionId);
        bytes32 initCodeHash = keccak256(abi.encodePacked(
            type(WrappedCTFToken).creationCode,
            abi.encode(ctf, positionId, name, symbol)
        ));
        return address(uint160(uint256(keccak256(abi.encodePacked(
            bytes1(0xff),
            address(this),
            salt,
            initCodeHash
        )))));
    }

    // ── Internal ──────────────────────────────────────────────────────────────

    function _salt(address ctf, uint256 positionId) internal pure returns (bytes32) {
        return keccak256(abi.encode(ctf, positionId));
    }
}
