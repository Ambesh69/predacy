// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/BatchVault.sol";
import "../src/MockBatchVerifier.sol";

/// @notice Minimal ERC-20 mock for USDC
contract MockUSDC {
    string public name = "USD Coin";
    string public symbol = "USDC";
    uint8 public decimals = 6;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }
}

/// @notice Minimal CTF mock — just tracks splitPosition calls and mints fake tokens
contract MockCTF {
    mapping(address => mapping(uint256 => uint256)) public balanceOf;

    uint256 public splitCallCount;
    uint256 public lastSplitAmount;

    function splitPosition(
        address, /*collateralToken*/
        bytes32, /*parentCollectionId*/
        bytes32, /*conditionId*/
        uint256[] calldata, /*partition*/
        uint256 amount
    ) external {
        splitCallCount++;
        lastSplitAmount = amount;
        // Mint fake YES (tokenId=1) and NO (tokenId=2) tokens to caller
        balanceOf[msg.sender][1] += amount;
        balanceOf[msg.sender][2] += amount;
    }

    function safeTransferFrom(address from, address to, uint256 id, uint256 amount, bytes calldata) external {
        balanceOf[from][id] -= amount;
        balanceOf[to][id] += amount;
    }

    function setApprovalForAll(address, bool) external {}

    function getCollectionId(bytes32, bytes32 conditionId, uint256 indexSet)
        external
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(conditionId, indexSet));
    }

    function getPositionId(address collateral, bytes32 collectionId) external pure returns (uint256) {
        return uint256(keccak256(abi.encode(collateral, collectionId)));
    }
}

contract BatchVaultTest is Test {
    BatchVault public vault;
    MockBatchVerifier public verifier;
    MockUSDC public usdc;
    MockCTF public ctf;

    address public relayer = address(0xBEEF);
    address public alice = address(0xA);
    address public bob = address(0xB);
    address public carol = address(0xC);

    bytes32 public constant MARKET_ID = keccak256("polymarket:will-eth-reach-5k-march-2025");
    uint256 public constant PRICE_DECIMALS = 1e6;

    function setUp() public {
        usdc = new MockUSDC();
        ctf = new MockCTF();
        verifier = new MockBatchVerifier();
        vault = new BatchVault(address(usdc), address(ctf), relayer, address(verifier));

        // Fund traders
        usdc.mint(alice, 1000e6);
        usdc.mint(bob, 1000e6);
        usdc.mint(carol, 1000e6);

        // Approve vault
        vm.prank(alice);
        usdc.approve(address(vault), type(uint256).max);
        vm.prank(bob);
        usdc.approve(address(vault), type(uint256).max);
        vm.prank(carol);
        usdc.approve(address(vault), type(uint256).max);
    }

    // ─── Helpers ───────────────────────────────────────────────────────────

    function _openBatch() internal returns (uint256 batchId) {
        vm.prank(relayer);
        batchId = vault.openBatch(MARKET_ID);
    }

    function _makeCommitment(
        bytes32 marketId,
        bool isBuy,
        uint256 amount,
        uint256 limitPrice,
        bytes32 salt,
        address trader
    ) internal pure returns (bytes32) {
        return keccak256(abi.encode(marketId, isBuy, amount, limitPrice, salt, trader));
    }

    function _closeBatch(uint256 batchId) internal {
        // Skip past batch window
        vm.warp(block.timestamp + vault.BATCH_WINDOW() + 1);
        vault.closeBatch();
        assertEq(uint256(vault.getBatch(batchId).status), uint256(BatchVault.BatchStatus.SETTLING));
    }

    function _buildSettleParams(BatchVault.RevealedOrder[] memory orders, uint256 clearingPrice)
        internal
        pure
        returns (
            uint256 totalBuyVol,
            uint256 totalSellVol,
            uint256 netBuyAmount
        )
    {
        for (uint256 i = 0; i < orders.length; i++) {
            bool fills = orders[i].isBuy
                ? orders[i].limitPrice >= clearingPrice
                : orders[i].limitPrice <= clearingPrice;

            if (!fills) continue;

            if (orders[i].isBuy) {
                totalBuyVol += orders[i].amount;
                netBuyAmount += orders[i].amount;
            } else {
                totalSellVol += orders[i].amount;
                if (netBuyAmount >= orders[i].amount) {
                    netBuyAmount -= orders[i].amount;
                } else {
                    netBuyAmount = 0;
                }
            }
        }
    }

    // ─── Tests: batch lifecycle ────────────────────────────────────────────

    function test_openBatch() public {
        uint256 batchId = _openBatch();
        assertEq(batchId, 1);
        assertEq(vault.currentBatchId(), 1);
        assertEq(uint256(vault.getBatch(1).status), uint256(BatchVault.BatchStatus.OPEN));
        assertEq(vault.getBatch(1).marketId, MARKET_ID);
    }

    function test_openBatch_onlyRelayer() public {
        vm.expectRevert(BatchVault.OnlyRelayer.selector);
        vault.openBatch(MARKET_ID);
    }

    function test_closeBatch_beforeWindow_reverts() public {
        _openBatch();
        vm.expectRevert(BatchVault.BatchWindowNotClosed.selector);
        vault.closeBatch();
    }

    function test_closeBatch_afterWindow_succeeds() public {
        uint256 batchId = _openBatch();
        _closeBatch(batchId);
    }

    // ─── Tests: order commitment ───────────────────────────────────────────

    function test_commitOrder_basic() public {
        _openBatch();

        bytes32 salt = bytes32(uint256(42));
        uint256 amount = 100e6;
        uint256 limitPrice = 650000; // $0.65

        bytes32 commitment = _makeCommitment(MARKET_ID, true, amount, limitPrice, salt, alice);

        vm.prank(alice);
        vault.commitOrder(commitment, amount);

        assertEq(usdc.balanceOf(address(vault)), amount);
        assertEq(vault.getBatch(1).commitmentCount, 1);
        assertEq(vault.getBatch(1).totalDeposited, amount);
    }

    function test_commitOrder_emitsEvent() public {
        _openBatch();
        bytes32 salt = bytes32(uint256(1));
        uint256 amount = 50e6;
        bytes32 commitment = _makeCommitment(MARKET_ID, true, amount, 600000, salt, alice);

        vm.expectEmit(true, true, false, true);
        emit BatchVault.OrderCommitted(1, alice, commitment, amount);

        vm.prank(alice);
        vault.commitOrder(commitment, amount);
    }

    function test_commitOrder_duplicateReverts() public {
        _openBatch();
        bytes32 commitment = _makeCommitment(MARKET_ID, true, 100e6, 650000, bytes32(uint256(1)), alice);

        vm.prank(alice);
        vault.commitOrder(commitment, 100e6);

        // Second commitment from same trader should revert
        vm.expectRevert(BatchVault.AlreadyCommitted.selector);
        vm.prank(alice);
        vault.commitOrder(commitment, 100e6);
    }

    function test_commitOrder_whenBatchClosed_reverts() public {
        uint256 batchId = _openBatch();
        _closeBatch(batchId);

        bytes32 commitment = _makeCommitment(MARKET_ID, true, 100e6, 650000, bytes32(uint256(1)), alice);
        vm.expectRevert(BatchVault.BatchNotOpen.selector);
        vm.prank(alice);
        vault.commitOrder(commitment, 100e6);
    }

    function test_commitOrder_zeroAmountReverts() public {
        _openBatch();
        bytes32 commitment = bytes32(uint256(1));
        vm.expectRevert(BatchVault.ZeroAmount.selector);
        vm.prank(alice);
        vault.commitOrder(commitment, 0);
    }

    // ─── Tests: batch settlement ───────────────────────────────────────────

    function test_settleBatch_threeTraders() public {
        uint256 batchId = _openBatch();

        // Alice: buy 100 USDC at max $0.70
        // Bob: buy 50 USDC at max $0.65
        // Carol: sell 80 USDC at min $0.60 (sell YES, buy NO)
        bytes32 saltAlice = bytes32(uint256(1));
        bytes32 saltBob = bytes32(uint256(2));
        bytes32 saltCarol = bytes32(uint256(3));

        uint256 amtAlice = 100e6;
        uint256 amtBob = 50e6;
        uint256 amtCarol = 80e6;

        uint256 limitAlice = 700000; // 0.70
        uint256 limitBob = 650000;   // 0.65
        uint256 limitCarol = 600000; // 0.60 (sell: fill if clearing <= 0.60... wait, sell fills if limitPrice <= clearingPrice)

        bytes32 cAlice = _makeCommitment(MARKET_ID, true, amtAlice, limitAlice, saltAlice, alice);
        bytes32 cBob = _makeCommitment(MARKET_ID, true, amtBob, limitBob, saltBob, bob);
        bytes32 cCarol = _makeCommitment(MARKET_ID, false, amtCarol, limitCarol, saltCarol, carol);

        vm.prank(alice);
        vault.commitOrder(cAlice, amtAlice);
        vm.prank(bob);
        vault.commitOrder(cBob, amtBob);
        vm.prank(carol);
        vault.commitOrder(cCarol, amtCarol);

        _closeBatch(batchId);

        // Clearing price: 0.65 (maximizes filled volume)
        // At 0.65: Alice fills (0.70 >= 0.65), Bob fills (0.65 >= 0.65), Carol fills (0.60 <= 0.65)
        // Buy vol: 150, Sell vol: 80, Net buy: 70
        uint256 clearingPrice = 650000;

        BatchVault.RevealedOrder[] memory orders = new BatchVault.RevealedOrder[](3);
        orders[0] = BatchVault.RevealedOrder(alice, true, amtAlice, limitAlice, saltAlice);
        orders[1] = BatchVault.RevealedOrder(bob, true, amtBob, limitBob, saltBob);
        orders[2] = BatchVault.RevealedOrder(carol, false, amtCarol, limitCarol, saltCarol);

        (uint256 buyVol, uint256 sellVol, uint256 netBuy) = _buildSettleParams(orders, clearingPrice);

        vm.prank(relayer);
        vault.settleBatch(batchId, orders, clearingPrice, buyVol, sellVol, netBuy, "");

        BatchVault.Batch memory b = vault.getBatch(batchId);
        assertEq(uint256(b.status), uint256(BatchVault.BatchStatus.SETTLED));
        assertEq(b.clearingPrice, clearingPrice);
        assertEq(b.netBuyAmount, netBuy);
    }

    function test_settleBatch_wrongCommitment_reverts() public {
        uint256 batchId = _openBatch();

        bytes32 salt = bytes32(uint256(1));
        bytes32 commitment = _makeCommitment(MARKET_ID, true, 100e6, 650000, salt, alice);

        vm.prank(alice);
        vault.commitOrder(commitment, 100e6);
        _closeBatch(batchId);

        // Tampered order: different limit price than committed
        BatchVault.RevealedOrder[] memory orders = new BatchVault.RevealedOrder[](1);
        orders[0] = BatchVault.RevealedOrder(alice, true, 100e6, 700000, salt); // 700000 != 650000

        vm.expectRevert(BatchVault.CommitmentMismatch.selector);
        vm.prank(relayer);
        vault.settleBatch(batchId, orders, 650000, 100e6, 0, 100e6, "");
    }

    function test_settleBatch_invalidClearingPrice_reverts() public {
        uint256 batchId = _openBatch();

        bytes32 salt = bytes32(uint256(1));
        bytes32 commitment = _makeCommitment(MARKET_ID, true, 100e6, 650000, salt, alice);
        vm.prank(alice);
        vault.commitOrder(commitment, 100e6);
        _closeBatch(batchId);

        BatchVault.RevealedOrder[] memory orders = new BatchVault.RevealedOrder[](1);
        orders[0] = BatchVault.RevealedOrder(alice, true, 100e6, 650000, salt);

        // Price of 0 is invalid
        vm.expectRevert(BatchVault.InvalidClearingPrice.selector);
        vm.prank(relayer);
        vault.settleBatch(batchId, orders, 0, 100e6, 0, 100e6, "");
    }

    // ─── Tests: claim position ─────────────────────────────────────────────

    function test_claimPosition_refundOnUnfilled() public {
        uint256 batchId = _openBatch();

        // Alice bids too low to fill (limit 0.40, clearing will be 0.65)
        bytes32 salt = bytes32(uint256(1));
        uint256 amount = 100e6;
        uint256 limitAlice = 400000; // 0.40 — won't fill

        bytes32 commitment = _makeCommitment(MARKET_ID, true, amount, limitAlice, salt, alice);
        vm.prank(alice);
        vault.commitOrder(commitment, amount);
        _closeBatch(batchId);

        BatchVault.RevealedOrder[] memory orders = new BatchVault.RevealedOrder[](1);
        orders[0] = BatchVault.RevealedOrder(alice, true, amount, limitAlice, salt);

        // Clearing at 0.65 — alice's 0.40 limit doesn't fill
        vm.prank(relayer);
        vault.settleBatch(batchId, orders, 650000, 0, 0, 0, "");

        uint256 balanceBefore = usdc.balanceOf(alice);

        vm.prank(alice);
        vault.claimPosition(batchId);

        // Full refund since order didn't fill
        assertEq(usdc.balanceOf(alice), balanceBefore + amount);
    }

    function test_claimPosition_doubleClaim_reverts() public {
        uint256 batchId = _openBatch();

        bytes32 salt = bytes32(uint256(1));
        bytes32 commitment = _makeCommitment(MARKET_ID, true, 100e6, 400000, salt, alice);
        vm.prank(alice);
        vault.commitOrder(commitment, 100e6);
        _closeBatch(batchId);

        BatchVault.RevealedOrder[] memory orders = new BatchVault.RevealedOrder[](1);
        orders[0] = BatchVault.RevealedOrder(alice, true, 100e6, 400000, salt);
        vm.prank(relayer);
        vault.settleBatch(batchId, orders, 650000, 0, 0, 0, "");

        vm.prank(alice);
        vault.claimPosition(batchId);

        vm.expectRevert(BatchVault.AlreadyClaimed.selector);
        vm.prank(alice);
        vault.claimPosition(batchId);
    }

    // ─── Tests: privacy properties ─────────────────────────────────────────

    function test_privacy_onlyCommitmentsOnchain_beforeSettlement() public {
        _openBatch();

        bytes32 salt = bytes32(uint256(42));
        uint256 amount = 100e6;
        bool isBuy = true;
        uint256 limitPrice = 720000;

        bytes32 commitment = _makeCommitment(MARKET_ID, isBuy, amount, limitPrice, salt, alice);

        vm.prank(alice);
        vault.commitOrder(commitment, amount);

        // On-chain commitment reveals only the hash — not direction, price, or salt
        BatchVault.Commitment memory c = vault.getCommitment(1, 0);
        assertEq(c.hash, commitment);   // hash is visible
        assertEq(c.amount, amount);     // amount locked is visible (can't avoid this)
        assertEq(c.trader, alice);      // trader address is visible (from tx sender)
        // But isBuy, limitPrice, and salt are NOT stored — they only exist in the hash
    }

    // ─── Tests: commitOrderFor (EIP-712 meta-transactions) ────────────────

    /// @dev Sign a CommitOrder EIP-712 payload with a known private key.
    function _signCommitOrder(
        uint256 signerKey,
        bytes32 commitment,
        uint256 amount,
        uint256 batchId,
        uint256 nonce,
        uint256 deadline
    ) internal view returns (bytes memory signature) {
        bytes32 structHash = keccak256(abi.encode(
            vault.COMMITMENT_TYPEHASH(),
            commitment,
            amount,
            batchId,
            nonce,
            deadline
        ));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", vault.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, digest);
        return abi.encodePacked(r, s, v); // 65 bytes: r(32) || s(32) || v(1)
    }

    function test_commitOrderFor_basic() public {
        uint256 batchId = _openBatch();

        // Dave has a known private key — his address never appears as msg.sender
        uint256 daveKey = 0xDA7E;
        address dave = vm.addr(daveKey);
        usdc.mint(dave, 1000e6);
        vm.prank(dave);
        usdc.approve(address(vault), type(uint256).max);

        uint256 amount = 100e6;
        uint256 limitPrice = 650000;
        bytes32 salt = bytes32(uint256(99));
        uint256 deadline = block.timestamp + 1 hours;

        bytes32 commitment = _makeCommitment(MARKET_ID, true, amount, limitPrice, salt, dave);
        bytes memory sig = _signCommitOrder(daveKey, commitment, amount, batchId, 0, deadline);

        // Relayer submits on Dave's behalf — Dave's address is stored as trader
        vm.prank(relayer);
        vault.commitOrderFor(commitment, amount, dave, 0, deadline, sig);

        // USDC pulled from Dave, not relayer
        assertEq(usdc.balanceOf(dave), 900e6);
        assertEq(usdc.balanceOf(address(vault)), amount);

        // Commitment stored with Dave as trader (not relayer)
        BatchVault.Commitment memory c = vault.getCommitment(batchId, 0);
        assertEq(c.trader, dave);
        assertEq(c.amount, amount);

        // Nonce incremented
        assertEq(vault.nonces(dave), 1);
    }

    function test_commitOrderFor_emitsEventWithSigner() public {
        uint256 batchId = _openBatch();
        uint256 daveKey = 0xDA7E;
        address dave = vm.addr(daveKey);
        usdc.mint(dave, 500e6);
        vm.prank(dave);
        usdc.approve(address(vault), type(uint256).max);

        bytes32 commitment = _makeCommitment(MARKET_ID, true, 50e6, 600000, bytes32(uint256(7)), dave);
        bytes memory sig = _signCommitOrder(daveKey, commitment, 50e6, batchId, 0, block.timestamp + 1 hours);

        // OrderCommitted should emit dave as trader, not relayer
        vm.expectEmit(true, true, false, true);
        emit BatchVault.OrderCommitted(batchId, dave, commitment, 50e6);

        vm.prank(relayer);
        vault.commitOrderFor(commitment, 50e6, dave, 0, block.timestamp + 1 hours, sig);
    }

    function test_commitOrderFor_invalidSignature_reverts() public {
        _openBatch();
        uint256 daveKey  = 0xDA7E;
        uint256 eveKey   = 0xEE7E; // different key
        address dave = vm.addr(daveKey);
        usdc.mint(dave, 500e6);
        vm.prank(dave);
        usdc.approve(address(vault), type(uint256).max);

        bytes32 commitment = _makeCommitment(MARKET_ID, true, 50e6, 600000, bytes32(uint256(1)), dave);
        // Sign with Eve's key but claim signer is Dave
        bytes memory badSig = _signCommitOrder(eveKey, commitment, 50e6, 1, 0, block.timestamp + 1 hours);

        vm.expectRevert(BatchVault.InvalidSignature.selector);
        vm.prank(relayer);
        vault.commitOrderFor(commitment, 50e6, dave, 0, block.timestamp + 1 hours, badSig);
    }

    function test_commitOrderFor_expiredDeadline_reverts() public {
        _openBatch();
        uint256 daveKey = 0xDA7E;
        address dave = vm.addr(daveKey);
        usdc.mint(dave, 500e6);
        vm.prank(dave);
        usdc.approve(address(vault), type(uint256).max);

        bytes32 commitment = _makeCommitment(MARKET_ID, true, 50e6, 600000, bytes32(uint256(1)), dave);
        uint256 deadline = block.timestamp - 1; // already expired
        bytes memory sig = _signCommitOrder(daveKey, commitment, 50e6, 1, 0, deadline);

        vm.expectRevert(BatchVault.SignatureExpired.selector);
        vm.prank(relayer);
        vault.commitOrderFor(commitment, 50e6, dave, 0, deadline, sig);
    }

    function test_commitOrderFor_wrongNonce_reverts() public {
        _openBatch();
        uint256 daveKey = 0xDA7E;
        address dave = vm.addr(daveKey);
        usdc.mint(dave, 500e6);
        vm.prank(dave);
        usdc.approve(address(vault), type(uint256).max);

        bytes32 commitment = _makeCommitment(MARKET_ID, true, 50e6, 600000, bytes32(uint256(1)), dave);
        // Sign with nonce=1, but actual nonce is 0
        bytes memory sig = _signCommitOrder(daveKey, commitment, 50e6, 1, 1, block.timestamp + 1 hours);

        vm.expectRevert(BatchVault.InvalidSignature.selector);
        vm.prank(relayer);
        vault.commitOrderFor(commitment, 50e6, dave, 1, block.timestamp + 1 hours, sig);
    }

    function test_commitOrderFor_replayReverts() public {
        uint256 batchId = _openBatch();
        uint256 daveKey = 0xDA7E;
        address dave = vm.addr(daveKey);
        usdc.mint(dave, 1000e6);
        vm.prank(dave);
        usdc.approve(address(vault), type(uint256).max);

        bytes32 commitment = _makeCommitment(MARKET_ID, true, 50e6, 600000, bytes32(uint256(1)), dave);
        bytes memory sig = _signCommitOrder(daveKey, commitment, 50e6, batchId, 0, block.timestamp + 1 hours);

        // First use — succeeds
        vm.prank(relayer);
        vault.commitOrderFor(commitment, 50e6, dave, 0, block.timestamp + 1 hours, sig);

        // Second use with same sig — nonce is now 1, so sig (nonce=0) is invalid
        vm.expectRevert(BatchVault.InvalidSignature.selector);
        vm.prank(relayer);
        vault.commitOrderFor(commitment, 50e6, dave, 0, block.timestamp + 1 hours, sig);
    }

    function test_commitOrderFor_settlesCorrectly() public {
        uint256 batchId = _openBatch();

        // Dave commits via meta-tx (privacy path)
        uint256 daveKey = 0xDA7E;
        address dave = vm.addr(daveKey);
        usdc.mint(dave, 500e6);
        vm.prank(dave);
        usdc.approve(address(vault), type(uint256).max);

        uint256 amount = 100e6;
        uint256 limitPrice = 650000;
        bytes32 salt = bytes32(uint256(55));

        bytes32 commitment = _makeCommitment(MARKET_ID, true, amount, limitPrice, salt, dave);
        bytes memory sig = _signCommitOrder(daveKey, commitment, amount, batchId, 0, block.timestamp + 1 hours);

        vm.prank(relayer);
        vault.commitOrderFor(commitment, amount, dave, 0, block.timestamp + 1 hours, sig);

        _closeBatch(batchId);

        // Settlement: dave's order revealed — trader=dave in RevealedOrder
        BatchVault.RevealedOrder[] memory orders = new BatchVault.RevealedOrder[](1);
        orders[0] = BatchVault.RevealedOrder(dave, true, amount, limitPrice, salt);

        vm.prank(relayer);
        vault.settleBatch(batchId, orders, 650000, amount, 0, amount, "");

        assertEq(uint256(vault.getBatch(batchId).status), uint256(BatchVault.BatchStatus.SETTLED));

        // Dave can claim his position
        BatchVault.Position memory pos = vault.getPosition(batchId, dave);
        assertEq(pos.filledAmount, amount);
    }

    // ─── Tests: relayer access control ────────────────────────────────────

    function test_settleByNonRelayer_reverts() public {
        uint256 batchId = _openBatch();

        bytes32 commitment = _makeCommitment(MARKET_ID, true, 100e6, 650000, bytes32(uint256(1)), alice);
        vm.prank(alice);
        vault.commitOrder(commitment, 100e6);
        _closeBatch(batchId);

        BatchVault.RevealedOrder[] memory orders = new BatchVault.RevealedOrder[](1);
        orders[0] = BatchVault.RevealedOrder(alice, true, 100e6, 650000, bytes32(uint256(1)));

        vm.expectRevert(BatchVault.OnlyRelayer.selector);
        vm.prank(alice);
        vault.settleBatch(batchId, orders, 650000, 100e6, 0, 100e6, "");
    }
}
