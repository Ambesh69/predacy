// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./PolymarketCollateralBridge.sol";

interface IShieldedAdapterERC20 is IBridgeERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
}

/// @notice Narrow custody bridge between ShieldedPoolV1 and one dedicated Polymarket Deposit Wallet.
/// @dev The relayer submits the aggregate CLOB order from `depositWallet`. Individual private orders
///      never reach this contract or the CLOB. Returned pUSD must be withdrawn here; returned outcome
///      tokens are withdrawn directly from the Deposit Wallet to the pool before settlement.
contract ShieldedPolymarketAdapter {
    IShieldedAdapterERC20 public immutable usdce;
    IBridgeERC20 public immutable pusd;
    ICollateralOnramp public immutable onramp;
    ICollateralOfframp public immutable offramp;
    address public pool;
    address public immutable operator;
    address public immutable guardian;
    address public immutable depositWallet;
    address public immutable binder;

    event BuyRouted(uint256 indexed positionTokenId, uint256 amount);
    event CollateralReturned(uint256 amount);
    event PoolBound(address indexed pool);

    error OnlyPool();
    error OnlyOperator();
    error OnlyGuardian();
    error InvalidInput();
    error TransferFailed();

    constructor(
        IShieldedAdapterERC20 usdce_,
        IBridgeERC20 pusd_,
        ICollateralOnramp onramp_,
        ICollateralOfframp offramp_,
        address operator_,
        address guardian_,
        address depositWallet_
    ) {
        if (
            address(usdce_) == address(0) || address(pusd_) == address(0) || address(onramp_) == address(0)
                || address(offramp_) == address(0) || operator_ == address(0)
                || guardian_ == address(0) || depositWallet_ == address(0)
        ) revert InvalidInput();
        usdce = usdce_;
        pusd = pusd_;
        onramp = onramp_;
        offramp = offramp_;
        operator = operator_;
        guardian = guardian_;
        depositWallet = depositWallet_;
        binder = msg.sender;
    }

    /// @notice One-time deployment handshake so the adapter can be deployed before its pool.
    function bindPool(address pool_) external {
        if (msg.sender != binder) revert OnlyGuardian();
        if (pool != address(0) || pool_ == address(0)) revert InvalidInput();
        pool = pool_;
        emit PoolBound(pool_);
    }

    function routeBuy(uint256 collateralAmount, uint256 positionTokenId) external {
        if (msg.sender != pool) revert OnlyPool();
        if (positionTokenId == 0) revert InvalidInput();
        PolymarketCollateralBridge.wrapToDepositWallet(usdce, pusd, onramp, depositWallet, collateralAmount);
        emit BuyRouted(positionTokenId, collateralAmount);
    }

    /// @notice Convert pUSD returned by the Deposit Wallet and send exact USDC.e back to the pool.
    function returnPusd(uint256 amount) external {
        if (msg.sender != operator && msg.sender != guardian) revert OnlyOperator();
        PolymarketCollateralBridge.unwrapToVault(usdce, pusd, offramp, amount);
        if (!usdce.transfer(pool, amount)) revert TransferFailed();
        emit CollateralReturned(amount);
    }

    /// @notice Recover unsolicited or residual USDC.e only to the pool, never to an operator wallet.
    function sweepUsdceToPool(uint256 amount) external {
        if (msg.sender != guardian) revert OnlyGuardian();
        if (amount == 0 || !usdce.transfer(pool, amount)) revert TransferFailed();
        emit CollateralReturned(amount);
    }
}
