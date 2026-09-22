// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/ShieldedPolymarketAdapter.sol";
import "../src/mocks/MockUSDC.sol";

contract ShieldedAdapterOnramp is ICollateralOnramp {
    MockUSDC private immutable usdce;
    MockUSDC private immutable pusd;

    constructor(MockUSDC usdce_, MockUSDC pusd_) {
        usdce = usdce_;
        pusd = pusd_;
    }

    function wrap(address asset, address to, uint256 amount) external {
        require(asset == address(usdce));
        usdce.transferFrom(msg.sender, address(this), amount);
        pusd.mint(to, amount);
    }
}

contract ShieldedAdapterOfframp is ICollateralOfframp {
    MockUSDC private immutable usdce;
    MockUSDC private immutable pusd;

    constructor(MockUSDC usdce_, MockUSDC pusd_) {
        usdce = usdce_;
        pusd = pusd_;
    }

    function unwrap(address asset, address to, uint256 amount) external {
        require(asset == address(usdce));
        pusd.transferFrom(msg.sender, address(this), amount);
        usdce.mint(to, amount);
    }
}

contract ShieldedPolymarketAdapterTest is Test {
    MockUSDC private usdce;
    MockUSDC private pusd;
    ShieldedPolymarketAdapter private adapter;
    address private pool = address(0x1000);
    address private operator = address(0x2000);
    address private depositWallet = address(0x3000);

    function setUp() public {
        usdce = new MockUSDC();
        pusd = new MockUSDC();
        ShieldedAdapterOnramp onramp = new ShieldedAdapterOnramp(usdce, pusd);
        ShieldedAdapterOfframp offramp = new ShieldedAdapterOfframp(usdce, pusd);
        adapter = new ShieldedPolymarketAdapter(
            IShieldedAdapterERC20(address(usdce)),
            IBridgeERC20(address(pusd)),
            onramp,
            offramp,
            operator,
            address(this),
            depositWallet
        );
        adapter.bindPool(pool);
    }

    function testRoutesToDepositWalletAndReturnsPusdToPool() public {
        uint256 routed = 1_350_000;
        usdce.mint(address(adapter), routed);
        vm.prank(pool);
        adapter.routeBuy(routed, 42);

        assertEq(usdce.balanceOf(address(adapter)), 0);
        assertEq(pusd.balanceOf(depositWallet), routed);

        uint256 refund = 120_000;
        vm.prank(depositWallet);
        pusd.transfer(address(adapter), refund);
        vm.prank(operator);
        adapter.returnPusd(refund);

        assertEq(pusd.balanceOf(address(adapter)), 0);
        assertEq(usdce.balanceOf(pool), refund);
    }

    function testPoolBindingCannotChangeAndUnauthorizedRoutingFails() public {
        vm.expectRevert(ShieldedPolymarketAdapter.InvalidInput.selector);
        adapter.bindPool(address(0x9999));

        vm.expectRevert(ShieldedPolymarketAdapter.OnlyPool.selector);
        adapter.routeBuy(1, 42);

        vm.expectRevert(ShieldedPolymarketAdapter.OnlyOperator.selector);
        vm.prank(address(0xBAD));
        adapter.returnPusd(1);
    }
}
