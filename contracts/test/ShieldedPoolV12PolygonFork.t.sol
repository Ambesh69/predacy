// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import {
    ShieldedPoolV1,
    IShieldedPoolERC20,
    IShieldedPoolCTF,
    IShieldedExecutionAdapter
} from "../src/ShieldedPoolV1.sol";
import {ShieldedPolymarketAdapter, IShieldedAdapterERC20} from "../src/ShieldedPolymarketAdapter.sol";
import {IBridgeERC20, ICollateralOnramp, ICollateralOfframp} from "../src/PolymarketCollateralBridge.sol";
import {ShieldedWithdrawVerifierMock} from "./ShieldedPoolV1.t.sol";

interface IForkTransferToken is IBridgeERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
}

interface IERC1155ReceiverLike {
    function onERC1155Received(address, address, uint256, uint256, bytes calldata) external returns (bytes4);
}

contract ShieldedForkCTF {
    mapping(address => mapping(uint256 => uint256)) public balanceOf;
    mapping(address => mapping(address => bool)) public isApprovedForAll;

    function mint(address to, uint256 id, uint256 amount) external {
        balanceOf[to][id] += amount;
    }

    function setApprovalForAll(address operator, bool approved) external {
        isApprovedForAll[msg.sender][operator] = approved;
    }

    function safeTransferFrom(address from, address to, uint256 id, uint256 amount, bytes calldata data) external {
        require(from == msg.sender || isApprovedForAll[from][msg.sender], "approval");
        require(balanceOf[from][id] >= amount, "balance");
        balanceOf[from][id] -= amount;
        balanceOf[to][id] += amount;
        if (to.code.length != 0) {
            require(
                IERC1155ReceiverLike(to).onERC1155Received(msg.sender, from, id, amount, data) == 0xf23a6e61, "receiver"
            );
        }
    }
}

contract ShieldedPoolV12PolygonForkTest is Test {
    address private constant USDCE = 0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174;
    address private constant PUSD = 0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB;
    address private constant ONRAMP = 0x93070a847efEf7F70739046A929D47a521F5B8ee;
    address private constant OFFRAMP = 0x2957922Eb93258b93368531d39fAcCA3B4dC5854;
    address private constant BUYER = address(0xA11CE);
    address private constant DEPOSIT_WALLET = address(0xD0D0);
    address private constant SPENT_COLLATERAL = address(0xCAFE);
    uint256 private constant POSITION_TOKEN_ID = 12;

    ShieldedForkCTF private ctf;
    ShieldedWithdrawVerifierMock private verifier;
    ShieldedPolymarketAdapter private adapter;
    ShieldedPoolV1 private pool;

    function setUp() public {
        if (ONRAMP.code.length == 0 || OFFRAMP.code.length == 0) vm.skip(true);

        ctf = new ShieldedForkCTF();
        verifier = new ShieldedWithdrawVerifierMock();
        adapter = new ShieldedPolymarketAdapter(
            IShieldedAdapterERC20(USDCE),
            IBridgeERC20(PUSD),
            ICollateralOnramp(ONRAMP),
            ICollateralOfframp(OFFRAMP),
            address(this),
            address(this),
            DEPOSIT_WALLET
        );
        pool = new ShieldedPoolV1(
            IShieldedPoolERC20(USDCE),
            IShieldedPoolCTF(address(ctf)),
            verifier,
            verifier,
            verifier,
            verifier,
            IShieldedExecutionAdapter(address(adapter)),
            address(this),
            address(this)
        );
        adapter.bindPool(address(pool));
        pool.setPaused(false);
    }

    function testRejectedBuyReturnsRealPolygonCollateralAndCreatesRefundNote() public {
        uint256 deposit = 410_000;
        (bytes32 order, bytes32 refund, bytes32[2] memory orders, bytes32[2] memory refunds) =
            _depositLockAndStart(deposit);

        assertEq(IBridgeERC20(PUSD).balanceOf(DEPOSIT_WALLET), deposit);
        vm.prank(DEPOSIT_WALLET);
        assertTrue(IForkTransferToken(PUSD).transfer(address(adapter), deposit));
        adapter.returnPusd(deposit);

        uint256 refundIndex = pool.nextLeafIndex();
        pool.cancelBuyBatch();

        assertEq(IBridgeERC20(USDCE).balanceOf(address(pool)), deposit);
        assertEq(pool.liabilities(pool.collateralAssetId()), deposit);
        assertEq(pool.nextLeafIndex(), refundIndex + 1);
        assertTrue(pool.settledOrders(order));
        assertEq(pool.lockedOrderAsset(order), bytes32(0));
        assertEq(refunds[0], refund);
        assertEq(orders[0], order);
    }

    function testPartialBuySettlesOnlyAfterRealResidualCollateralAndSharesReturn() public {
        uint256 deposit = 410_000;
        uint256 spent = 405_000;
        uint256 shares = 1_000_000;
        (bytes32 order,, bytes32[2] memory orders,) = _depositLockAndStart(deposit);

        vm.startPrank(DEPOSIT_WALLET);
        assertTrue(IForkTransferToken(PUSD).transfer(SPENT_COLLATERAL, spent));
        assertTrue(IForkTransferToken(PUSD).transfer(address(adapter), deposit - spent));
        vm.stopPrank();
        adapter.returnPusd(deposit - spent);

        ctf.mint(DEPOSIT_WALLET, POSITION_TOKEN_ID, shares);
        vm.prank(DEPOSIT_WALLET);
        ctf.safeTransferFrom(DEPOSIT_WALLET, address(pool), POSITION_TOKEN_ID, shares, "");

        bytes32 refund = keccak256("partial-refund-note");
        bytes32 position = keccak256("partial-position-note");
        bytes32[2] memory refunds = [refund, bytes32(0)];
        bytes32[2] memory positions = [position, bytes32(0)];
        verifier.expect(
            _batchInputs(1, pool.positionAssetId(POSITION_TOKEN_ID), orders, refunds, positions, deposit, spent, shares)
        );
        pool.settleBuyBatch(hex"5678", orders, refunds, positions, spent, shares);

        assertEq(IBridgeERC20(USDCE).balanceOf(address(pool)), deposit - spent);
        assertEq(pool.liabilities(pool.collateralAssetId()), deposit - spent);
        assertEq(ctf.balanceOf(address(pool), POSITION_TOKEN_ID), shares);
        assertEq(pool.liabilities(pool.positionAssetId(POSITION_TOKEN_ID)), shares);
        assertTrue(pool.settledOrders(order));
        assertEq(pool.lockedOrderAsset(order), bytes32(0));
    }

    function _depositLockAndStart(uint256 amount)
        private
        returns (bytes32 order, bytes32 refund, bytes32[2] memory orders, bytes32[2] memory refunds)
    {
        deal(USDCE, BUYER, amount, true);
        vm.startPrank(BUYER);
        IShieldedAdapterERC20(USDCE).approve(address(pool), amount);
        pool.deposit(amount, keccak256("fork-deposit-key"));
        vm.stopPrank();

        bytes32 root = pool.currentRoot();
        bytes32 nullifier = keccak256("fork-order-nullifier");
        order = keccak256("fork-hidden-order");
        bytes32[] memory orderInputs = new bytes32[](10);
        (orderInputs[0], orderInputs[1]) = _halves(root);
        (orderInputs[2], orderInputs[3]) = _halves(nullifier);
        (orderInputs[4], orderInputs[5]) = _halves(pool.collateralAssetId());
        (orderInputs[6], orderInputs[7]) = _halves(pool.positionAssetId(POSITION_TOKEN_ID));
        (orderInputs[8], orderInputs[9]) = _halves(order);
        verifier.expect(orderInputs);
        pool.lockBuyOrder(hex"1234", root, nullifier, POSITION_TOKEN_ID, order);

        refund = keccak256("full-refund-note");
        orders = [order, bytes32(0)];
        refunds = [refund, bytes32(0)];
        bytes32[2] memory positions;
        verifier.expect(
            _batchInputs(1, pool.positionAssetId(POSITION_TOKEN_ID), orders, refunds, positions, amount, 0, 0)
        );
        pool.startBuyBatch(hex"1234", 1, POSITION_TOKEN_ID, orders, refunds, amount);
    }

    function _batchInputs(
        uint8 orderCount,
        bytes32 positionAsset,
        bytes32[2] memory orders,
        bytes32[2] memory refunds,
        bytes32[2] memory positions,
        uint256 totalDeposit,
        uint256 totalSpent,
        uint256 totalShares
    ) private view returns (bytes32[] memory inputs) {
        inputs = new bytes32[](20);
        inputs[0] = bytes32(uint256(orderCount));
        (inputs[1], inputs[2]) = _halves(pool.collateralAssetId());
        (inputs[3], inputs[4]) = _halves(positionAsset);
        for (uint256 i = 0; i < 2; i++) {
            (inputs[5 + i], inputs[7 + i]) = _halves(orders[i]);
            (inputs[9 + i], inputs[11 + i]) = _halves(refunds[i]);
            (inputs[13 + i], inputs[15 + i]) = _halves(positions[i]);
        }
        inputs[17] = bytes32(totalDeposit);
        inputs[18] = bytes32(totalSpent);
        inputs[19] = bytes32(totalShares);
    }

    function _halves(bytes32 value) private pure returns (bytes32 high, bytes32 low) {
        high = bytes32(uint256(value) >> 128);
        low = bytes32(uint256(value) & type(uint128).max);
    }
}
