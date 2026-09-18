// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/SettlementAccounting.sol";

contract SettlementAccountingTest is Test {
    function validate(
        SettlementAccounting.Allocation[] memory orders,
        uint256 splitShares,
        uint256 mergedShares,
        SettlementAccounting.Execution memory execution
    ) external pure returns (SettlementAccounting.Assets memory) {
        return SettlementAccounting.validate(orders, splitShares, mergedShares, execution);
    }

    function test_internalMatch() public view {
        SettlementAccounting.Allocation[] memory orders = new SettlementAccounting.Allocation[](2);
        orders[0] = SettlementAccounting.Allocation(
            SettlementAccounting.Side.YES_BUY, 600_000, 700_000, 1_000_000, 600_000, 0
        );
        orders[1] = SettlementAccounting.Allocation(
            SettlementAccounting.Side.YES_SELL, 1_000_000, 500_000, 1_000_000, 600_000, 0
        );
        SettlementAccounting.Assets memory assets = this.validate(
            orders, 0, 0, _emptyExecution()
        );
        assertEq(assets.usdc, 600_000);
        assertEq(assets.yes, 1_000_000);
        assertEq(assets.no, 0);
    }

    function test_externalNoBuyWithFeeAndRefund() public view {
        SettlementAccounting.Allocation[] memory orders = new SettlementAccounting.Allocation[](1);
        orders[0] = SettlementAccounting.Allocation(
            SettlementAccounting.Side.NO_BUY, 410_000, 420_000, 1_000_000, 405_000, 5_000
        );
        SettlementAccounting.Execution memory execution = _emptyExecution();
        execution.usdcSpent = 405_000;
        execution.noBought = 1_000_000;
        SettlementAccounting.Assets memory assets = this.validate(orders, 0, 0, execution);
        assertEq(assets.usdc, 5_000);
        assertEq(assets.no, 1_000_000);
    }

    function test_splitAndMergeConserveAssets() public view {
        SettlementAccounting.Allocation[] memory orders = new SettlementAccounting.Allocation[](4);
        orders[0] = SettlementAccounting.Allocation(
            SettlementAccounting.Side.YES_BUY, 600_000, 700_000, 1_000_000, 600_000, 0
        );
        orders[1] = SettlementAccounting.Allocation(
            SettlementAccounting.Side.NO_BUY, 400_000, 450_000, 1_000_000, 400_000, 0
        );
        orders[2] = SettlementAccounting.Allocation(
            SettlementAccounting.Side.YES_SELL, 1_000_000, 550_000, 1_000_000, 600_000, 0
        );
        orders[3] = SettlementAccounting.Allocation(
            SettlementAccounting.Side.NO_SELL, 1_000_000, 350_000, 1_000_000, 400_000, 0
        );
        SettlementAccounting.Assets memory assets = this.validate(
            orders, 1_000_000, 1_000_000, _emptyExecution()
        );
        assertEq(assets.usdc, 1_000_000);
        assertEq(assets.yes, 1_000_000);
        assertEq(assets.no, 1_000_000);
    }

    function test_rejectsRelayerSubsidy() public {
        SettlementAccounting.Allocation[] memory orders = new SettlementAccounting.Allocation[](1);
        orders[0] = SettlementAccounting.Allocation(
            SettlementAccounting.Side.YES_BUY, 600_000, 700_000, 1_000_000, 600_000, 0
        );
        SettlementAccounting.Execution memory execution = _emptyExecution();
        execution.usdcSpent = 610_000;
        execution.yesBought = 1_000_000;
        vm.expectRevert(abi.encodeWithSelector(SettlementAccounting.AssetDeficit.selector, uint8(0)));
        this.validate(orders, 0, 0, execution);
    }

    function test_rejectsBuyerPriceAboveLimit() public {
        SettlementAccounting.Allocation[] memory orders = new SettlementAccounting.Allocation[](1);
        orders[0] = SettlementAccounting.Allocation(
            SettlementAccounting.Side.NO_BUY, 450_000, 400_000, 1_000_000, 450_000, 0
        );
        vm.expectRevert(abi.encodeWithSelector(SettlementAccounting.LimitViolated.selector, uint256(0)));
        this.validate(orders, 0, 0, _emptyExecution());
    }

    function test_rejectsMissingSellerProceeds() public {
        SettlementAccounting.Allocation[] memory orders = new SettlementAccounting.Allocation[](1);
        orders[0] = SettlementAccounting.Allocation(
            SettlementAccounting.Side.YES_SELL, 1_000_000, 550_000, 1_000_000, 570_000, 0
        );
        SettlementAccounting.Execution memory execution = _emptyExecution();
        execution.yesSold = 1_000_000;
        execution.usdcReceived = 560_000;
        vm.expectRevert(abi.encodeWithSelector(SettlementAccounting.AssetMismatch.selector, uint8(0)));
        this.validate(orders, 0, 0, execution);
    }

    function testFuzz_buyCostAndRefundConserve(uint64 depositRaw, uint64 costRaw, uint64 sharesRaw) public view {
        uint256 deposit = bound(uint256(depositRaw), 1, 1_000_000_000);
        uint256 cost = bound(uint256(costRaw), 1, deposit);
        uint256 shares = bound(uint256(sharesRaw), cost + 1, 2_000_000_000);
        uint256 limit = (cost * 1_000_000 + shares - 1) / shares;
        vm.assume(limit > 0 && limit < 1_000_000);

        SettlementAccounting.Allocation[] memory orders = new SettlementAccounting.Allocation[](1);
        orders[0] = SettlementAccounting.Allocation(
            SettlementAccounting.Side.YES_BUY, deposit, limit, shares, cost, deposit - cost
        );
        SettlementAccounting.Execution memory execution = _emptyExecution();
        execution.usdcSpent = cost;
        execution.yesBought = shares;

        SettlementAccounting.Assets memory assets = this.validate(orders, 0, 0, execution);
        assertEq(assets.usdc, deposit - cost);
        assertEq(assets.yes, shares);
    }

    function test_rejectsUnallocatedSurplus() public {
        SettlementAccounting.Allocation[] memory orders = new SettlementAccounting.Allocation[](1);
        orders[0] = SettlementAccounting.Allocation(
            SettlementAccounting.Side.YES_BUY, 600_000, 700_000, 1_000_000, 600_000, 0
        );
        SettlementAccounting.Execution memory execution = _emptyExecution();
        execution.usdcSpent = 590_000;
        execution.yesBought = 1_000_000;
        vm.expectRevert(abi.encodeWithSelector(SettlementAccounting.AssetMismatch.selector, uint8(0)));
        this.validate(orders, 0, 0, execution);
    }

    function _emptyExecution() private pure returns (SettlementAccounting.Execution memory) {
        return SettlementAccounting.Execution(0, 0, 0, 0, 0, 0);
    }
}
