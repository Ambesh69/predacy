// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ProxyWallet} from "./ProxyWallet.sol";

/// @title ProxyWalletFactory
/// @notice CREATE2 factory for deterministic ProxyWallet deployment.
///
/// ## Usage
///   1. Frontend calls `computeAddress(ephemeralEOA)` to get the wallet address
///      BEFORE deployment — Alice can fund this address via Railgun immediately.
///   2. When Alice is ready to commit, the Builder Relayer calls `deploy(ephemeralEOA)`.
///   3. From that point the proxy wallet can be used for all operations.
///
/// ## Determinism guarantee
///   salt = keccak256(abi.encode(owner))
///   wallet = CREATE2(factory, salt, ProxyWallet bytecode + owner)
///   → same owner always → same wallet address, on any EVM chain with this factory.
///
/// ## One wallet per owner
///   A single ephemeral EOA → single proxy wallet. Reuse attempts revert.

contract ProxyWalletFactory {

    // ── Events ────────────────────────────────────────────────────────────────

    event WalletDeployed(address indexed owner, address indexed wallet);

    // ── Errors ────────────────────────────────────────────────────────────────

    error AlreadyDeployed();

    // ── State ─────────────────────────────────────────────────────────────────

    /// @notice owner → proxy wallet address. Zero if not yet deployed.
    mapping(address => address) public walletOf;

    // ── Deployment ────────────────────────────────────────────────────────────

    /// @notice Deploy a ProxyWallet for `owner` (the ephemeral EOA).
    ///         Reverts if a wallet for this owner already exists.
    ///         The Builder Relayer pays deployment gas.
    /// @param owner Ephemeral EOA address (Alice's burner key).
    /// @return wallet The deployed ProxyWallet address.
    function deploy(address owner) external returns (address wallet) {
        if (walletOf[owner] != address(0)) revert AlreadyDeployed();

        bytes32 salt = _salt(owner);
        wallet = address(new ProxyWallet{salt: salt}(owner));

        walletOf[owner] = wallet;
        emit WalletDeployed(owner, wallet);
    }

    // ── Address Prediction ────────────────────────────────────────────────────

    /// @notice Predict the wallet address for `owner` before deployment.
    ///         Alice funds this address via Railgun BEFORE calling `deploy`.
    /// @param owner Ephemeral EOA address.
    /// @return The deterministic ProxyWallet address.
    function computeAddress(address owner) external view returns (address) {
        bytes32 salt = _salt(owner);
        bytes32 initCodeHash = keccak256(
            abi.encodePacked(type(ProxyWallet).creationCode, abi.encode(owner))
        );
        return address(uint160(uint256(keccak256(abi.encodePacked(
            bytes1(0xff),
            address(this),
            salt,
            initCodeHash
        )))));
    }

    // ── Internal ──────────────────────────────────────────────────────────────

    function _salt(address owner) internal pure returns (bytes32) {
        return keccak256(abi.encode(owner));
    }
}
