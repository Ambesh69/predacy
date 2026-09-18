// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

library SettlementAccounting {
    uint256 internal constant PRICE_SCALE = 1_000_000;

    enum Side { YES_BUY, YES_SELL, NO_BUY, NO_SELL }

    struct Allocation {
        Side side;
        uint256 deposit;
        uint256 limitPrice;
        uint256 filledShares;
        uint256 usdcPayout;
        uint256 refund;
    }

    struct Execution {
        uint256 usdcSpent;
        uint256 usdcReceived;
        uint256 yesBought;
        uint256 yesSold;
        uint256 noBought;
        uint256 noSold;
    }

    struct Assets {
        uint256 usdc;
        uint256 yes;
        uint256 no;
    }

    error InvalidLimit(uint256 orderIndex);
    error InvalidAllocation(uint256 orderIndex);
    error LimitViolated(uint256 orderIndex);
    error AssetDeficit(uint8 asset);
    error AssetMismatch(uint8 asset);

    function validate(
        Allocation[] memory orders,
        uint256 splitShares,
        uint256 mergedShares,
        Execution memory execution
    ) internal pure returns (Assets memory available) {
        return _validate(orders, splitShares, mergedShares, execution, true);
    }

    /// @dev Use only after a verifier has checked each order's hidden committed limit.
    function validateProven(
        Allocation[] memory orders,
        uint256 splitShares,
        uint256 mergedShares,
        Execution memory execution
    ) internal pure returns (Assets memory available) {
        return _validate(orders, splitShares, mergedShares, execution, false);
    }

    function _validate(
        Allocation[] memory orders,
        uint256 splitShares,
        uint256 mergedShares,
        Execution memory execution,
        bool enforcePublicLimit
    ) private pure returns (Assets memory available) {
        Assets memory escrow;
        Assets memory claims;

        for (uint256 i = 0; i < orders.length; i++) {
            Allocation memory order = orders[i];
            if (enforcePublicLimit && (order.limitPrice == 0 || order.limitPrice >= PRICE_SCALE)) {
                revert InvalidLimit(i);
            }

            if (order.side == Side.YES_BUY || order.side == Side.NO_BUY) {
                escrow.usdc += order.deposit;
                if (order.usdcPayout + order.refund != order.deposit) revert InvalidAllocation(i);
                if ((order.filledShares == 0) != (order.usdcPayout == 0)) revert InvalidAllocation(i);
                if (enforcePublicLimit &&
                    order.usdcPayout * PRICE_SCALE > order.filledShares * order.limitPrice) revert LimitViolated(i);
                claims.usdc += order.refund;
                if (order.side == Side.YES_BUY) claims.yes += order.filledShares;
                else claims.no += order.filledShares;
            } else {
                if (order.side == Side.YES_SELL) escrow.yes += order.deposit;
                else escrow.no += order.deposit;
                if (order.filledShares + order.refund != order.deposit) revert InvalidAllocation(i);
                if ((order.filledShares == 0) != (order.usdcPayout == 0)) revert InvalidAllocation(i);
                if (enforcePublicLimit &&
                    order.usdcPayout * PRICE_SCALE < order.filledShares * order.limitPrice) revert LimitViolated(i);
                claims.usdc += order.usdcPayout;
                if (order.side == Side.YES_SELL) claims.yes += order.refund;
                else claims.no += order.refund;
            }
        }

        available.usdc = _net(
            escrow.usdc + mergedShares + execution.usdcReceived,
            splitShares + execution.usdcSpent,
            0
        );
        available.yes = _net(
            escrow.yes + splitShares + execution.yesBought,
            mergedShares + execution.yesSold,
            1
        );
        available.no = _net(
            escrow.no + splitShares + execution.noBought,
            mergedShares + execution.noSold,
            2
        );

        if (available.usdc != claims.usdc) revert AssetMismatch(0);
        if (available.yes != claims.yes) revert AssetMismatch(1);
        if (available.no != claims.no) revert AssetMismatch(2);
    }

    function _net(uint256 credit, uint256 debit, uint8 asset) private pure returns (uint256) {
        if (debit > credit) revert AssetDeficit(asset);
        return credit - debit;
    }
}
