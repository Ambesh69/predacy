// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/ShieldedPoolV1.sol";
import "../src/mocks/MockCTF.sol";
import "../src/mocks/MockUSDC.sol";

contract ShieldedWithdrawVerifierMock is IShieldedWithdrawVerifier {
    bytes32 public expectedInputsHash;
    bool public result = true;

    function expect(bytes32[] memory publicInputs) external {
        expectedInputsHash = keccak256(abi.encode(publicInputs));
    }

    function setResult(bool value) external {
        result = value;
    }

    function verify(bytes calldata, bytes32[] calldata publicInputs) external view returns (bool) {
        return result && keccak256(abi.encode(publicInputs)) == expectedInputsHash;
    }
}

contract ShieldedExecutionAdapterMock is IShieldedExecutionAdapter {
    MockUSDC public immutable usdc;
    uint256 public routedAmount;
    uint256 public routedTokenId;

    constructor(MockUSDC usdc_) {
        usdc = usdc_;
    }

    function routeBuy(uint256 collateralAmount, uint256 positionTokenId) external {
        routedAmount = collateralAmount;
        routedTokenId = positionTokenId;
    }

    function spend(address to, uint256 amount) external {
        usdc.transfer(to, amount);
    }

    function returnCollateral(address pool, uint256 amount) external {
        usdc.transfer(pool, amount);
    }
}

contract ShieldedPoolV1Test is Test {
    MockUSDC private usdc;
    MockCTF private ctf;
    ShieldedWithdrawVerifierMock private verifier;
    ShieldedExecutionAdapterMock private adapter;
    ShieldedPoolV1 private pool;

    address private depositor = address(0xA11CE);
    address private recipient = address(0xB0B);

    function setUp() public {
        usdc = new MockUSDC();
        ctf = new MockCTF();
        verifier = new ShieldedWithdrawVerifierMock();
        adapter = new ShieldedExecutionAdapterMock(usdc);
        pool = new ShieldedPoolV1(
            IShieldedPoolERC20(address(usdc)),
            IShieldedPoolCTF(address(ctf)),
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

    function testDepositBuildsBoundNoteAndMerkleRoot() public {
        uint256 amount = 2_000_000;
        bytes32 publicKey = keccak256(abi.encodePacked(bytes32(uint256(99))));
        bytes32 commitment = pool.noteCommitment(uint64(amount), publicKey);
        usdc.mint(depositor, amount);

        vm.startPrank(depositor);
        usdc.approve(address(pool), amount);
        (uint256 leafIndex, bytes32 deposited) = pool.deposit(amount, publicKey);
        vm.stopPrank();

        assertEq(leafIndex, 0);
        assertEq(deposited, commitment);
        assertEq(pool.nextLeafIndex(), 1);
        assertEq(usdc.balanceOf(address(pool)), amount);
        assertEq(pool.liabilities(pool.collateralAssetId()), amount);
        assertTrue(pool.knownRoots(pool.currentRoot()));
        assertEq(pool.currentRoot(), _firstLeafRoot(commitment));
    }

    function testWithdrawUsesRootNullifierAndRecipientBinding() public {
        uint256 amount = 1_350_000;
        bytes32 publicKey = keccak256(abi.encodePacked(bytes32(uint256(123))));
        usdc.mint(depositor, amount);
        vm.startPrank(depositor);
        usdc.approve(address(pool), amount);
        pool.deposit(amount, publicKey);
        vm.stopPrank();

        bytes32 root = pool.currentRoot();
        bytes32 nullifier = keccak256("unique-note-nullifier");
        verifier.expect(_withdrawInputs(root, nullifier, pool.collateralAssetId(), amount, recipient));
        pool.withdraw(hex"1234", root, nullifier, amount, recipient);

        assertEq(usdc.balanceOf(recipient), amount);
        assertEq(usdc.balanceOf(address(pool)), 0);
        assertEq(pool.liabilities(pool.collateralAssetId()), 0);
        assertTrue(pool.spentNullifiers(nullifier));

        vm.expectRevert(ShieldedPoolV1.NullifierSpent.selector);
        pool.withdraw(hex"1234", root, nullifier, amount, recipient);
    }

    function testProofCannotBeRedirectedToAnotherRecipient() public {
        uint256 amount = 500_000;
        bytes32 publicKey = keccak256(abi.encodePacked(bytes32(uint256(456))));
        usdc.mint(depositor, amount);
        vm.startPrank(depositor);
        usdc.approve(address(pool), amount);
        pool.deposit(amount, publicKey);
        vm.stopPrank();

        bytes32 root = pool.currentRoot();
        bytes32 nullifier = keccak256("recipient-bound-nullifier");
        verifier.expect(_withdrawInputs(root, nullifier, pool.collateralAssetId(), amount, recipient));

        vm.expectRevert(ShieldedPoolV1.ProofInvalid.selector);
        pool.withdraw(hex"1234", root, nullifier, amount, address(0xBAD));
        assertFalse(pool.spentNullifiers(nullifier));
    }

    function testPositionDepositAndPrivateWithdrawal() public {
        bytes32 conditionId = keccak256("private-position-market");
        bytes32 collectionId = ctf.getCollectionId(bytes32(0), conditionId, 1);
        uint256 tokenId = ctf.getPositionId(address(usdc), collectionId);
        uint256 cost = 500_000;
        uint256 shares = 1_000_000;
        bytes32 publicKey = keccak256(abi.encodePacked(bytes32(uint256(789))));

        usdc.mint(depositor, cost);
        vm.startPrank(depositor);
        usdc.approve(address(ctf), cost);
        assertEq(ctf.mockBuyYes(address(usdc), conditionId, cost, 500_000), shares);
        ctf.setApprovalForAll(address(pool), true);
        pool.depositPosition(tokenId, shares, publicKey);
        vm.stopPrank();

        bytes32 assetId = pool.positionAssetId(tokenId);
        assertEq(ctf.balanceOf(address(pool), tokenId), shares);
        assertEq(pool.liabilities(assetId), shares);

        bytes32 root = pool.currentRoot();
        bytes32 nullifier = keccak256("position-note-nullifier");
        verifier.expect(_withdrawInputs(root, nullifier, assetId, shares, recipient));
        pool.withdrawPosition(hex"1234", root, nullifier, tokenId, shares, recipient);

        assertEq(ctf.balanceOf(recipient, tokenId), shares);
        assertEq(pool.liabilities(assetId), 0);
        assertTrue(pool.spentNullifiers(nullifier));
    }

    function testRejectsUnknownRootAndPausedDeposits() public {
        vm.expectRevert(ShieldedPoolV1.InvalidRoot.selector);
        pool.withdraw(hex"", bytes32(uint256(1)), bytes32(uint256(2)), 1, recipient);

        pool.setPaused(true);
        vm.expectRevert(ShieldedPoolV1.Paused.selector);
        pool.deposit(1, bytes32(uint256(3)));
    }

    function testPrivateNoteTransferPreservesLiabilityAndConsumesNullifier() public {
        uint256 amount = 1_000_000;
        bytes32 publicKey = keccak256(abi.encodePacked(bytes32(uint256(999))));
        usdc.mint(depositor, amount);
        vm.startPrank(depositor);
        usdc.approve(address(pool), amount);
        pool.deposit(amount, publicKey);
        vm.stopPrank();

        bytes32 root = pool.currentRoot();
        bytes32 nullifier = keccak256("private-transfer-nullifier");
        bytes32 first = keccak256("first-private-output");
        bytes32 second = keccak256("second-private-output");
        bytes32[] memory inputs = new bytes32[](8);
        (inputs[0], inputs[1]) = _halves(root);
        (inputs[2], inputs[3]) = _halves(nullifier);
        (inputs[4], inputs[5]) = _halves(first);
        (inputs[6], inputs[7]) = _halves(second);
        verifier.expect(inputs);

        uint256 firstOutputIndex = pool.nextLeafIndex();
        pool.transferNotes(hex"1234", root, nullifier, first, second);

        assertTrue(pool.spentNullifiers(nullifier));
        assertEq(pool.nextLeafIndex(), firstOutputIndex + 2);
        assertEq(pool.liabilities(pool.collateralAssetId()), amount);
        assertEq(usdc.balanceOf(address(pool)), amount);
    }

    function testPrivateBuyOrderLockConsumesNoteWithoutRevealingAmount() public {
        uint256 amount = 750_000;
        bytes32 publicKey = keccak256(abi.encodePacked(bytes32(uint256(1001))));
        usdc.mint(depositor, amount);
        vm.startPrank(depositor);
        usdc.approve(address(pool), amount);
        pool.deposit(amount, publicKey);
        vm.stopPrank();

        uint256 tokenId = uint256(keccak256("private-buy-token"));
        bytes32 root = pool.currentRoot();
        bytes32 nullifier = keccak256("private-buy-nullifier");
        bytes32 orderCommitment = keccak256("hidden-order");
        bytes32 positionAsset = pool.positionAssetId(tokenId);
        bytes32[] memory inputs = new bytes32[](10);
        (inputs[0], inputs[1]) = _halves(root);
        (inputs[2], inputs[3]) = _halves(nullifier);
        (inputs[4], inputs[5]) = _halves(pool.collateralAssetId());
        (inputs[6], inputs[7]) = _halves(positionAsset);
        (inputs[8], inputs[9]) = _halves(orderCommitment);
        verifier.expect(inputs);

        pool.lockBuyOrder(hex"1234", root, nullifier, tokenId, orderCommitment);

        assertTrue(pool.spentNullifiers(nullifier));
        assertEq(pool.lockedOrderAsset(orderCommitment), positionAsset);
        assertEq(pool.liabilities(pool.collateralAssetId()), amount);
        assertEq(pool.nextLeafIndex(), 1);
    }

    function testProofAuthorizedBuyRoutesAndSettlesIntoPrivateNotes() public {
        uint256 deposit = 1_000_000;
        bytes32 conditionId = keccak256("shielded-live-market");
        bytes32 collectionId = ctf.getCollectionId(bytes32(0), conditionId, 1);
        uint256 tokenId = ctf.getPositionId(address(usdc), collectionId);
        bytes32 order = _depositAndLockOrder(deposit, tokenId);
        bytes32 refund = keccak256("private-refund-note");
        bytes32 position = keccak256("private-position-note");
        bytes32[2] memory orders = [order, bytes32(0)];
        bytes32[2] memory refunds = [refund, bytes32(0)];
        bytes32[2] memory zeroPositions;

        verifier.expect(_batchInputs(1, pool.positionAssetId(tokenId), orders, refunds, zeroPositions, deposit, 0, 0));
        pool.startBuyBatch(hex"1234", 1, tokenId, orders, refunds, deposit);

        assertEq(usdc.balanceOf(address(adapter)), deposit);
        assertEq(adapter.routedAmount(), deposit);
        assertTrue(_isActive());

        uint256 spent = 550_000;
        uint256 shares = 1_000_000;
        adapter.spend(address(0xD00D), spent);
        adapter.returnCollateral(address(pool), deposit - spent);
        usdc.mint(depositor, spent);
        vm.startPrank(depositor);
        usdc.approve(address(ctf), spent);
        assertEq(ctf.mockBuyYes(address(usdc), conditionId, spent, 550_000), shares);
        ctf.safeTransferFrom(depositor, address(pool), tokenId, shares, "");
        vm.stopPrank();

        bytes32[2] memory positions = [position, bytes32(0)];
        verifier.expect(
            _batchInputs(1, pool.positionAssetId(tokenId), orders, refunds, positions, deposit, spent, shares)
        );
        uint256 outputIndex = pool.nextLeafIndex();
        pool.settleBuyBatch(hex"5678", orders, refunds, positions, spent, shares);

        assertFalse(_isActive());
        assertTrue(pool.settledOrders(order));
        assertEq(pool.lockedOrderAsset(order), bytes32(0));
        assertEq(pool.liabilities(pool.collateralAssetId()), deposit - spent);
        assertEq(pool.liabilities(pool.positionAssetId(tokenId)), shares);
        assertEq(pool.nextLeafIndex(), outputIndex + 2);
        assertEq(usdc.balanceOf(address(pool)), deposit - spent);
        assertEq(ctf.balanceOf(address(pool), tokenId), shares);
    }

    function testCannotSettleUntilReturnedAssetsFullyBackPrivateNotes() public {
        uint256 deposit = 800_000;
        uint256 tokenId = uint256(keccak256("backing-test-token"));
        bytes32 order = _depositAndLockOrder(deposit, tokenId);
        bytes32 refund = keccak256("backing-refund");
        bytes32 position = keccak256("backing-position");
        bytes32[2] memory orders = [order, bytes32(0)];
        bytes32[2] memory refunds = [refund, bytes32(0)];
        bytes32[2] memory zeroPositions;
        verifier.expect(_batchInputs(1, pool.positionAssetId(tokenId), orders, refunds, zeroPositions, deposit, 0, 0));
        pool.startBuyBatch(hex"12", 1, tokenId, orders, refunds, deposit);

        bytes32[2] memory positions = [position, bytes32(0)];
        verifier.expect(
            _batchInputs(1, pool.positionAssetId(tokenId), orders, refunds, positions, deposit, 400_000, 500_000)
        );
        vm.expectRevert(ShieldedPoolV1.InsufficientBacking.selector);
        pool.settleBuyBatch(hex"34", orders, refunds, positions, 400_000, 500_000);
        assertTrue(_isActive());
    }

    function testRejectedBuyCanCancelOnlyAfterCollateralReturns() public {
        uint256 deposit = 600_000;
        uint256 tokenId = uint256(keccak256("cancel-test-token"));
        bytes32 order = _depositAndLockOrder(deposit, tokenId);
        bytes32 refund = keccak256("cancel-full-refund");
        bytes32[2] memory orders = [order, bytes32(0)];
        bytes32[2] memory refunds = [refund, bytes32(0)];
        bytes32[2] memory zeroPositions;
        verifier.expect(_batchInputs(1, pool.positionAssetId(tokenId), orders, refunds, zeroPositions, deposit, 0, 0));
        pool.startBuyBatch(hex"12", 1, tokenId, orders, refunds, deposit);

        vm.expectRevert(ShieldedPoolV1.InsufficientBacking.selector);
        pool.cancelBuyBatch();
        adapter.returnCollateral(address(pool), deposit);
        uint256 refundIndex = pool.nextLeafIndex();
        pool.cancelBuyBatch();

        assertFalse(_isActive());
        assertTrue(pool.settledOrders(order));
        assertEq(pool.lockedOrderAsset(order), bytes32(0));
        assertEq(pool.liabilities(pool.collateralAssetId()), deposit);
        assertEq(pool.nextLeafIndex(), refundIndex + 1);
    }

    function testOwnerCanProofCancelLockedOrderWithoutRelayer() public {
        uint256 deposit = 625_000;
        uint256 tokenId = uint256(keccak256("owner-cancel-token"));
        bytes32 order = _depositAndLockOrder(deposit, tokenId);
        bytes32 refund = keccak256("owner-full-refund");
        bytes32[2] memory orders = [order, bytes32(0)];
        bytes32[2] memory refunds = [refund, bytes32(0)];
        bytes32[2] memory positions;
        verifier.expect(_batchInputs(1, pool.positionAssetId(tokenId), orders, refunds, positions, deposit, 0, 0));

        uint256 refundIndex = pool.nextLeafIndex();
        vm.prank(depositor);
        pool.cancelLockedBuyOrder(hex"9876", tokenId, order, refund, deposit);

        assertTrue(pool.settledOrders(order));
        assertEq(pool.lockedOrderAsset(order), bytes32(0));
        assertEq(pool.liabilities(pool.collateralAssetId()), deposit);
        assertEq(pool.nextLeafIndex(), refundIndex + 1);
    }

    function _depositAndLockOrder(uint256 amount, uint256 tokenId) private returns (bytes32 order) {
        bytes32 publicKey = keccak256(abi.encode("order-key", amount, tokenId));
        usdc.mint(depositor, amount);
        vm.startPrank(depositor);
        usdc.approve(address(pool), amount);
        pool.deposit(amount, publicKey);
        vm.stopPrank();

        bytes32 root = pool.currentRoot();
        bytes32 nullifier = keccak256(abi.encode("order-nullifier", amount, tokenId));
        order = keccak256(abi.encode("order", amount, tokenId));
        bytes32[] memory inputs = new bytes32[](10);
        (inputs[0], inputs[1]) = _halves(root);
        (inputs[2], inputs[3]) = _halves(nullifier);
        (inputs[4], inputs[5]) = _halves(pool.collateralAssetId());
        (inputs[6], inputs[7]) = _halves(pool.positionAssetId(tokenId));
        (inputs[8], inputs[9]) = _halves(order);
        verifier.expect(inputs);
        pool.lockBuyOrder(hex"1234", root, nullifier, tokenId, order);
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

    function _isActive() private view returns (bool active) {
        (,,,,, active) = pool.activeBuy();
    }

    function _withdrawInputs(bytes32 root, bytes32 nullifier, bytes32 assetId, uint256 amount, address to)
        private
        pure
        returns (bytes32[] memory inputs)
    {
        inputs = new bytes32[](9);
        (inputs[0], inputs[1]) = _halves(root);
        (inputs[2], inputs[3]) = _halves(nullifier);
        (inputs[4], inputs[5]) = _halves(assetId);
        inputs[6] = bytes32(amount);
        bytes32 binding = keccak256(abi.encode(bytes32(uint256(3)), root, nullifier, assetId, amount, to));
        (inputs[7], inputs[8]) = _halves(binding);
    }

    function _firstLeafRoot(bytes32 leaf) private view returns (bytes32 current) {
        current = leaf;
        for (uint256 level = 0; level < pool.TREE_DEPTH(); level++) {
            current = keccak256(abi.encodePacked(current, pool.zeros(level)));
        }
    }

    function _halves(bytes32 value) private pure returns (bytes32 high, bytes32 low) {
        high = bytes32(uint256(value) >> 128);
        low = bytes32(uint256(value) & type(uint128).max);
    }
}
