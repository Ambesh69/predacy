// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IBridgeERC20 {
    function balanceOf(address account) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
}

interface ICollateralOnramp {
    function wrap(address asset, address to, uint256 amount) external;
}

interface ICollateralOfframp {
    function unwrap(address asset, address to, uint256 amount) external;
}

/// @notice Atomic collateral conversion for a vault that holds USDC.e.
/// @dev The caller must authenticate the Deposit Wallet and serialize each batch.
///      These functions do not verify CLOB fills or authorize settlement.
library PolymarketCollateralBridge {
    error ZeroAmount();
    error ZeroWallet();
    error ApprovalFailed();
    error IncorrectBalanceDelta();

    function wrapToDepositWallet(
        IBridgeERC20 usdce,
        IBridgeERC20 pusd,
        ICollateralOnramp onramp,
        address depositWallet,
        uint256 amount
    ) internal {
        if (amount == 0) revert ZeroAmount();
        if (depositWallet == address(0)) revert ZeroWallet();

        uint256 usdceBefore = usdce.balanceOf(address(this));
        uint256 pusdBefore = pusd.balanceOf(depositWallet);
        _approveExact(usdce, address(onramp), amount);
        onramp.wrap(address(usdce), depositWallet, amount);

        if (usdceBefore < amount || usdce.balanceOf(address(this)) != usdceBefore - amount) {
            revert IncorrectBalanceDelta();
        }
        if (pusd.balanceOf(depositWallet) != pusdBefore + amount) revert IncorrectBalanceDelta();
    }

    function unwrapToVault(
        IBridgeERC20 usdce,
        IBridgeERC20 pusd,
        ICollateralOfframp offramp,
        uint256 amount
    ) internal {
        if (amount == 0) revert ZeroAmount();

        uint256 pusdBefore = pusd.balanceOf(address(this));
        uint256 usdceBefore = usdce.balanceOf(address(this));
        _approveExact(pusd, address(offramp), amount);
        offramp.unwrap(address(usdce), address(this), amount);

        if (pusdBefore < amount || pusd.balanceOf(address(this)) != pusdBefore - amount) {
            revert IncorrectBalanceDelta();
        }
        if (usdce.balanceOf(address(this)) != usdceBefore + amount) revert IncorrectBalanceDelta();
    }

    function _approveExact(IBridgeERC20 token, address spender, uint256 amount) private {
        if (!token.approve(spender, 0) || !token.approve(spender, amount)) revert ApprovalFailed();
    }
}
