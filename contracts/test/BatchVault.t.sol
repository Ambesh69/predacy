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

/// @notice Minimal CTF mock — uses real token ID computation matching BatchVault._getYesTokenId
contract MockCTF {
    mapping(address => mapping(uint256 => uint256)) public balanceOf;
    mapping(address => mapping(address => bool)) public isApprovedForAll;

    uint256 public splitCallCount;
    uint256 public lastSplitAmount;

    function splitPosition(
        address collateralToken,
        bytes32, /*parentCollectionId*/
        bytes32 conditionId,
        uint256[] calldata, /*partition*/
        uint256 amount
    ) external {
        splitCallCount++;
        lastSplitAmount = amount;
        // Mint YES and NO tokens using IDs that match _getYesTokenId / _getNoTokenId
        bytes32 yesCollectionId = keccak256(abi.encode(conditionId, uint256(2)));
        uint256 yesTokenId = uint256(keccak256(abi.encode(collateralToken, yesCollectionId)));
        bytes32 noCollectionId  = keccak256(abi.encode(conditionId, uint256(1)));
        uint256 noTokenId  = uint256(keccak256(abi.encode(collateralToken, noCollectionId)));
        balanceOf[msg.sender][yesTokenId] += amount;
        balanceOf[msg.sender][noTokenId]  += amount;
    }

    /// @dev Mint YES tokens directly (used in tests to give sellers an initial balance)
    function mintYes(address collateralToken, bytes32 conditionId, address to, uint256 amount) external {
        bytes32 yesCollectionId = keccak256(abi.encode(conditionId, uint256(2)));
        uint256 yesTokenId = uint256(keccak256(abi.encode(collateralToken, yesCollectionId)));
        balanceOf[to][yesTokenId] += amount;
    }

    function safeTransferFrom(address from, address to, uint256 id, uint256 amount, bytes calldata) external {
        require(from == msg.sender || isApprovedForAll[from][msg.sender], "MockCTF: not approved");
        balanceOf[from][id] -= amount;
        balanceOf[to][id] += amount;
        // Notify receiver if it's a contract (simplified — just check return value)
        if (_isContract(to)) {
            bytes4 retval = BatchVault(payable(to)).onERC1155Received(msg.sender, from, id, amount, "");
            require(retval == 0xf23a6e61, "MockCTF: receiver rejected");
        }
    }

    function setApprovalForAll(address operator, bool approved) external {
        isApprovedForAll[msg.sender][operator] = approved;
    }

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

    function _isContract(address addr) internal view returns (bool) {
        uint256 size;
        assembly { size := extcodesize(addr) }
        return size > 0;
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

        // Fund traders with USDC
        usdc.mint(alice, 1000e6);
        usdc.mint(bob, 1000e6);
        usdc.mint(carol, 1000e6);

        // Approve vault to spend USDC
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

    /// @dev Get the YES token ID for the test market (mirrors BatchVault._getYesTokenId)
    function _yesTokenId() internal view returns (uint256) {
        bytes32 collectionId = ctf.getCollectionId(bytes32(0), MARKET_ID, 2);
        return ctf.getPositionId(address(usdc), collectionId);
    }

    /// @dev Give `trader` YES tokens (simulates having bought YES in a prior batch)
    function _mintYes(address trader, uint256 amount) internal {
        ctf.mintYes(address(usdc), MARKET_ID, trader, amount);
    }

    /// @dev Approve vault to transfer CTF tokens on behalf of trader
    function _approveVaultCTF(address trader) internal {
        vm.prank(trader);
        ctf.setApprovalForAll(address(vault), true);
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
        uint256 filledSellYes = 0;
        for (uint256 i = 0; i < orders.length; i++) {
            bool fills = orders[i].isBuy
                ? orders[i].limitPrice >= clearingPrice
                : orders[i].limitPrice <= clearingPrice;

            if (!fills) continue;

            if (orders[i].isBuy) {
                totalBuyVol += orders[i].amount;
            } else {
                totalSellVol += orders[i].amount; // YES token count
                filledSellYes += orders[i].amount;
            }
        }
        // netBuyAmount: USDC to route to Polymarket (buy vol minus USDC-equiv of sell vol)
        uint256 filledSellUSDC = filledSellYes * clearingPrice / PRICE_DECIMALS;
        netBuyAmount = totalBuyVol > filledSellUSDC ? totalBuyVol - filledSellUSDC : 0;
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

    // ─── Tests: buy order commitment ───────────────────────────────────────

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

    // ─── Tests: sell order commitment ──────────────────────────────────────

    function test_commitSellOrder_basic() public {
        _openBatch();

        uint256 yesAmount = 50e6; // 50 YES tokens
        uint256 limitPrice = 600000; // min $0.60
        bytes32 salt = bytes32(uint256(10));

        _mintYes(carol, yesAmount);
        _approveVaultCTF(carol);

        bytes32 commitment = _makeCommitment(MARKET_ID, false, yesAmount, limitPrice, salt, carol);

        vm.prank(carol);
        vault.commitSellOrder(commitment, yesAmount);

        // YES tokens transferred to vault
        assertEq(ctf.balanceOf(carol, _yesTokenId()), 0);
        assertEq(ctf.balanceOf(address(vault), _yesTokenId()), yesAmount);
        assertEq(vault.getBatch(1).commitmentCount, 1);
        assertEq(vault.getBatch(1).totalSellYes, yesAmount);
        // USDC balance of vault unchanged (no USDC deposited for sell orders)
        assertEq(vault.getBatch(1).totalDeposited, 0);
    }

    function test_commitSellOrder_zeroAmountReverts() public {
        _openBatch();
        vm.expectRevert(BatchVault.ZeroAmount.selector);
        vm.prank(carol);
        vault.commitSellOrder(bytes32(uint256(1)), 0);
    }

    function test_commitSellOrder_whenBatchClosed_reverts() public {
        uint256 batchId = _openBatch();
        _closeBatch(batchId);

        _mintYes(carol, 50e6);
        _approveVaultCTF(carol);
        bytes32 commitment = _makeCommitment(MARKET_ID, false, 50e6, 600000, bytes32(uint256(1)), carol);
        vm.expectRevert(BatchVault.BatchNotOpen.selector);
        vm.prank(carol);
        vault.commitSellOrder(commitment, 50e6);
    }

    // ─── Tests: batch settlement ───────────────────────────────────────────

    function test_settleBatch_threeTraders() public {
        uint256 batchId = _openBatch();

        // Alice: buy 100 USDC at max $0.70
        // Bob:   buy 50 USDC at max $0.65
        // Carol: sell 80 YES tokens at min $0.60
        bytes32 saltAlice = bytes32(uint256(1));
        bytes32 saltBob   = bytes32(uint256(2));
        bytes32 saltCarol = bytes32(uint256(3));

        uint256 amtAlice  = 100e6;
        uint256 amtBob    = 50e6;
        uint256 amtCarol  = 80e6; // 80 YES tokens

        uint256 limitAlice = 700000; // 0.70
        uint256 limitBob   = 650000; // 0.65
        uint256 limitCarol = 600000; // sell: fill if clearing >= 0.60

        // Buy commitments (USDC)
        bytes32 cAlice = _makeCommitment(MARKET_ID, true, amtAlice, limitAlice, saltAlice, alice);
        bytes32 cBob   = _makeCommitment(MARKET_ID, true, amtBob,   limitBob,   saltBob,   bob);
        // Sell commitment (YES tokens)
        bytes32 cCarol = _makeCommitment(MARKET_ID, false, amtCarol, limitCarol, saltCarol, carol);

        vm.prank(alice);
        vault.commitOrder(cAlice, amtAlice);
        vm.prank(bob);
        vault.commitOrder(cBob, amtBob);

        // Carol deposits YES tokens
        _mintYes(carol, amtCarol);
        _approveVaultCTF(carol);
        vm.prank(carol);
        vault.commitSellOrder(cCarol, amtCarol);

        _closeBatch(batchId);

        // Clearing price: 0.65
        // Alice fills (0.70 >= 0.65), Bob fills (0.65 >= 0.65), Carol fills (0.60 <= 0.65)
        // buyVol = 150 USDC, sellYes = 80 tokens → sellUSDC = 80 * 0.65 = 52 USDC
        // netBuy = 150 - 52 = 98 USDC → Polymarket
        uint256 clearingPrice = 650000;

        BatchVault.RevealedOrder[] memory orders = new BatchVault.RevealedOrder[](3);
        orders[0] = BatchVault.RevealedOrder(alice, true,  amtAlice, limitAlice, saltAlice);
        orders[1] = BatchVault.RevealedOrder(bob,   true,  amtBob,   limitBob,   saltBob);
        orders[2] = BatchVault.RevealedOrder(carol, false, amtCarol, limitCarol, saltCarol);

        (uint256 buyVol, uint256 sellVol, uint256 netBuy) = _buildSettleParams(orders, clearingPrice);

        vm.prank(relayer);
        vault.settleBatch(batchId, orders, clearingPrice, buyVol, sellVol, netBuy, "");

        BatchVault.Batch memory b = vault.getBatch(batchId);
        assertEq(uint256(b.status), uint256(BatchVault.BatchStatus.SETTLED));
        assertEq(b.clearingPrice, clearingPrice);
        assertEq(b.netBuyAmount, netBuy);
        assertEq(b.filledSellYes, amtCarol);
        assertEq(b.totalFilledBuyVol, amtAlice + amtBob);
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

        vm.expectRevert(BatchVault.InvalidClearingPrice.selector);
        vm.prank(relayer);
        vault.settleBatch(batchId, orders, 0, 100e6, 0, 100e6, "");
    }

    // ─── Tests: claim position — buy orders ───────────────────────────────

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

        vm.prank(relayer);
        vault.settleBatch(batchId, orders, 650000, 0, 0, 0, "");

        uint256 balanceBefore = usdc.balanceOf(alice);

        vm.prank(alice);
        vault.claimPosition(batchId);

        // Full USDC refund since order didn't fill
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

    // ─── Tests: claim position — sell orders ──────────────────────────────

    function test_sellOrder_filled_claimsUSDC() public {
        uint256 batchId = _openBatch();

        // Alice buys 100 USDC of YES at max 0.70
        // Carol sells 80 YES tokens at min 0.60 — will fill at clearing 0.65
        uint256 amtAlice = 100e6;
        uint256 yesCarol = 80e6; // 80 YES tokens
        bytes32 saltAlice = bytes32(uint256(1));
        bytes32 saltCarol = bytes32(uint256(2));

        bytes32 cAlice = _makeCommitment(MARKET_ID, true, amtAlice, 700000, saltAlice, alice);
        bytes32 cCarol = _makeCommitment(MARKET_ID, false, yesCarol, 600000, saltCarol, carol);

        vm.prank(alice);
        vault.commitOrder(cAlice, amtAlice);

        _mintYes(carol, yesCarol);
        _approveVaultCTF(carol);
        vm.prank(carol);
        vault.commitSellOrder(cCarol, yesCarol);

        _closeBatch(batchId);

        uint256 clearingPrice = 650000; // 0.65
        BatchVault.RevealedOrder[] memory orders = new BatchVault.RevealedOrder[](2);
        orders[0] = BatchVault.RevealedOrder(alice, true,  amtAlice, 700000, saltAlice);
        orders[1] = BatchVault.RevealedOrder(carol, false, yesCarol, 600000, saltCarol);

        (uint256 buyVol, uint256 sellVol, uint256 netBuy) = _buildSettleParams(orders, clearingPrice);
        vm.prank(relayer);
        vault.settleBatch(batchId, orders, clearingPrice, buyVol, sellVol, netBuy, "");

        // Carol's position: filledAmount = 80 * 0.65 = 52 USDC
        BatchVault.Position memory pos = vault.getPosition(batchId, carol);
        uint256 expectedUSDC = yesCarol * clearingPrice / 1e6; // 52e6
        assertEq(pos.filledAmount, expectedUSDC);
        assertEq(pos.refundAmount, 0);
        assertFalse(pos.isBuy);

        uint256 carolUSDCBefore = usdc.balanceOf(carol);
        vm.prank(carol);
        vault.claimPosition(batchId);

        // Carol receives USDC for her sold YES tokens
        assertEq(usdc.balanceOf(carol), carolUSDCBefore + expectedUSDC);
    }

    function test_sellOrder_unfilled_refundsYES() public {
        uint256 batchId = _openBatch();

        // Carol tries to sell YES at min 0.80, but clearing price is 0.65 — won't fill
        uint256 yesCarol = 50e6;
        bytes32 saltCarol = bytes32(uint256(1));
        bytes32 cCarol = _makeCommitment(MARKET_ID, false, yesCarol, 800000, saltCarol, carol);

        _mintYes(carol, yesCarol);
        _approveVaultCTF(carol);
        vm.prank(carol);
        vault.commitSellOrder(cCarol, yesCarol);

        _closeBatch(batchId);

        BatchVault.RevealedOrder[] memory orders = new BatchVault.RevealedOrder[](1);
        orders[0] = BatchVault.RevealedOrder(carol, false, yesCarol, 800000, saltCarol);

        // Settlement with no buy orders — just need clearing price for the verify
        vm.prank(relayer);
        vault.settleBatch(batchId, orders, 650000, 0, 0, 0, "");

        // Carol's position: no fill, full refund of YES tokens
        BatchVault.Position memory pos = vault.getPosition(batchId, carol);
        assertEq(pos.filledAmount, 0);
        assertEq(pos.refundAmount, yesCarol); // YES tokens back

        uint256 carolYesBefore = ctf.balanceOf(carol, _yesTokenId());
        vm.prank(carol);
        vault.claimPosition(batchId);

        // Carol gets her YES tokens back
        assertEq(ctf.balanceOf(carol, _yesTokenId()), carolYesBefore + yesCarol);
    }

    function test_mixed_buyAndSell_yesDistribution() public {
        uint256 batchId = _openBatch();

        // Alice buys 130 USDC at 0.70, Carol sells 80 YES at 0.60
        // Clearing: 0.65
        // filledBuyVol = 130 USDC, filledSellYes = 80 → filledSellUSDC = 52
        // netBuyUSDC = 130 - 52 = 78 → Polymarket: receives 78 YES tokens
        // total YES pool = 78 (from Polymarket) + 80 (from Carol) = 158
        // Alice's share = 130/130 * 158 = 158 YES tokens
        uint256 amtAlice = 130e6;
        uint256 yesCarol = 80e6;

        bytes32 cAlice = _makeCommitment(MARKET_ID, true, amtAlice, 700000, bytes32(uint256(1)), alice);
        bytes32 cCarol = _makeCommitment(MARKET_ID, false, yesCarol, 600000, bytes32(uint256(2)), carol);

        vm.prank(alice);
        vault.commitOrder(cAlice, amtAlice);

        _mintYes(carol, yesCarol);
        _approveVaultCTF(carol);
        vm.prank(carol);
        vault.commitSellOrder(cCarol, yesCarol);

        _closeBatch(batchId);

        uint256 clearingPrice = 650000;
        BatchVault.RevealedOrder[] memory orders = new BatchVault.RevealedOrder[](2);
        orders[0] = BatchVault.RevealedOrder(alice, true,  amtAlice, 700000, bytes32(uint256(1)));
        orders[1] = BatchVault.RevealedOrder(carol, false, yesCarol, 600000, bytes32(uint256(2)));

        (uint256 buyVol, uint256 sellVol, uint256 netBuy) = _buildSettleParams(orders, clearingPrice);
        vm.prank(relayer);
        vault.settleBatch(batchId, orders, clearingPrice, buyVol, sellVol, netBuy, "");

        BatchVault.Batch memory b = vault.getBatch(batchId);
        // netBuyAmount = 130 - 80*0.65 = 130 - 52 = 78
        assertEq(b.netBuyAmount, 78e6);
        // yesTokensReceived from Polymarket split = 78e6 (prototype: 1 USDC = 1 YES)
        assertEq(b.yesTokensReceived, 78e6);
        assertEq(b.filledSellYes, yesCarol);
        assertEq(b.totalFilledBuyVol, amtAlice);

        // Alice claims: (130/130) * (78 + 80) = 158 YES tokens
        BatchVault.Position memory alicePos = vault.getPosition(batchId, alice);
        uint256 expectedYes = (alicePos.filledAmount * (b.yesTokensReceived + b.filledSellYes)) / b.totalFilledBuyVol;
        assertEq(expectedYes, 158e6);

        uint256 aliceYesBefore = ctf.balanceOf(alice, _yesTokenId());
        vm.prank(alice);
        vault.claimPosition(batchId);
        assertEq(ctf.balanceOf(alice, _yesTokenId()), aliceYesBefore + expectedYes);
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
        assertEq(c.amount, amount);     // amount locked is visible
        assertEq(c.trader, alice);      // trader address is visible
        // But isBuy, limitPrice, and salt are NOT stored — they only exist in the hash
    }

    // ─── Tests: commitOrderFor (EIP-712 meta-transactions) ────────────────

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
        return abi.encodePacked(r, s, v);
    }

    function test_commitOrderFor_basic() public {
        uint256 batchId = _openBatch();

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

        vm.prank(relayer);
        vault.commitOrderFor(commitment, amount, dave, 0, deadline, sig);

        assertEq(usdc.balanceOf(dave), 900e6);
        assertEq(usdc.balanceOf(address(vault)), amount);

        BatchVault.Commitment memory c = vault.getCommitment(batchId, 0);
        assertEq(c.trader, dave);
        assertEq(c.amount, amount);
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

        vm.expectEmit(true, true, false, true);
        emit BatchVault.OrderCommitted(batchId, dave, commitment, 50e6);

        vm.prank(relayer);
        vault.commitOrderFor(commitment, 50e6, dave, 0, block.timestamp + 1 hours, sig);
    }

    function test_commitOrderFor_invalidSignature_reverts() public {
        _openBatch();
        uint256 daveKey  = 0xDA7E;
        uint256 eveKey   = 0xEE7E;
        address dave = vm.addr(daveKey);
        usdc.mint(dave, 500e6);
        vm.prank(dave);
        usdc.approve(address(vault), type(uint256).max);

        bytes32 commitment = _makeCommitment(MARKET_ID, true, 50e6, 600000, bytes32(uint256(1)), dave);
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
        uint256 deadline = block.timestamp - 1;
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

        vm.prank(relayer);
        vault.commitOrderFor(commitment, 50e6, dave, 0, block.timestamp + 1 hours, sig);

        vm.expectRevert(BatchVault.InvalidSignature.selector);
        vm.prank(relayer);
        vault.commitOrderFor(commitment, 50e6, dave, 0, block.timestamp + 1 hours, sig);
    }

    function test_commitOrderFor_settlesCorrectly() public {
        uint256 batchId = _openBatch();

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

        BatchVault.RevealedOrder[] memory orders = new BatchVault.RevealedOrder[](1);
        orders[0] = BatchVault.RevealedOrder(dave, true, amount, limitPrice, salt);

        vm.prank(relayer);
        vault.settleBatch(batchId, orders, 650000, amount, 0, amount, "");

        assertEq(uint256(vault.getBatch(batchId).status), uint256(BatchVault.BatchStatus.SETTLED));

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
