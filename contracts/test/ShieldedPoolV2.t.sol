// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {
    ShieldedPoolV2,
    IShieldedPoolV2ERC20,
    IShieldedPoolV2CTF,
    IShieldedPoolV2Verifier,
    IShieldedPoolV2ExecutionAdapter
} from "../src/ShieldedPoolV2.sol";
import {MockCTF} from "../src/mocks/MockCTF.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";

contract ShieldedPoolV2VerifierMock is IShieldedPoolV2Verifier {
    bytes32 public expectedInputsHash;
    bool public result = true;

    function expect(bytes32[] memory inputs) external {
        expectedInputsHash = keccak256(abi.encode(inputs));
    }

    function setResult(bool value) external {
        result = value;
    }

    function verify(bytes calldata, bytes32[] calldata inputs) external view returns (bool) {
        return result && keccak256(abi.encode(inputs)) == expectedInputsHash;
    }
}

contract ShieldedPoolV2AdapterMock is IShieldedPoolV2ExecutionAdapter {
    MockUSDC public immutable usdc;
    uint256 public routedAmount;
    uint256 public routedTokenId;

    constructor(MockUSDC usdc_) {
        usdc = usdc_;
    }

    function routeBuy(uint256 amount, uint256 tokenId) external {
        routedAmount = amount;
        routedTokenId = tokenId;
    }

    function spend(address recipient, uint256 amount) external {
        usdc.transfer(recipient, amount);
    }

    function returnCollateral(address pool, uint256 amount) external {
        usdc.transfer(pool, amount);
    }
}

contract ShieldedPoolV2Test is Test {
    MockUSDC private usdc;
    MockCTF private ctf;
    ShieldedPoolV2VerifierMock private verifier;
    ShieldedPoolV2AdapterMock private adapter;
    ShieldedPoolV2 private pool;

    address private depositor = address(0xA11CE);
    address private recipient = address(0xB0B);

    function setUp() public {
        usdc = new MockUSDC();
        ctf = new MockCTF();
        verifier = new ShieldedPoolV2VerifierMock();
        adapter = new ShieldedPoolV2AdapterMock(usdc);
        pool = new ShieldedPoolV2(
            IShieldedPoolV2ERC20(address(usdc)),
            IShieldedPoolV2CTF(address(ctf)),
            verifier,
            verifier,
            verifier,
            verifier,
            verifier,
            verifier,
            adapter,
            address(this),
            address(this)
        );
        pool.setPaused(false);
    }

    function testLockOrderConsumesCollateralNoteAndInsertsGenericCommitment() public {
        bytes32 order = keccak256("generic-hidden-order");
        uint256 beforeIndex = _depositAndLock(500_000, order, 1);

        assertTrue(pool.spentNullifiers(keccak256(abi.encode("collateral-nullifier", uint256(1)))));
        assertEq(pool.nextLeafIndex(), beforeIndex + 1);
        assertEq(pool.liabilities(pool.collateralAssetId()), 500_000);
        assertTrue(pool.knownRoots(pool.currentRoot()));
    }

    function testRouteConsumesNullifiersWithoutSourceCommitments() public {
        (uint256 tokenId, bytes32[2] memory orders, bytes32[2] memory nullifiers, bytes32[2] memory refunds) =
            _prepareOrders();
        bytes32 binding = keccak256("unlinkable-batch-binding");
        bytes32[] memory inputs = _routeInputs(pool.currentRoot(), pool.positionAssetId(tokenId), nullifiers, refunds, 1_000_000, binding);
        for (uint256 i = 0; i < inputs.length; i++) {
            assertTrue(inputs[i] != orders[0] && inputs[i] != orders[1]);
        }
        verifier.expect(inputs);
        pool.startBuyBatch(hex"1234", pool.currentRoot(), tokenId, nullifiers, refunds, 1_000_000, binding);

        assertTrue(pool.spentOrderNullifiers(nullifiers[0]));
        assertTrue(pool.spentOrderNullifiers(nullifiers[1]));
        assertEq(usdc.balanceOf(address(adapter)), 1_000_000);
        assertEq(adapter.routedTokenId(), tokenId);
        assertTrue(_isActive());
    }

    function testRouteRejectsDuplicateAndPreviouslySpentNullifiers() public {
        (uint256 tokenId,, bytes32[2] memory nullifiers, bytes32[2] memory refunds) = _prepareOrders();
        bytes32[2] memory duplicate = [nullifiers[0], nullifiers[0]];
        bytes32 root = pool.currentRoot();
        vm.expectRevert(ShieldedPoolV2.InvalidInput.selector);
        pool.startBuyBatch(hex"", root, tokenId, duplicate, refunds, 1_000_000, keccak256("dup"));

        bytes32 binding = keccak256("valid-binding");
        verifier.expect(_routeInputs(root, pool.positionAssetId(tokenId), nullifiers, refunds, 1_000_000, binding));
        pool.startBuyBatch(hex"12", root, tokenId, nullifiers, refunds, 1_000_000, binding);
        adapter.returnCollateral(address(pool), 1_000_000);
        pool.cancelBuyBatch();

        bytes32 postCancelRoot = pool.currentRoot();
        vm.expectRevert(ShieldedPoolV2.NullifierSpent.selector);
        pool.startBuyBatch(hex"", postCancelRoot, tokenId, nullifiers, refunds, 1_000_000, binding);
    }

    function testRouteRejectsProofBoundToAnotherAggregatePosition() public {
        (uint256 tokenId,, bytes32[2] memory nullifiers, bytes32[2] memory refunds) = _prepareOrders();
        bytes32 binding = keccak256("position-bound-batch");
        bytes32 root = pool.currentRoot();
        verifier.expect(_routeInputs(root, pool.positionAssetId(tokenId + 1), nullifiers, refunds, 1_000_000, binding));
        vm.expectRevert(ShieldedPoolV2.ProofInvalid.selector);
        pool.startBuyBatch(hex"12", root, tokenId, nullifiers, refunds, 1_000_000, binding);
        assertFalse(pool.spentOrderNullifiers(nullifiers[0]));
    }

    function testSettlementRequiresExactBackingAndCreatesPrivateOutputs() public {
        bytes32 conditionId = keccak256("v13-settlement-market");
        bytes32 collectionId = ctf.getCollectionId(bytes32(0), conditionId, 1);
        uint256 tokenId = ctf.getPositionId(address(usdc), collectionId);
        (, bytes32[2] memory nullifiers, bytes32[2] memory fullRefunds) = _prepareOrdersForToken(tokenId);
        bytes32 binding = keccak256("settlement-binding");
        verifier.expect(_routeInputs(pool.currentRoot(), pool.positionAssetId(tokenId), nullifiers, fullRefunds, 1_000_000, binding));
        pool.startBuyBatch(hex"12", pool.currentRoot(), tokenId, nullifiers, fullRefunds, 1_000_000, binding);

        bytes32[2] memory refunds = [keccak256("refund-0"), keccak256("refund-1")];
        bytes32[2] memory positions = [keccak256("position-0"), bytes32(0)];
        verifier.expect(_settlementInputs(binding, pool.positionAssetId(tokenId), refunds, positions, 1_000_000, 550_000, 1_000_000));
        vm.expectRevert(ShieldedPoolV2.InsufficientBacking.selector);
        pool.settleBuyBatch(hex"34", refunds, positions, 550_000, 1_000_000);

        adapter.spend(address(0xD00D), 550_000);
        adapter.returnCollateral(address(pool), 450_000);
        usdc.mint(depositor, 550_000);
        vm.startPrank(depositor);
        usdc.approve(address(ctf), 550_000);
        assertEq(ctf.mockBuyYes(address(usdc), conditionId, 550_000, 550_000), 1_000_000);
        ctf.safeTransferFrom(depositor, address(pool), tokenId, 1_000_000, "");
        vm.stopPrank();

        uint256 outputIndex = pool.nextLeafIndex();
        pool.settleBuyBatch(hex"34", refunds, positions, 550_000, 1_000_000);
        assertFalse(_isActive());
        assertEq(pool.liabilities(pool.collateralAssetId()), 450_000);
        assertEq(pool.liabilities(pool.positionAssetId(tokenId)), 1_000_000);
        assertEq(pool.nextLeafIndex(), outputIndex + 3);
    }

    function testZeroFillBatchCanCancelOnlyAfterCollateralReturns() public {
        (uint256 tokenId,, bytes32[2] memory nullifiers, bytes32[2] memory refunds) = _prepareOrders();
        bytes32 binding = keccak256("zero-fill-binding");
        verifier.expect(_routeInputs(pool.currentRoot(), pool.positionAssetId(tokenId), nullifiers, refunds, 1_000_000, binding));
        pool.startBuyBatch(hex"12", pool.currentRoot(), tokenId, nullifiers, refunds, 1_000_000, binding);
        vm.expectRevert(ShieldedPoolV2.InsufficientBacking.selector);
        pool.cancelBuyBatch();
        adapter.returnCollateral(address(pool), 1_000_000);
        uint256 outputIndex = pool.nextLeafIndex();
        pool.cancelBuyBatch();
        assertFalse(_isActive());
        assertEq(pool.nextLeafIndex(), outputIndex + 2);
        assertEq(pool.liabilities(pool.collateralAssetId()), 1_000_000);
    }

    function testBatchCannotConsumePreexistingSurplus() public {
        bytes32 conditionId = keccak256("v13-surplus-market");
        bytes32 collectionId = ctf.getCollectionId(bytes32(0), conditionId, 1);
        uint256 tokenId = ctf.getPositionId(address(usdc), collectionId);

        usdc.mint(depositor, 2_000_000);
        vm.startPrank(depositor);
        usdc.approve(address(ctf), 1_000_000);
        assertEq(ctf.mockBuyYes(address(usdc), conditionId, 1_000_000, 1_000_000), 1_000_000);
        ctf.safeTransferFrom(depositor, address(pool), tokenId, 1_000_000, "");
        usdc.transfer(address(pool), 1_000_000);
        vm.stopPrank();

        (, bytes32[2] memory nullifiers, bytes32[2] memory fullRefunds) = _prepareOrdersForToken(tokenId);
        bytes32 binding = keccak256("surplus-binding");
        verifier.expect(_routeInputs(pool.currentRoot(), pool.positionAssetId(tokenId), nullifiers, fullRefunds, 1_000_000, binding));
        pool.startBuyBatch(hex"12", pool.currentRoot(), tokenId, nullifiers, fullRefunds, 1_000_000, binding);

        vm.expectRevert(ShieldedPoolV2.InsufficientBacking.selector);
        pool.cancelBuyBatch();

        bytes32[2] memory refunds = [keccak256("surplus-refund-0"), keccak256("surplus-refund-1")];
        bytes32[2] memory positions = [keccak256("surplus-position-0"), bytes32(0)];
        verifier.expect(_settlementInputs(binding, pool.positionAssetId(tokenId), refunds, positions, 1_000_000, 1_000_000, 1_000_000));
        vm.expectRevert(ShieldedPoolV2.InsufficientBacking.selector);
        pool.settleBuyBatch(hex"34", refunds, positions, 1_000_000, 1_000_000);

        adapter.spend(address(0xD00D), 1_000_000);
        usdc.mint(depositor, 1_000_000);
        vm.startPrank(depositor);
        usdc.approve(address(ctf), 1_000_000);
        assertEq(ctf.mockBuyYes(address(usdc), conditionId, 1_000_000, 1_000_000), 1_000_000);
        ctf.safeTransferFrom(depositor, address(pool), tokenId, 1_000_000, "");
        vm.stopPrank();
        pool.settleBuyBatch(hex"34", refunds, positions, 1_000_000, 1_000_000);
    }

    function testOrderCancellationAndWithdrawRemainAvailableWhilePaused() public {
        bytes32 order = keccak256("cancel-hidden-order");
        _depositAndLock(500_000, order, 77);
        bytes32 root = pool.currentRoot();
        bytes32 orderNullifier = keccak256("hidden-order-nullifier");
        bytes32 refund = keccak256("full-refund-note");
        verifier.expect(_cancelInputs(root, orderNullifier, refund, 500_000));
        pool.setPaused(true);
        pool.cancelOrder(hex"12", root, orderNullifier, refund, 500_000);
        assertTrue(pool.spentOrderNullifiers(orderNullifier));

        bytes32 withdrawalNullifier = keccak256("paused-withdrawal-nullifier");
        verifier.expect(_withdrawInputs(pool.currentRoot(), withdrawalNullifier, 500_000, recipient));
        pool.withdraw(hex"34", pool.currentRoot(), withdrawalNullifier, 500_000, recipient);
        assertEq(usdc.balanceOf(recipient), 500_000);

        vm.expectRevert(ShieldedPoolV2.Paused.selector);
        pool.deposit(1, bytes32(uint256(1)));
    }

    function _prepareOrders()
        private
        returns (uint256 tokenId, bytes32[2] memory orders, bytes32[2] memory nullifiers, bytes32[2] memory refunds)
    {
        tokenId = uint256(keccak256("aggregate-token"));
        (orders, nullifiers, refunds) = _prepareOrdersForToken(tokenId);
    }

    function _prepareOrdersForToken(uint256 tokenId)
        private
        returns (bytes32[2] memory orders, bytes32[2] memory nullifiers, bytes32[2] memory refunds)
    {
        orders = [keccak256(abi.encode("order", tokenId, uint256(0))), keccak256(abi.encode("order", tokenId, uint256(1)))];
        nullifiers = [keccak256(abi.encode("order-nullifier", tokenId, uint256(0))), keccak256(abi.encode("order-nullifier", tokenId, uint256(1)))];
        refunds = [keccak256(abi.encode("full-refund", tokenId, uint256(0))), keccak256(abi.encode("full-refund", tokenId, uint256(1)))];
        _depositAndLock(600_000, orders[0], 10);
        _depositAndLock(400_000, orders[1], 11);
    }

    function _depositAndLock(uint256 amount, bytes32 order, uint256 nonce) private returns (uint256 beforeLockIndex) {
        bytes32 publicKey = keccak256(abi.encode("note-key", nonce));
        usdc.mint(depositor, amount);
        vm.startPrank(depositor);
        usdc.approve(address(pool), amount);
        pool.deposit(amount, publicKey);
        vm.stopPrank();
        bytes32 root = pool.currentRoot();
        bytes32 nullifier = keccak256(abi.encode("collateral-nullifier", nonce));
        verifier.expect(_orderInputs(root, nullifier, order));
        beforeLockIndex = pool.nextLeafIndex();
        pool.lockOrder(hex"1234", root, nullifier, order);
    }

    function _orderInputs(bytes32 root, bytes32 nullifier, bytes32 order)
        private
        view
        returns (bytes32[] memory inputs)
    {
        inputs = new bytes32[](8);
        (inputs[0], inputs[1]) = _halves(root);
        (inputs[2], inputs[3]) = _halves(nullifier);
        (inputs[4], inputs[5]) = _halves(pool.collateralAssetId());
        (inputs[6], inputs[7]) = _halves(order);
    }

    function _routeInputs(
        bytes32 root,
        bytes32 positionAsset,
        bytes32[2] memory nullifiers,
        bytes32[2] memory refunds,
        uint256 deposit,
        bytes32 binding
    ) private view returns (bytes32[] memory inputs) {
        inputs = new bytes32[](17);
        (inputs[0], inputs[1]) = _halves(root);
        (inputs[2], inputs[3]) = _halves(pool.collateralAssetId());
        (inputs[4], inputs[5]) = _halves(positionAsset);
        for (uint256 i = 0; i < 2; i++) {
            (inputs[6 + i], inputs[8 + i]) = _halves(nullifiers[i]);
            (inputs[10 + i], inputs[12 + i]) = _halves(refunds[i]);
        }
        inputs[14] = bytes32(deposit);
        (inputs[15], inputs[16]) = _halves(binding);
    }

    function _settlementInputs(
        bytes32 binding,
        bytes32 positionAsset,
        bytes32[2] memory refunds,
        bytes32[2] memory positions,
        uint256 deposit,
        uint256 spent,
        uint256 shares
    ) private view returns (bytes32[] memory inputs) {
        inputs = new bytes32[](17);
        (inputs[0], inputs[1]) = _halves(binding);
        (inputs[2], inputs[3]) = _halves(pool.collateralAssetId());
        (inputs[4], inputs[5]) = _halves(positionAsset);
        for (uint256 i = 0; i < 2; i++) {
            (inputs[6 + i], inputs[8 + i]) = _halves(refunds[i]);
            (inputs[10 + i], inputs[12 + i]) = _halves(positions[i]);
        }
        inputs[14] = bytes32(deposit);
        inputs[15] = bytes32(spent);
        inputs[16] = bytes32(shares);
    }

    function _cancelInputs(bytes32 root, bytes32 nullifier, bytes32 refund, uint256 deposit)
        private
        view
        returns (bytes32[] memory inputs)
    {
        inputs = new bytes32[](9);
        (inputs[0], inputs[1]) = _halves(root);
        (inputs[2], inputs[3]) = _halves(nullifier);
        (inputs[4], inputs[5]) = _halves(pool.collateralAssetId());
        (inputs[6], inputs[7]) = _halves(refund);
        inputs[8] = bytes32(deposit);
    }

    function _withdrawInputs(bytes32 root, bytes32 nullifier, uint256 amount, address to)
        private
        view
        returns (bytes32[] memory inputs)
    {
        inputs = new bytes32[](9);
        (inputs[0], inputs[1]) = _halves(root);
        (inputs[2], inputs[3]) = _halves(nullifier);
        (inputs[4], inputs[5]) = _halves(pool.collateralAssetId());
        inputs[6] = bytes32(amount);
        bytes32 binding = keccak256(abi.encode(bytes32(uint256(3)), root, nullifier, pool.collateralAssetId(), amount, to));
        (inputs[7], inputs[8]) = _halves(binding);
    }

    function _isActive() private view returns (bool active) {
        (,,,, active) = pool.activeBuy();
    }

    function _halves(bytes32 value) private pure returns (bytes32 high, bytes32 low) {
        high = bytes32(uint256(value) >> 128);
        low = bytes32(uint256(value) & type(uint128).max);
    }
}
