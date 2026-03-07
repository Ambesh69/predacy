// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/BatchVault.sol";
import "../src/MockBatchVerifier.sol";

// ─── Minimal ERC-20 mock ──────────────────────────────────────────────────────

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

    /// @notice EIP-3009 stub — skips signature validation for testing.
    function transferWithAuthorization(
        address from, address to, uint256 value,
        uint256, uint256, bytes32, uint8, bytes32, bytes32
    ) external {
        balanceOf[from] -= value;
        balanceOf[to]   += value;
    }
}

// ─── Minimal CTF mock ─────────────────────────────────────────────────────────

/// @notice Implements the IConditionalTokens interface for tests.
///         - splitPosition: pulls USDC from vault (via approve set in constructor)
///         - mergePositions: burns YES+NO tokens, mints USDC to vault
///         - Token IDs match BatchVault._getYesTokenId / _getNoTokenId
contract MockCTF {
    mapping(address => mapping(uint256 => uint256)) public balanceOf;
    mapping(address => mapping(address => bool)) public isApprovedForAll;

    uint256 public splitCallCount;
    uint256 public mergeCallCount;

    event TransferSingle(address indexed op, address indexed from, address indexed to, uint256 id, uint256 value);

    // ── Token ID helpers (must match BatchVault's helpers) ──────────────────

    function getCollectionId(bytes32, bytes32 conditionId, uint256 indexSet)
        external pure returns (bytes32)
    {
        return keccak256(abi.encode(conditionId, indexSet));
    }

    function getPositionId(address collateral, bytes32 collectionId)
        external pure returns (uint256)
    {
        return uint256(keccak256(abi.encode(collateral, collectionId)));
    }

    function _yesId(address collateral, bytes32 conditionId) internal pure returns (uint256) {
        return uint256(keccak256(abi.encode(collateral, keccak256(abi.encode(conditionId, uint256(1))))));
    }

    function _noId(address collateral, bytes32 conditionId) internal pure returns (uint256) {
        return uint256(keccak256(abi.encode(collateral, keccak256(abi.encode(conditionId, uint256(2))))));
    }

    // ── Core CTF operations ─────────────────────────────────────────────────

    /// @notice Pull USDC from caller; mint `amount` YES + `amount` NO tokens.
    function splitPosition(
        address collateralToken,
        bytes32, /*parentCollectionId*/
        bytes32 conditionId,
        uint256[] calldata, /*partition*/
        uint256 amount
    ) external {
        splitCallCount++;
        // Pull USDC from vault (vault pre-approved CTF in constructor)
        MockUSDC(collateralToken).transferFrom(msg.sender, address(this), amount);
        // Mint YES + NO tokens
        uint256 yesId = _yesId(collateralToken, conditionId);
        uint256 noId  = _noId(collateralToken, conditionId);
        balanceOf[msg.sender][yesId] += amount;
        balanceOf[msg.sender][noId]  += amount;
        emit TransferSingle(msg.sender, address(0), msg.sender, yesId, amount);
        emit TransferSingle(msg.sender, address(0), msg.sender, noId,  amount);
    }

    /// @notice Burn YES + NO from caller; return `amount` USDC via mint (test shortcut).
    function mergePositions(
        address collateralToken,
        bytes32, /*parentCollectionId*/
        bytes32 conditionId,
        uint256[] calldata, /*partition*/
        uint256 amount
    ) external {
        mergeCallCount++;
        uint256 yesId = _yesId(collateralToken, conditionId);
        uint256 noId  = _noId(collateralToken, conditionId);
        require(balanceOf[msg.sender][yesId] >= amount, "MockCTF: insufficient YES for merge");
        require(balanceOf[msg.sender][noId]  >= amount, "MockCTF: insufficient NO for merge");
        balanceOf[msg.sender][yesId] -= amount;
        balanceOf[msg.sender][noId]  -= amount;
        emit TransferSingle(msg.sender, msg.sender, address(0), yesId, amount);
        emit TransferSingle(msg.sender, msg.sender, address(0), noId,  amount);
        // Return USDC to caller
        MockUSDC(collateralToken).mint(msg.sender, amount);
    }

    // ── ERC-1155 ────────────────────────────────────────────────────────────

    function safeTransferFrom(address from, address to, uint256 id, uint256 amount, bytes calldata) external {
        require(from == msg.sender || isApprovedForAll[from][msg.sender], "MockCTF: not approved");
        require(balanceOf[from][id] >= amount, "MockCTF: insufficient balance");
        balanceOf[from][id]  -= amount;
        balanceOf[to][id]    += amount;
        if (_isContract(to)) {
            bytes4 retval = BatchVault(payable(to)).onERC1155Received(msg.sender, from, id, amount, "");
            require(retval == 0xf23a6e61, "MockCTF: receiver rejected");
        }
        emit TransferSingle(msg.sender, from, to, id, amount);
    }

    function setApprovalForAll(address operator, bool approved) external {
        isApprovedForAll[msg.sender][operator] = approved;
    }

    // ── Test helpers ────────────────────────────────────────────────────────

    function mintYes(address collateral, bytes32 conditionId, address to, uint256 amount) external {
        balanceOf[to][_yesId(collateral, conditionId)] += amount;
    }

    function mintNo(address collateral, bytes32 conditionId, address to, uint256 amount) external {
        balanceOf[to][_noId(collateral, conditionId)] += amount;
    }

    /// @notice Stub — not used in v9 tests
    function mockBuyYes(address, bytes32, uint256, uint256) external pure returns (uint256) { return 0; }
    function mockSellYes(address, bytes32, uint256, uint256) external pure returns (uint256) { return 0; }
    function payoutNumerators(bytes32, uint256) external pure returns (uint256) { return 0; }
    function payoutDenominator(bytes32) external pure returns (uint256) { return 0; }
    function redeemPositions(address, bytes32, bytes32, uint256[] calldata) external pure {}
    function getConditionId(address, bytes32, uint256) external pure returns (bytes32) { return bytes32(0); }

    function _isContract(address addr) internal view returns (bool) {
        uint256 size;
        assembly { size := extcodesize(addr) }
        return size > 0;
    }
}

// ─── Test contract ────────────────────────────────────────────────────────────

contract BatchVaultTest is Test {
    BatchVault public vault;
    MockBatchVerifier public verifier;
    MockUSDC public usdc;
    MockCTF public ctf;

    address public relayer = address(0xBEEF);
    address public alice   = address(0xA);
    address public bob     = address(0xB);
    address public carol   = address(0xC);
    address public dave    = address(0xD);

    bytes32 public constant MARKET_ID     = keccak256("polymarket:will-eth-reach-5k");
    uint256 public constant PRICE_DECIMALS = 1e6;
    uint256 public constant CLEARING_PRICE = 650_000; // $0.65

    function setUp() public {
        usdc     = new MockUSDC();
        ctf      = new MockCTF();
        verifier = new MockBatchVerifier();
        vault    = new BatchVault(address(usdc), address(ctf), relayer, address(verifier), address(verifier));

        // Fund traders with USDC
        usdc.mint(alice, 1_000e6);
        usdc.mint(bob,   1_000e6);
        usdc.mint(carol, 1_000e6);
        usdc.mint(dave,  1_000e6);

        // Approve vault to spend USDC (for EIP-3009 stub in MockUSDC)
        vm.prank(alice); usdc.approve(address(vault), type(uint256).max);
        vm.prank(bob);   usdc.approve(address(vault), type(uint256).max);
        vm.prank(carol); usdc.approve(address(vault), type(uint256).max);
        vm.prank(dave);  usdc.approve(address(vault), type(uint256).max);

        // Relayer: pre-minted YES + NO tokens for gap-fill edge cases
        ctf.mintYes(address(usdc), MARKET_ID, relayer, 1_000_000e6);
        ctf.mintNo(address(usdc),  MARKET_ID, relayer, 1_000_000e6);
        vm.prank(relayer);
        ctf.setApprovalForAll(address(vault), true);

        // Relayer: USDC approval for vault to pull (finalExcess USDC path)
        usdc.mint(relayer, 1_000_000e6);
        vm.prank(relayer);
        usdc.approve(address(vault), type(uint256).max);
    }

    // ─── Helpers ─────────────────────────────────────────────────────────────

    function _openBatch() internal returns (uint256 batchId) {
        vm.prank(relayer);
        batchId = vault.openBatch(MARKET_ID);
    }

    function _closeBatch(uint256 batchId) internal {
        vm.warp(block.timestamp + vault.BATCH_WINDOW() + 1);
        vault.closeBatch(MARKET_ID);
        assertEq(uint256(vault.getBatch(batchId).status), uint256(BatchVault.BatchStatus.SETTLING));
    }

    /// @dev Commitment hash — mirrors BatchVault._verifyCommitments
    function _commitment(
        BatchVault.OrderSide side,
        uint256 amount,
        uint256 limitPrice,
        bytes32 salt
    ) internal pure returns (bytes32) {
        return keccak256(abi.encode(MARKET_ID, uint8(side), amount, limitPrice, salt));
    }

    function _yesTokenId() internal view returns (uint256) {
        bytes32 colId = ctf.getCollectionId(bytes32(0), MARKET_ID, 1);
        return ctf.getPositionId(address(usdc), colId);
    }

    function _noTokenId() internal view returns (uint256) {
        bytes32 colId = ctf.getCollectionId(bytes32(0), MARKET_ID, 2);
        return ctf.getPositionId(address(usdc), colId);
    }

    function _mintYes(address trader, uint256 amount) internal {
        ctf.mintYes(address(usdc), MARKET_ID, trader, amount);
        vm.prank(trader);
        ctf.setApprovalForAll(address(vault), true);
    }

    function _mintNo(address trader, uint256 amount) internal {
        ctf.mintNo(address(usdc), MARKET_ID, trader, amount);
        vm.prank(trader);
        ctf.setApprovalForAll(address(vault), true);
    }

    function _zeroAuth() internal pure returns (BatchVault.TransferAuth memory) {
        return BatchVault.TransferAuth({ from: address(0), validAfter: 0, validBefore: 0, nonce: bytes32(0), v: 0, r: bytes32(0), s: bytes32(0) });
    }

    function _buyAuth(address from) internal pure returns (BatchVault.TransferAuth memory) {
        return BatchVault.TransferAuth({ from: from, validAfter: 0, validBefore: 0, nonce: bytes32(0), v: 0, r: bytes32(0), s: bytes32(0) });
    }

    function _buildAuths(uint256 count) internal pure returns (BatchVault.TransferAuth[] memory auths) {
        auths = new BatchVault.TransferAuth[](count);
        for (uint256 i = 0; i < count; i++) auths[i] = _zeroAuth();
    }

    /// @dev Compute settlement volumes at a clearing price.
    function _buildSettleParams(
        BatchVault.RevealedOrder[] memory orders,
        uint256 clearingPrice
    ) internal pure returns (
        uint256 filledYesBuyVol,
        uint256 filledNoBuyVol,
        uint256 filledYesSellQty,
        uint256 filledNoSellQty
    ) {
        uint256 noPrice = PRICE_DECIMALS - clearingPrice;
        for (uint256 i = 0; i < orders.length; i++) {
            BatchVault.RevealedOrder memory o = orders[i];
            bool fills;
            if      (o.side == BatchVault.OrderSide.YES_BUY)  fills = o.limitPrice >= clearingPrice;
            else if (o.side == BatchVault.OrderSide.YES_SELL) fills = o.limitPrice <= clearingPrice;
            else if (o.side == BatchVault.OrderSide.NO_BUY)   fills = o.limitPrice >= noPrice;
            else                                                fills = o.limitPrice <= noPrice; // NO_SELL

            if (!fills) continue;
            if      (o.side == BatchVault.OrderSide.YES_BUY)  filledYesBuyVol  += o.amount;
            else if (o.side == BatchVault.OrderSide.YES_SELL) filledYesSellQty += o.amount;
            else if (o.side == BatchVault.OrderSide.NO_BUY)   filledNoBuyVol   += o.amount;
            else                                                filledNoSellQty  += o.amount;
        }
    }

    /// @dev Two-phase settlement helper: lockFunds → settleBatch.
    ///      Equivalent to the old single-tx settleBatch in v8.
    function _settle(
        uint256 batchId,
        BatchVault.RevealedOrder[] memory orders,
        BatchVault.TransferAuth[] memory auths,
        uint256 clearingPrice
    ) internal {
        (uint256 yb, uint256 nb, uint256 ys, uint256 ns) = _buildSettleParams(orders, clearingPrice);
        vm.prank(relayer);
        vault.lockFunds(batchId, orders, auths, clearingPrice, yb, nb, ys, ns);
        vm.prank(relayer);
        vault.settleBatch(batchId, "");
    }

    function _buildClaimPublicInputs(
        uint256 batchId,
        bytes32 claimMerkleRoot,
        uint256 clearingPrice,
        bytes32 commitment,
        bytes32 salt,
        address recipient,
        bool    fills,
        uint256 fillAmount,
        uint256 refundAmount,
        BatchVault.OrderSide side
    ) internal pure returns (bytes32[] memory inputs) {
        bytes32 nullifier = keccak256(abi.encode(commitment, batchId, salt));
        inputs = new bytes32[](11);
        inputs[0]  = bytes32(batchId);
        inputs[1]  = bytes32(uint256(claimMerkleRoot) >> 128);
        inputs[2]  = bytes32(uint256(claimMerkleRoot) & type(uint128).max);
        inputs[3]  = bytes32(clearingPrice);
        inputs[4]  = bytes32(uint256(nullifier) >> 128);
        inputs[5]  = bytes32(uint256(nullifier) & type(uint128).max);
        inputs[6]  = bytes32(uint256(uint160(recipient)));
        inputs[7]  = bytes32(fills ? uint256(1) : 0);
        inputs[8]  = bytes32(fillAmount);
        inputs[9]  = bytes32(refundAmount);
        inputs[10] = bytes32(uint256(side));
    }

    function _signCommitOrder(
        uint256 signerKey,
        bytes32 commitment,
        uint256 amount,
        uint256 nonce,
        uint256 deadline
    ) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(abi.encode(
            vault.COMMITMENT_TYPEHASH(), commitment, amount, nonce, deadline
        ));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", vault.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, digest);
        return abi.encodePacked(r, s, v);
    }

    // ─── Tests: batch lifecycle ───────────────────────────────────────────────

    function test_openBatch() public {
        uint256 batchId = _openBatch();
        assertEq(batchId, 1);
        assertEq(vault.getCurrentBatchId(MARKET_ID), 1);
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
        vault.closeBatch(MARKET_ID);
    }

    function test_closeBatch_afterWindow() public {
        uint256 batchId = _openBatch();
        _closeBatch(batchId);
    }

    // ─── Tests: YES BUY commitments ──────────────────────────────────────────

    function test_commitOrder_basic() public {
        _openBatch();
        bytes32 salt = bytes32(uint256(1));
        bytes32 c = _commitment(BatchVault.OrderSide.YES_BUY, 100e6, 650_000, salt);
        vm.prank(alice);
        vault.commitOrder(c, 100e6, MARKET_ID);
        assertEq(usdc.balanceOf(address(vault)), 0); // EIP-3009: no USDC at commit
        assertEq(vault.getBatch(1).commitmentCount, 1);
        assertEq(vault.getBatch(1).totalDeposited, 100e6);
    }

    function test_commitOrder_emitsEvent() public {
        _openBatch();
        bytes32 c = _commitment(BatchVault.OrderSide.YES_BUY, 50e6, 600_000, bytes32(uint256(1)));
        vm.expectEmit(true, true, false, false);
        emit BatchVault.OrderCommitted(1, c);
        vm.prank(alice);
        vault.commitOrder(c, 50e6, MARKET_ID);
    }

    function test_commitOrder_duplicate_reverts() public {
        _openBatch();
        bytes32 c = _commitment(BatchVault.OrderSide.YES_BUY, 100e6, 650_000, bytes32(uint256(1)));
        vm.prank(alice); vault.commitOrder(c, 100e6, MARKET_ID);
        vm.expectRevert(BatchVault.DuplicateCommitment.selector);
        vm.prank(alice); vault.commitOrder(c, 100e6, MARKET_ID);
    }

    function test_commitOrder_whenClosed_reverts() public {
        uint256 batchId = _openBatch(); _closeBatch(batchId);
        bytes32 c = _commitment(BatchVault.OrderSide.YES_BUY, 100e6, 650_000, bytes32(uint256(1)));
        vm.expectRevert(BatchVault.BatchNotOpen.selector);
        vm.prank(alice); vault.commitOrder(c, 100e6, MARKET_ID);
    }

    function test_commitOrder_zeroAmount_reverts() public {
        _openBatch();
        vm.expectRevert(BatchVault.ZeroAmount.selector);
        vm.prank(alice); vault.commitOrder(bytes32(uint256(1)), 0, MARKET_ID);
    }

    // ─── Tests: YES SELL commitments ─────────────────────────────────────────

    function test_commitSellOrder_basic() public {
        _openBatch();
        uint256 yesAmt = 50e6;
        bytes32 c = _commitment(BatchVault.OrderSide.YES_SELL, yesAmt, 600_000, bytes32(uint256(1)));
        _mintYes(carol, yesAmt);
        vm.prank(carol); vault.commitSellOrder(c, yesAmt, MARKET_ID);
        assertEq(ctf.balanceOf(carol, _yesTokenId()), 0);
        assertEq(ctf.balanceOf(address(vault), _yesTokenId()), yesAmt);
        assertEq(vault.getBatch(1).totalSellYes, yesAmt);
    }

    function test_commitSellOrder_zeroAmount_reverts() public {
        _openBatch();
        vm.expectRevert(BatchVault.ZeroAmount.selector);
        vm.prank(carol); vault.commitSellOrder(bytes32(uint256(1)), 0, MARKET_ID);
    }

    // ─── Tests: NO BUY commitments ───────────────────────────────────────────

    function test_commitBuyNoOrder_basic() public {
        _openBatch();
        uint256 amt = 40e6;
        bytes32 c = _commitment(BatchVault.OrderSide.NO_BUY, amt, 400_000, bytes32(uint256(1)));
        vm.prank(bob); vault.commitBuyNoOrder(c, amt, MARKET_ID);
        assertEq(usdc.balanceOf(address(vault)), 0); // EIP-3009 deferred
        assertEq(vault.getBatch(1).totalDepositedNo, amt);
        assertEq(vault.getBatch(1).commitmentCount, 1);
    }

    // ─── Tests: NO SELL commitments ──────────────────────────────────────────

    function test_commitSellNoOrder_basic() public {
        _openBatch();
        uint256 noAmt = 80e6;
        bytes32 c = _commitment(BatchVault.OrderSide.NO_SELL, noAmt, 350_000, bytes32(uint256(1)));
        _mintNo(dave, noAmt);
        vm.prank(dave); vault.commitSellNoOrder(c, noAmt, MARKET_ID);
        assertEq(ctf.balanceOf(dave, _noTokenId()), 0);
        assertEq(ctf.balanceOf(address(vault), _noTokenId()), noAmt);
        assertEq(vault.getBatch(1).totalSellNo, noAmt);
    }

    // ─── Tests: settlement — pure split (YES + NO buyers, no sellers) ────────

    /// @notice YES buyers + NO buyers → CTF.splitPosition. Zero capital.
    function test_settle_pureSplit_yesBuyAndNoBuy() public {
        uint256 batchId = _openBatch();
        // Alice: 65 USDC YES BUY at 0.70 → fills at 0.65, gets 100 YES
        // Bob:   35 USDC NO BUY at 0.40 → fills at 0.35, gets 100 NO
        bytes32 sA = bytes32(uint256(1));
        bytes32 sB = bytes32(uint256(2));
        bytes32 cA = _commitment(BatchVault.OrderSide.YES_BUY, 65e6, 700_000, sA);
        bytes32 cB = _commitment(BatchVault.OrderSide.NO_BUY,  35e6, 400_000, sB);

        vm.prank(alice); vault.commitOrder(cA, 65e6, MARKET_ID);
        vm.prank(bob);   vault.commitBuyNoOrder(cB, 35e6, MARKET_ID);
        _closeBatch(batchId);

        BatchVault.RevealedOrder[] memory orders = new BatchVault.RevealedOrder[](2);
        orders[0] = BatchVault.RevealedOrder(BatchVault.OrderSide.YES_BUY, 65e6, 700_000, sA);
        orders[1] = BatchVault.RevealedOrder(BatchVault.OrderSide.NO_BUY,  35e6, 400_000, sB);

        BatchVault.TransferAuth[] memory auths = new BatchVault.TransferAuth[](2);
        auths[0] = _buyAuth(alice);
        auths[1] = _buyAuth(bob);

        (uint256 yb, uint256 nb, uint256 ys, uint256 ns) = _buildSettleParams(orders, CLEARING_PRICE);
        assertEq(yb, 65e6);
        assertEq(nb, 35e6);
        assertEq(ys, 0);
        assertEq(ns, 0);

        uint256 ctfSplitBefore = ctf.splitCallCount();

        // Phase 1: lockFunds — pulls USDC, calls CTF.split
        vm.prank(relayer);
        vault.lockFunds(batchId, orders, auths, CLEARING_PRICE, yb, nb, ys, ns);

        // CTF.splitPosition was called once in lockFunds (100 USDC → 100 YES + 100 NO)
        assertEq(ctf.splitCallCount(), ctfSplitBefore + 1);
        // Vault holds 100 YES and 100 NO tokens (splitQty = min(100, 100) = 100)
        assertEq(ctf.balanceOf(address(vault), _yesTokenId()), 100e6);
        assertEq(ctf.balanceOf(address(vault), _noTokenId()),  100e6);
        assertEq(usdc.balanceOf(address(vault)), 0); // all USDC went to split
        assertEq(uint256(vault.getBatch(batchId).status), uint256(BatchVault.BatchStatus.LOCKED));

        // Phase 2: settleBatch — ZK proof + Merkle root
        vm.prank(relayer);
        vault.settleBatch(batchId, "");

        assertEq(uint256(vault.getBatch(batchId).status), uint256(BatchVault.BatchStatus.SETTLED));

        // Alice claims YES: 65e6 * 1e6 / 650000 = 100e6 YES tokens
        uint256 aliceYesBefore = ctf.balanceOf(alice, _yesTokenId());
        vm.prank(alice);
        vault.claimPosition(batchId, BatchVault.OrderSide.YES_BUY, 65e6, 700_000, sA);
        assertEq(ctf.balanceOf(alice, _yesTokenId()), aliceYesBefore + 100e6);

        // Bob claims NO: 35e6 * 1e6 / 350000 = 100e6 NO tokens
        uint256 bobNoBefore = ctf.balanceOf(bob, _noTokenId());
        vm.prank(bob);
        vault.claimPosition(batchId, BatchVault.OrderSide.NO_BUY, 35e6, 400_000, sB);
        assertEq(ctf.balanceOf(bob, _noTokenId()), bobNoBefore + 100e6);
    }

    // ─── Tests: settlement — internal YES match ───────────────────────────────

    /// @notice YES buyer ↔ YES seller → direct swap. Zero capital.
    function test_settle_yesInternalMatch() public {
        uint256 batchId = _openBatch();
        // Alice: 65 USDC YES BUY at 0.70 → fills, gets 100 YES
        // Carol: 100 YES SELL at 0.60 → fills, gets 65 USDC
        bytes32 sA = bytes32(uint256(1));
        bytes32 sC = bytes32(uint256(2));
        bytes32 cA = _commitment(BatchVault.OrderSide.YES_BUY,  65e6, 700_000, sA);
        bytes32 cC = _commitment(BatchVault.OrderSide.YES_SELL, 100e6, 600_000, sC);

        vm.prank(alice); vault.commitOrder(cA, 65e6, MARKET_ID);
        _mintYes(carol, 100e6);
        vm.prank(carol); vault.commitSellOrder(cC, 100e6, MARKET_ID);
        _closeBatch(batchId);

        BatchVault.RevealedOrder[] memory orders = new BatchVault.RevealedOrder[](2);
        orders[0] = BatchVault.RevealedOrder(BatchVault.OrderSide.YES_BUY,  65e6,  700_000, sA);
        orders[1] = BatchVault.RevealedOrder(BatchVault.OrderSide.YES_SELL, 100e6, 600_000, sC);

        BatchVault.TransferAuth[] memory auths = new BatchVault.TransferAuth[](2);
        auths[0] = _buyAuth(alice);
        auths[1] = _zeroAuth();

        (uint256 yb, uint256 nb, uint256 ys, uint256 ns) = _buildSettleParams(orders, CLEARING_PRICE);
        assertEq(yb, 65e6); assertEq(nb, 0); assertEq(ys, 100e6); assertEq(ns, 0);

        uint256 ctfSplitBefore = ctf.splitCallCount();
        _settle(batchId, orders, auths, CLEARING_PRICE);

        // No CTF split needed (direct internal match)
        assertEq(ctf.splitCallCount(), ctfSplitBefore);

        // Vault holds: 100 YES (from Carol) + 65 USDC (from Alice)
        assertEq(ctf.balanceOf(address(vault), _yesTokenId()), 100e6);
        assertEq(usdc.balanceOf(address(vault)), 65e6);

        // Alice claims YES: 65e6 / 0.65 = 100e6 YES
        vm.prank(alice);
        vault.claimPosition(batchId, BatchVault.OrderSide.YES_BUY, 65e6, 700_000, sA);
        assertEq(ctf.balanceOf(alice, _yesTokenId()), 100e6);

        // Carol claims USDC: 100e6 * 0.65 = 65e6 USDC
        uint256 carolUSDCBefore = usdc.balanceOf(carol);
        vm.prank(carol);
        vault.claimPosition(batchId, BatchVault.OrderSide.YES_SELL, 100e6, 600_000, sC);
        assertEq(usdc.balanceOf(carol), carolUSDCBefore + 65e6);
    }

    // ─── Tests: settlement — internal NO match ────────────────────────────────

    /// @notice NO buyer ↔ NO seller → direct swap. Zero capital.
    function test_settle_noInternalMatch() public {
        uint256 batchId = _openBatch();
        // Bob: 35 USDC NO BUY at 0.40 → fills at 0.35, gets 100 NO
        // Dave: 100 NO SELL at 0.30 → fills at 0.35, gets 35 USDC
        bytes32 sB = bytes32(uint256(1));
        bytes32 sD = bytes32(uint256(2));
        bytes32 cB = _commitment(BatchVault.OrderSide.NO_BUY,  35e6,  400_000, sB);
        bytes32 cD = _commitment(BatchVault.OrderSide.NO_SELL, 100e6, 300_000, sD);

        vm.prank(bob); vault.commitBuyNoOrder(cB, 35e6, MARKET_ID);
        _mintNo(dave, 100e6);
        vm.prank(dave); vault.commitSellNoOrder(cD, 100e6, MARKET_ID);
        _closeBatch(batchId);

        BatchVault.RevealedOrder[] memory orders = new BatchVault.RevealedOrder[](2);
        orders[0] = BatchVault.RevealedOrder(BatchVault.OrderSide.NO_BUY,  35e6,  400_000, sB);
        orders[1] = BatchVault.RevealedOrder(BatchVault.OrderSide.NO_SELL, 100e6, 300_000, sD);

        BatchVault.TransferAuth[] memory auths = new BatchVault.TransferAuth[](2);
        auths[0] = _buyAuth(bob);
        auths[1] = _zeroAuth();

        (uint256 yb, uint256 nb, uint256 ys, uint256 ns) = _buildSettleParams(orders, CLEARING_PRICE);
        assertEq(yb, 0); assertEq(nb, 35e6); assertEq(ys, 0); assertEq(ns, 100e6);

        _settle(batchId, orders, auths, CLEARING_PRICE);

        // Vault holds: 100 NO (from Dave) + 35 USDC (from Bob)
        assertEq(ctf.balanceOf(address(vault), _noTokenId()), 100e6);
        assertEq(usdc.balanceOf(address(vault)), 35e6);

        // Bob claims NO: 35e6 / 0.35 = 100e6 NO
        vm.prank(bob);
        vault.claimPosition(batchId, BatchVault.OrderSide.NO_BUY, 35e6, 400_000, sB);
        assertEq(ctf.balanceOf(bob, _noTokenId()), 100e6);

        // Dave claims USDC: 100e6 * 0.35 = 35e6 USDC
        uint256 daveBefore = usdc.balanceOf(dave);
        vm.prank(dave);
        vault.claimPosition(batchId, BatchVault.OrderSide.NO_SELL, 100e6, 300_000, sD);
        assertEq(usdc.balanceOf(dave), daveBefore + 35e6);
    }

    // ─── Tests: settlement — CTF merge (excess sellers) ──────────────────────

    /// @notice YES sellers + NO sellers → CTF.mergePositions → USDC. Zero capital.
    function test_settle_mergeExcessSellers() public {
        uint256 batchId = _openBatch();
        // Carol: 100 YES SELL at 0.60 → fills at 0.65, gets 65 USDC
        // Dave:  100 NO SELL at 0.30 → fills at 0.35, gets 35 USDC
        // No buyers — tokens merge to USDC
        bytes32 sC = bytes32(uint256(1));
        bytes32 sD = bytes32(uint256(2));
        bytes32 cC = _commitment(BatchVault.OrderSide.YES_SELL, 100e6, 600_000, sC);
        bytes32 cD = _commitment(BatchVault.OrderSide.NO_SELL,  100e6, 300_000, sD);

        _mintYes(carol, 100e6);
        vm.prank(carol); vault.commitSellOrder(cC, 100e6, MARKET_ID);
        _mintNo(dave, 100e6);
        vm.prank(dave); vault.commitSellNoOrder(cD, 100e6, MARKET_ID);
        _closeBatch(batchId);

        BatchVault.RevealedOrder[] memory orders = new BatchVault.RevealedOrder[](2);
        orders[0] = BatchVault.RevealedOrder(BatchVault.OrderSide.YES_SELL, 100e6, 600_000, sC);
        orders[1] = BatchVault.RevealedOrder(BatchVault.OrderSide.NO_SELL,  100e6, 300_000, sD);

        (uint256 yb, uint256 nb, uint256 ys, uint256 ns) = _buildSettleParams(orders, CLEARING_PRICE);
        assertEq(yb, 0); assertEq(nb, 0); assertEq(ys, 100e6); assertEq(ns, 100e6);

        uint256 mergeBefore = ctf.mergeCallCount();

        // Phase 1: lockFunds — merge happens here
        vm.prank(relayer);
        vault.lockFunds(batchId, orders, _buildAuths(2), CLEARING_PRICE, yb, nb, ys, ns);

        // CTF.mergePositions was called in lockFunds (100 YES + 100 NO → 100 USDC)
        assertEq(ctf.mergeCallCount(), mergeBefore + 1);
        // Vault holds 100 USDC (from merge) for sellers
        assertEq(usdc.balanceOf(address(vault)), 100e6);

        // Phase 2: settleBatch
        vm.prank(relayer);
        vault.settleBatch(batchId, "");

        // Carol claims: 100 * 0.65 = 65 USDC
        uint256 carolBefore = usdc.balanceOf(carol);
        vm.prank(carol);
        vault.claimPosition(batchId, BatchVault.OrderSide.YES_SELL, 100e6, 600_000, sC);
        assertEq(usdc.balanceOf(carol), carolBefore + 65e6);

        // Dave claims: 100 * 0.35 = 35 USDC
        uint256 daveBefore = usdc.balanceOf(dave);
        vm.prank(dave);
        vault.claimPosition(batchId, BatchVault.OrderSide.NO_SELL, 100e6, 300_000, sD);
        assertEq(usdc.balanceOf(dave), daveBefore + 35e6);

        assertEq(usdc.balanceOf(address(vault)), 0);
    }

    // ─── Tests: settlement — mixed 4-sided batch ──────────────────────────────

    function test_settle_fourSidedMixed() public {
        uint256 batchId = _openBatch();
        // Alice: 65 USDC YES BUY (gets 100 YES)
        // Bob:   35 USDC NO BUY (gets 100 NO)
        // Carol: 100 YES SELL (gets 65 USDC)
        // Dave:  100 NO SELL (gets 35 USDC)
        // All 4 sides balance perfectly — zero CTF split or merge needed (all internal match)
        bytes32 sA = bytes32(uint256(1));
        bytes32 sB = bytes32(uint256(2));
        bytes32 sC = bytes32(uint256(3));
        bytes32 sD = bytes32(uint256(4));

        bytes32 cA = _commitment(BatchVault.OrderSide.YES_BUY,  65e6,  700_000, sA);
        bytes32 cB = _commitment(BatchVault.OrderSide.NO_BUY,   35e6,  400_000, sB);
        bytes32 cC = _commitment(BatchVault.OrderSide.YES_SELL, 100e6, 600_000, sC);
        bytes32 cD = _commitment(BatchVault.OrderSide.NO_SELL,  100e6, 300_000, sD);

        vm.prank(alice); vault.commitOrder(cA, 65e6, MARKET_ID);
        vm.prank(bob);   vault.commitBuyNoOrder(cB, 35e6, MARKET_ID);
        _mintYes(carol, 100e6); vm.prank(carol); vault.commitSellOrder(cC, 100e6, MARKET_ID);
        _mintNo(dave, 100e6);   vm.prank(dave);  vault.commitSellNoOrder(cD, 100e6, MARKET_ID);
        _closeBatch(batchId);

        BatchVault.RevealedOrder[] memory orders = new BatchVault.RevealedOrder[](4);
        orders[0] = BatchVault.RevealedOrder(BatchVault.OrderSide.YES_BUY,  65e6,  700_000, sA);
        orders[1] = BatchVault.RevealedOrder(BatchVault.OrderSide.NO_BUY,   35e6,  400_000, sB);
        orders[2] = BatchVault.RevealedOrder(BatchVault.OrderSide.YES_SELL, 100e6, 600_000, sC);
        orders[3] = BatchVault.RevealedOrder(BatchVault.OrderSide.NO_SELL,  100e6, 300_000, sD);

        BatchVault.TransferAuth[] memory auths = new BatchVault.TransferAuth[](4);
        auths[0] = _buyAuth(alice);
        auths[1] = _buyAuth(bob);
        auths[2] = _zeroAuth();
        auths[3] = _zeroAuth();

        uint256 splitBefore = ctf.splitCallCount();
        uint256 mergeBefore = ctf.mergeCallCount();

        _settle(batchId, orders, auths, CLEARING_PRICE);

        // All matched internally — no split or merge needed
        assertEq(ctf.splitCallCount(), splitBefore);
        assertEq(ctf.mergeCallCount(), mergeBefore);

        // Each claimant gets correct payout
        vm.prank(alice); vault.claimPosition(batchId, BatchVault.OrderSide.YES_BUY,  65e6,  700_000, sA);
        assertEq(ctf.balanceOf(alice, _yesTokenId()), 100e6);

        vm.prank(bob);   vault.claimPosition(batchId, BatchVault.OrderSide.NO_BUY,   35e6,  400_000, sB);
        assertEq(ctf.balanceOf(bob, _noTokenId()), 100e6);

        uint256 carolBefore = usdc.balanceOf(carol);
        vm.prank(carol); vault.claimPosition(batchId, BatchVault.OrderSide.YES_SELL, 100e6, 600_000, sC);
        assertEq(usdc.balanceOf(carol), carolBefore + 65e6);

        uint256 daveBefore = usdc.balanceOf(dave);
        vm.prank(dave);  vault.claimPosition(batchId, BatchVault.OrderSide.NO_SELL,  100e6, 300_000, sD);
        assertEq(usdc.balanceOf(dave), daveBefore + 35e6);

        assertEq(usdc.balanceOf(address(vault)), 0);
    }

    // ─── Tests: settlement — YES-only batch (relayer gap fill, zero capital) ──

    /// @notice YES-only batch: vault sends gap USDC to relayer; relayer provides YES tokens.
    ///         v9: relayer uses vault-provided USDC to buy YES from CLOB — zero own capital.
    function test_settle_yesBuyOnly_relayerGapFill() public {
        uint256 batchId = _openBatch();
        // Alice: 65 USDC YES BUY → needs 100 YES from relayer
        bytes32 sA = bytes32(uint256(1));
        bytes32 cA = _commitment(BatchVault.OrderSide.YES_BUY, 65e6, 700_000, sA);
        vm.prank(alice); vault.commitOrder(cA, 65e6, MARKET_ID);
        _closeBatch(batchId);

        BatchVault.RevealedOrder[] memory orders = new BatchVault.RevealedOrder[](1);
        orders[0] = BatchVault.RevealedOrder(BatchVault.OrderSide.YES_BUY, 65e6, 700_000, sA);
        BatchVault.TransferAuth[] memory auths = new BatchVault.TransferAuth[](1);
        auths[0] = _buyAuth(alice);

        // yb=65e6, nb=0, ys=0, ns=0
        // yesBuyersNeed = 100e6, splitQty=0, yesGap=100e6
        uint256 relayerYesBefore  = ctf.balanceOf(relayer, _yesTokenId());
        uint256 relayerUsdcBefore = usdc.balanceOf(relayer);
        uint256 vaultUsdcBefore   = usdc.balanceOf(address(vault));

        // Phase 1: lockFunds — vault pulls USDC from Alice, sends gap USDC to relayer
        vm.prank(relayer);
        vault.lockFunds(batchId, orders, auths, CLEARING_PRICE, 65e6, 0, 0, 0);

        // Vault sent 65 USDC to relayer (for relayer to buy YES on CLOB — zero own capital)
        uint256 usdcForGap = (100e6 * CLEARING_PRICE) / PRICE_DECIMALS; // ≈65 USDC
        assertEq(usdc.balanceOf(relayer), relayerUsdcBefore + usdcForGap);
        assertEq(usdc.balanceOf(address(vault)), vaultUsdcBefore); // vault sent it all to relayer
        assertEq(uint256(vault.getBatch(batchId).status), uint256(BatchVault.BatchStatus.LOCKED));
        assertEq(vault.getBatch(batchId).yesGap, 100e6);

        // Phase 2: settleBatch — vault pulls 100 YES from relayer (relayer bought with vault USDC)
        vm.prank(relayer);
        vault.settleBatch(batchId, "");

        // Relayer gave 100 YES to vault, received gap USDC (was sent in lockFunds)
        assertEq(ctf.balanceOf(relayer, _yesTokenId()), relayerYesBefore - 100e6);
        assertEq(ctf.balanceOf(address(vault), _yesTokenId()), 100e6);

        // Alice claims
        vm.prank(alice);
        vault.claimPosition(batchId, BatchVault.OrderSide.YES_BUY, 65e6, 700_000, sA);
        assertEq(ctf.balanceOf(alice, _yesTokenId()), 100e6);
    }

    /// @notice NO-only batch: vault sends noGap USDC to relayer; relayer provides NO tokens.
    function test_settle_noBuyOnly_relayerGapFill() public {
        uint256 batchId = _openBatch();
        // Bob: 35 USDC NO BUY → needs 100 NO from relayer (noGap)
        bytes32 sB = bytes32(uint256(1));
        bytes32 cB = _commitment(BatchVault.OrderSide.NO_BUY, 35e6, 400_000, sB);
        vm.prank(bob); vault.commitBuyNoOrder(cB, 35e6, MARKET_ID);
        _closeBatch(batchId);

        BatchVault.RevealedOrder[] memory orders = new BatchVault.RevealedOrder[](1);
        orders[0] = BatchVault.RevealedOrder(BatchVault.OrderSide.NO_BUY, 35e6, 400_000, sB);
        BatchVault.TransferAuth[] memory auths = new BatchVault.TransferAuth[](1);
        auths[0] = _buyAuth(bob);

        uint256 relayerNoBefore   = ctf.balanceOf(relayer, _noTokenId());
        uint256 relayerUsdcBefore = usdc.balanceOf(relayer);

        // Phase 1: lockFunds
        vm.prank(relayer);
        vault.lockFunds(batchId, orders, auths, CLEARING_PRICE, 0, 35e6, 0, 0);

        uint256 noPrice    = PRICE_DECIMALS - CLEARING_PRICE; // 350000
        uint256 noGapQty   = (35e6 * PRICE_DECIMALS) / noPrice; // 100e6
        uint256 usdcForGap = (noGapQty * noPrice) / PRICE_DECIMALS; // ≈35e6

        assertEq(usdc.balanceOf(relayer), relayerUsdcBefore + usdcForGap);
        assertEq(vault.getBatch(batchId).noGap, noGapQty);

        // Phase 2: settleBatch — vault pulls noGap NO from relayer
        vm.prank(relayer);
        vault.settleBatch(batchId, "");

        assertEq(ctf.balanceOf(relayer, _noTokenId()), relayerNoBefore - noGapQty);
        assertEq(ctf.balanceOf(address(vault), _noTokenId()), noGapQty);

        // Bob claims
        vm.prank(bob);
        vault.claimPosition(batchId, BatchVault.OrderSide.NO_BUY, 35e6, 400_000, sB);
        assertEq(ctf.balanceOf(bob, _noTokenId()), noGapQty);
    }

    /// @notice Excess YES sellers: vault sends YES to relayer; relayer returns USDC after CLOB sale.
    function test_settle_excessYesSellers_relayerLiquidates() public {
        uint256 batchId = _openBatch();
        // Alice: 65 USDC YES BUY → gets 100 YES
        // Carol: 200 YES SELL → 100 directly matched, 100 excess (sent to relayer)
        bytes32 sA = bytes32(uint256(1));
        bytes32 sC = bytes32(uint256(2));
        bytes32 cA = _commitment(BatchVault.OrderSide.YES_BUY,  65e6,  700_000, sA);
        bytes32 cC = _commitment(BatchVault.OrderSide.YES_SELL, 200e6, 600_000, sC);

        vm.prank(alice); vault.commitOrder(cA, 65e6, MARKET_ID);
        _mintYes(carol, 200e6);
        vm.prank(carol); vault.commitSellOrder(cC, 200e6, MARKET_ID);
        _closeBatch(batchId);

        BatchVault.RevealedOrder[] memory orders = new BatchVault.RevealedOrder[](2);
        orders[0] = BatchVault.RevealedOrder(BatchVault.OrderSide.YES_BUY,  65e6,  700_000, sA);
        orders[1] = BatchVault.RevealedOrder(BatchVault.OrderSide.YES_SELL, 200e6, 600_000, sC);

        BatchVault.TransferAuth[] memory auths = new BatchVault.TransferAuth[](2);
        auths[0] = _buyAuth(alice);
        auths[1] = _zeroAuth();

        // filledYesBuyVol=65, filledYesSellQty=200
        // yesBuyersNeed=100, directYesMatch=100, excessYes=100, mergeQty=0, finalExcessYes=100
        uint256 relayerYesBefore  = ctf.balanceOf(relayer, _yesTokenId());
        uint256 relayerUsdcBefore = usdc.balanceOf(relayer);

        // Phase 1: lockFunds — sends 100 YES tokens to relayer (for CLOB sale)
        vm.prank(relayer);
        vault.lockFunds(batchId, orders, auths, CLEARING_PRICE, 65e6, 0, 200e6, 0);

        // Relayer received 100 YES (finalExcessYes)
        assertEq(ctf.balanceOf(relayer, _yesTokenId()), relayerYesBefore + 100e6);
        assertEq(vault.getBatch(batchId).finalExcessYes, 100e6);

        // Phase 2: settleBatch — vault pulls USDC from relayer (100 YES * 0.65 = 65 USDC)
        vm.prank(relayer);
        vault.settleBatch(batchId, "");

        // Relayer gave back 65 USDC (CLOB sale proceeds)
        uint256 usdcFromExcess = (100e6 * CLEARING_PRICE) / PRICE_DECIMALS; // 65e6
        assertEq(usdc.balanceOf(relayer), relayerUsdcBefore - usdcFromExcess);

        // Vault now has 65 USDC (from relayer) + 65 USDC (from Alice buyer EIP-3009) = 130 USDC for sellers
        assertEq(usdc.balanceOf(address(vault)), 130e6);

        // Carol claims: 200 * 0.65 = 130 USDC
        uint256 carolBefore = usdc.balanceOf(carol);
        vm.prank(carol);
        vault.claimPosition(batchId, BatchVault.OrderSide.YES_SELL, 200e6, 600_000, sC);
        assertEq(usdc.balanceOf(carol), carolBefore + 130e6);
    }

    // ─── Tests: unfilled orders ───────────────────────────────────────────────

    function test_unfilledBuy_nothingToClaim() public {
        uint256 batchId = _openBatch();
        // Alice bids 0.40 — won't fill at 0.65
        bytes32 sA = bytes32(uint256(1));
        bytes32 cA = _commitment(BatchVault.OrderSide.YES_BUY, 100e6, 400_000, sA);
        vm.prank(alice); vault.commitOrder(cA, 100e6, MARKET_ID);
        _closeBatch(batchId);

        BatchVault.RevealedOrder[] memory orders = new BatchVault.RevealedOrder[](1);
        orders[0] = BatchVault.RevealedOrder(BatchVault.OrderSide.YES_BUY, 100e6, 400_000, sA);
        _settle(batchId, orders, _buildAuths(1), CLEARING_PRICE);

        assertEq(usdc.balanceOf(alice), 1_000e6); // USDC never left wallet (unfilled, no EIP-3009)
        vm.expectRevert(BatchVault.NothingToClaim.selector);
        vm.prank(alice);
        vault.claimPosition(batchId, BatchVault.OrderSide.YES_BUY, 100e6, 400_000, sA);
    }

    function test_unfilledYesSell_refundsYES() public {
        uint256 batchId = _openBatch();
        // Carol asks min 0.80 — won't fill at 0.65
        bytes32 sC = bytes32(uint256(1));
        bytes32 cC = _commitment(BatchVault.OrderSide.YES_SELL, 50e6, 800_000, sC);
        _mintYes(carol, 50e6);
        vm.prank(carol); vault.commitSellOrder(cC, 50e6, MARKET_ID);
        _closeBatch(batchId);

        BatchVault.RevealedOrder[] memory orders = new BatchVault.RevealedOrder[](1);
        orders[0] = BatchVault.RevealedOrder(BatchVault.OrderSide.YES_SELL, 50e6, 800_000, sC);
        _settle(batchId, orders, _buildAuths(1), CLEARING_PRICE);

        BatchVault.Position memory pos = vault.getPosition(batchId, cC);
        assertEq(pos.refundAmount, 50e6);
        assertEq(pos.filledAmount, 0);

        uint256 carolYesBefore = ctf.balanceOf(carol, _yesTokenId());
        vm.prank(carol);
        vault.claimPosition(batchId, BatchVault.OrderSide.YES_SELL, 50e6, 800_000, sC);
        assertEq(ctf.balanceOf(carol, _yesTokenId()), carolYesBefore + 50e6);
    }

    function test_unfilledNoSell_refundsNO() public {
        uint256 batchId = _openBatch();
        // Dave asks min 0.50 for NO — NO price at 0.65 clearing is 0.35, won't fill
        bytes32 sD = bytes32(uint256(1));
        bytes32 cD = _commitment(BatchVault.OrderSide.NO_SELL, 80e6, 500_000, sD);
        _mintNo(dave, 80e6);
        vm.prank(dave); vault.commitSellNoOrder(cD, 80e6, MARKET_ID);
        _closeBatch(batchId);

        BatchVault.RevealedOrder[] memory orders = new BatchVault.RevealedOrder[](1);
        orders[0] = BatchVault.RevealedOrder(BatchVault.OrderSide.NO_SELL, 80e6, 500_000, sD);
        _settle(batchId, orders, _buildAuths(1), CLEARING_PRICE);

        uint256 daveBefore = ctf.balanceOf(dave, _noTokenId());
        vm.prank(dave);
        vault.claimPosition(batchId, BatchVault.OrderSide.NO_SELL, 80e6, 500_000, sD);
        assertEq(ctf.balanceOf(dave, _noTokenId()), daveBefore + 80e6);
    }

    // ─── Tests: claimWithProof ────────────────────────────────────────────────

    function test_claimWithProof_filledYesBuy_receivesYES() public {
        uint256 batchId = _openBatch();
        bytes32 sA = bytes32(uint256(42));
        bytes32 cA = _commitment(BatchVault.OrderSide.YES_BUY, 65e6, 700_000, sA);

        vm.prank(alice); vault.commitOrder(cA, 65e6, MARKET_ID);
        _closeBatch(batchId);

        BatchVault.RevealedOrder[] memory orders = new BatchVault.RevealedOrder[](1);
        orders[0] = BatchVault.RevealedOrder(BatchVault.OrderSide.YES_BUY, 65e6, 700_000, sA);
        BatchVault.TransferAuth[] memory auths = new BatchVault.TransferAuth[](1);
        auths[0] = _buyAuth(alice);

        _settle(batchId, orders, auths, CLEARING_PRICE);

        BatchVault.Batch memory b = vault.getBatch(batchId);
        assertTrue(b.claimMerkleRoot != bytes32(0));

        address recipient = address(0xF45E); // fresh address for privacy
        bytes32[] memory inputs = _buildClaimPublicInputs(
            batchId, b.claimMerkleRoot, CLEARING_PRICE,
            cA, sA, recipient,
            true, 65e6, 0, BatchVault.OrderSide.YES_BUY
        );

        uint256 recipientYesBefore = ctf.balanceOf(recipient, _yesTokenId());
        vault.claimWithProof(batchId, "", inputs);
        assertGt(ctf.balanceOf(recipient, _yesTokenId()), recipientYesBefore);

        // Nullifier used
        bytes32 nullifier = keccak256(abi.encode(cA, batchId, sA));
        assertTrue(vault.usedNullifiers(nullifier));
    }

    function test_claimWithProof_filledNoBuy_receivesNO() public {
        uint256 batchId = _openBatch();
        bytes32 sB = bytes32(uint256(7));
        bytes32 cB = _commitment(BatchVault.OrderSide.NO_BUY, 35e6, 400_000, sB);

        vm.prank(bob); vault.commitBuyNoOrder(cB, 35e6, MARKET_ID);
        _closeBatch(batchId);

        BatchVault.RevealedOrder[] memory orders = new BatchVault.RevealedOrder[](1);
        orders[0] = BatchVault.RevealedOrder(BatchVault.OrderSide.NO_BUY, 35e6, 400_000, sB);
        BatchVault.TransferAuth[] memory auths = new BatchVault.TransferAuth[](1);
        auths[0] = _buyAuth(bob);

        // noGap = 100e6: vault sends 35 USDC to relayer in lockFunds; relayer gives 100 NO in settleBatch
        _settle(batchId, orders, auths, CLEARING_PRICE);

        BatchVault.Batch memory b = vault.getBatch(batchId);

        bytes32[] memory inputs = _buildClaimPublicInputs(
            batchId, b.claimMerkleRoot, CLEARING_PRICE,
            cB, sB, bob,
            true, 35e6, 0, BatchVault.OrderSide.NO_BUY
        );
        uint256 bobNoBefore = ctf.balanceOf(bob, _noTokenId());
        vault.claimWithProof(batchId, "", inputs);
        assertGt(ctf.balanceOf(bob, _noTokenId()), bobNoBefore);
    }

    function test_claimWithProof_filledYesSell_receivesUSDC() public {
        uint256 batchId = _openBatch();
        bytes32 sA = bytes32(uint256(1));
        bytes32 sC = bytes32(uint256(2));
        bytes32 cA = _commitment(BatchVault.OrderSide.YES_BUY,  65e6,  700_000, sA);
        bytes32 cC = _commitment(BatchVault.OrderSide.YES_SELL, 100e6, 600_000, sC);

        vm.prank(alice); vault.commitOrder(cA, 65e6, MARKET_ID);
        _mintYes(carol, 100e6);
        vm.prank(carol); vault.commitSellOrder(cC, 100e6, MARKET_ID);
        _closeBatch(batchId);

        BatchVault.RevealedOrder[] memory orders = new BatchVault.RevealedOrder[](2);
        orders[0] = BatchVault.RevealedOrder(BatchVault.OrderSide.YES_BUY,  65e6,  700_000, sA);
        orders[1] = BatchVault.RevealedOrder(BatchVault.OrderSide.YES_SELL, 100e6, 600_000, sC);
        BatchVault.TransferAuth[] memory auths = new BatchVault.TransferAuth[](2);
        auths[0] = _buyAuth(alice); auths[1] = _zeroAuth();

        _settle(batchId, orders, auths, CLEARING_PRICE);

        BatchVault.Batch memory b = vault.getBatch(batchId);
        address freshRecipient = address(0xF45E);
        uint256 carolFillUSDC = 100e6 * CLEARING_PRICE / PRICE_DECIMALS; // 65e6

        bytes32[] memory inputs = _buildClaimPublicInputs(
            batchId, b.claimMerkleRoot, CLEARING_PRICE,
            cC, sC, freshRecipient,
            true, 100e6, 0, BatchVault.OrderSide.YES_SELL
        );

        uint256 recipientBefore = usdc.balanceOf(freshRecipient);
        vault.claimWithProof(batchId, "", inputs);
        assertEq(usdc.balanceOf(freshRecipient), recipientBefore + carolFillUSDC);
    }

    function test_claimWithProof_doubleClaim_reverts() public {
        uint256 batchId = _openBatch();
        bytes32 sA = bytes32(uint256(42));
        bytes32 cA = _commitment(BatchVault.OrderSide.YES_BUY, 65e6, 700_000, sA);
        vm.prank(alice); vault.commitOrder(cA, 65e6, MARKET_ID);
        _closeBatch(batchId);

        BatchVault.RevealedOrder[] memory orders = new BatchVault.RevealedOrder[](1);
        orders[0] = BatchVault.RevealedOrder(BatchVault.OrderSide.YES_BUY, 65e6, 700_000, sA);
        BatchVault.TransferAuth[] memory auths = new BatchVault.TransferAuth[](1);
        auths[0] = _buyAuth(alice);
        _settle(batchId, orders, auths, CLEARING_PRICE);

        BatchVault.Batch memory b = vault.getBatch(batchId);
        bytes32[] memory inputs = _buildClaimPublicInputs(
            batchId, b.claimMerkleRoot, CLEARING_PRICE,
            cA, sA, alice, true, 65e6, 0, BatchVault.OrderSide.YES_BUY
        );

        vault.claimWithProof(batchId, "", inputs);
        vm.expectRevert(BatchVault.AlreadyClaimed.selector);
        vault.claimWithProof(batchId, "", inputs);
    }

    function test_claimWithProof_wrongRoot_reverts() public {
        uint256 batchId = _openBatch();
        bytes32 sA = bytes32(uint256(1));
        bytes32 cA = _commitment(BatchVault.OrderSide.YES_BUY, 65e6, 700_000, sA);
        vm.prank(alice); vault.commitOrder(cA, 65e6, MARKET_ID);
        _closeBatch(batchId);

        BatchVault.RevealedOrder[] memory orders = new BatchVault.RevealedOrder[](1);
        orders[0] = BatchVault.RevealedOrder(BatchVault.OrderSide.YES_BUY, 65e6, 700_000, sA);
        BatchVault.TransferAuth[] memory auths = new BatchVault.TransferAuth[](1);
        auths[0] = _buyAuth(alice);
        _settle(batchId, orders, auths, CLEARING_PRICE);

        bytes32[] memory inputs = _buildClaimPublicInputs(
            batchId, bytes32(uint256(0xDEAD)), CLEARING_PRICE,
            cA, sA, alice, true, 65e6, 0, BatchVault.OrderSide.YES_BUY
        );
        vm.expectRevert(BatchVault.CommitmentMismatch.selector);
        vault.claimWithProof(batchId, "", inputs);
    }

    // ─── Tests: cross-path double-claim prevention ────────────────────────────

    function test_crossPath_claimWithProof_then_claimPosition_reverts() public {
        uint256 batchId = _openBatch();
        bytes32 sC = bytes32(uint256(7));
        bytes32 cC = _commitment(BatchVault.OrderSide.YES_SELL, 100e6, 600_000, sC);
        _mintYes(carol, 100e6);
        vm.prank(carol); vault.commitSellOrder(cC, 100e6, MARKET_ID);

        bytes32 sA = bytes32(uint256(8));
        bytes32 cA = _commitment(BatchVault.OrderSide.YES_BUY, 65e6, 700_000, sA);
        vm.prank(alice); vault.commitOrder(cA, 65e6, MARKET_ID);
        _closeBatch(batchId);

        BatchVault.RevealedOrder[] memory orders = new BatchVault.RevealedOrder[](2);
        orders[0] = BatchVault.RevealedOrder(BatchVault.OrderSide.YES_SELL, 100e6, 600_000, sC);
        orders[1] = BatchVault.RevealedOrder(BatchVault.OrderSide.YES_BUY,  65e6,  700_000, sA);
        BatchVault.TransferAuth[] memory auths = new BatchVault.TransferAuth[](2);
        auths[0] = _zeroAuth(); auths[1] = _buyAuth(alice);

        _settle(batchId, orders, auths, CLEARING_PRICE);

        BatchVault.Batch memory b = vault.getBatch(batchId);

        bytes32[] memory inputs = _buildClaimPublicInputs(
            batchId, b.claimMerkleRoot, CLEARING_PRICE,
            cC, sC, carol, true, 100e6, 0, BatchVault.OrderSide.YES_SELL
        );
        vault.claimWithProof(batchId, "", inputs);

        vm.expectRevert(BatchVault.AlreadyClaimed.selector);
        vm.prank(carol);
        vault.claimPosition(batchId, BatchVault.OrderSide.YES_SELL, 100e6, 600_000, sC);
    }

    function test_crossPath_claimPosition_then_claimWithProof_reverts() public {
        uint256 batchId = _openBatch();
        bytes32 sC = bytes32(uint256(9));
        bytes32 cC = _commitment(BatchVault.OrderSide.YES_SELL, 100e6, 600_000, sC);
        _mintYes(carol, 100e6);
        vm.prank(carol); vault.commitSellOrder(cC, 100e6, MARKET_ID);

        bytes32 sA = bytes32(uint256(10));
        bytes32 cA = _commitment(BatchVault.OrderSide.YES_BUY, 65e6, 700_000, sA);
        vm.prank(alice); vault.commitOrder(cA, 65e6, MARKET_ID);
        _closeBatch(batchId);

        BatchVault.RevealedOrder[] memory orders = new BatchVault.RevealedOrder[](2);
        orders[0] = BatchVault.RevealedOrder(BatchVault.OrderSide.YES_SELL, 100e6, 600_000, sC);
        orders[1] = BatchVault.RevealedOrder(BatchVault.OrderSide.YES_BUY,  65e6,  700_000, sA);
        BatchVault.TransferAuth[] memory auths = new BatchVault.TransferAuth[](2);
        auths[0] = _zeroAuth(); auths[1] = _buyAuth(alice);

        _settle(batchId, orders, auths, CLEARING_PRICE);

        BatchVault.Batch memory b = vault.getBatch(batchId);

        vm.prank(carol);
        vault.claimPosition(batchId, BatchVault.OrderSide.YES_SELL, 100e6, 600_000, sC);

        bytes32[] memory inputs = _buildClaimPublicInputs(
            batchId, b.claimMerkleRoot, CLEARING_PRICE,
            cC, sC, carol, true, 100e6, 0, BatchVault.OrderSide.YES_SELL
        );
        vm.expectRevert(BatchVault.AlreadyClaimed.selector);
        vault.claimWithProof(batchId, "", inputs);
    }

    // ─── Tests: EIP-712 commitOrderFor ────────────────────────────────────────

    function test_commitOrderFor_basic() public {
        _openBatch();
        uint256 daveKey = 0xDA7E;
        address daveAddr = vm.addr(daveKey);
        usdc.mint(daveAddr, 500e6);

        uint256 amount = 100e6;
        uint256 limitPrice = 650_000;
        bytes32 salt = bytes32(uint256(99));
        uint256 deadline = block.timestamp + 1 hours;

        bytes32 c = _commitment(BatchVault.OrderSide.YES_BUY, amount, limitPrice, salt);
        bytes memory sig = _signCommitOrder(daveKey, c, amount, 0, deadline);

        vm.prank(relayer);
        vault.commitOrderFor(c, amount, daveAddr, 0, deadline, sig, MARKET_ID);

        assertEq(usdc.balanceOf(daveAddr), 500e6); // no USDC moved
        assertEq(vault.nonces(daveAddr), 1);
        assertEq(vault.getCommitment(1, 0).amount, amount);
    }

    function test_commitOrderFor_invalidSignature_reverts() public {
        _openBatch();
        uint256 daveKey = 0xDA7E;
        uint256 eveKey  = 0xEE7E;
        address daveAddr = vm.addr(daveKey);
        bytes32 c = _commitment(BatchVault.OrderSide.YES_BUY, 50e6, 600_000, bytes32(uint256(1)));
        bytes memory badSig = _signCommitOrder(eveKey, c, 50e6, 0, block.timestamp + 1 hours);
        vm.expectRevert(BatchVault.InvalidSignature.selector);
        vm.prank(relayer);
        vault.commitOrderFor(c, 50e6, daveAddr, 0, block.timestamp + 1 hours, badSig, MARKET_ID);
    }

    function test_commitOrderFor_expiredDeadline_reverts() public {
        _openBatch();
        uint256 daveKey = 0xDA7E;
        address daveAddr = vm.addr(daveKey);
        bytes32 c = _commitment(BatchVault.OrderSide.YES_BUY, 50e6, 600_000, bytes32(uint256(1)));
        uint256 deadline = block.timestamp - 1;
        bytes memory sig = _signCommitOrder(daveKey, c, 50e6, 0, deadline);
        vm.expectRevert(BatchVault.SignatureExpired.selector);
        vm.prank(relayer);
        vault.commitOrderFor(c, 50e6, daveAddr, 0, deadline, sig, MARKET_ID);
    }

    function test_commitOrderFor_wrongNonce_reverts() public {
        _openBatch();
        uint256 daveKey = 0xDA7E;
        address daveAddr = vm.addr(daveKey);
        bytes32 c = _commitment(BatchVault.OrderSide.YES_BUY, 50e6, 600_000, bytes32(uint256(1)));
        bytes memory sig = _signCommitOrder(daveKey, c, 50e6, 0, block.timestamp + 1 hours);
        vm.expectRevert(BatchVault.InvalidSignature.selector);
        vm.prank(relayer);
        vault.commitOrderFor(c, 50e6, daveAddr, 1 /* wrong nonce */, block.timestamp + 1 hours, sig, MARKET_ID);
    }

    function test_commitOrderFor_replay_reverts() public {
        _openBatch();
        uint256 daveKey = 0xDA7E;
        address daveAddr = vm.addr(daveKey);
        bytes32 c = _commitment(BatchVault.OrderSide.YES_BUY, 50e6, 600_000, bytes32(uint256(1)));
        bytes memory sig = _signCommitOrder(daveKey, c, 50e6, 0, block.timestamp + 1 hours);
        vm.prank(relayer);
        vault.commitOrderFor(c, 50e6, daveAddr, 0, block.timestamp + 1 hours, sig, MARKET_ID);
        vm.expectRevert(BatchVault.InvalidSignature.selector);
        vm.prank(relayer);
        vault.commitOrderFor(c, 50e6, daveAddr, 0, block.timestamp + 1 hours, sig, MARKET_ID);
    }

    // ─── Tests: lockFunds / settleBatch validation ────────────────────────────

    function test_lockFunds_wrongCommitment_reverts() public {
        uint256 batchId = _openBatch();
        bytes32 sA = bytes32(uint256(1));
        bytes32 cA = _commitment(BatchVault.OrderSide.YES_BUY, 100e6, 650_000, sA);
        vm.prank(alice); vault.commitOrder(cA, 100e6, MARKET_ID);
        _closeBatch(batchId);

        // Tamper: different limit price
        BatchVault.RevealedOrder[] memory orders = new BatchVault.RevealedOrder[](1);
        orders[0] = BatchVault.RevealedOrder(BatchVault.OrderSide.YES_BUY, 100e6, 700_000 /* wrong */, sA);
        vm.expectRevert(BatchVault.CommitmentMismatch.selector);
        vm.prank(relayer);
        vault.lockFunds(batchId, orders, _buildAuths(1), CLEARING_PRICE, 100e6, 0, 0, 0);
    }

    function test_lockFunds_invalidClearingPrice_reverts() public {
        uint256 batchId = _openBatch();
        bytes32 sA = bytes32(uint256(1));
        bytes32 cA = _commitment(BatchVault.OrderSide.YES_BUY, 100e6, 650_000, sA);
        vm.prank(alice); vault.commitOrder(cA, 100e6, MARKET_ID);
        _closeBatch(batchId);

        BatchVault.RevealedOrder[] memory orders = new BatchVault.RevealedOrder[](1);
        orders[0] = BatchVault.RevealedOrder(BatchVault.OrderSide.YES_BUY, 100e6, 650_000, sA);
        vm.expectRevert(BatchVault.InvalidClearingPrice.selector);
        vm.prank(relayer);
        vault.lockFunds(batchId, orders, _buildAuths(1), 0 /* invalid */, 0, 0, 0, 0);
    }

    function test_lockFundsByNonRelayer_reverts() public {
        uint256 batchId = _openBatch();
        bytes32 cA = _commitment(BatchVault.OrderSide.YES_BUY, 100e6, 650_000, bytes32(uint256(1)));
        vm.prank(alice); vault.commitOrder(cA, 100e6, MARKET_ID);
        _closeBatch(batchId);

        BatchVault.RevealedOrder[] memory orders = new BatchVault.RevealedOrder[](1);
        orders[0] = BatchVault.RevealedOrder(BatchVault.OrderSide.YES_BUY, 100e6, 650_000, bytes32(uint256(1)));
        vm.expectRevert(BatchVault.OnlyRelayer.selector);
        vm.prank(alice);
        vault.lockFunds(batchId, orders, _buildAuths(1), CLEARING_PRICE, 100e6, 0, 0, 0);
    }

    function test_settleBatch_requiresLocked() public {
        uint256 batchId = _openBatch();
        bytes32 cA = _commitment(BatchVault.OrderSide.YES_BUY, 65e6, 700_000, bytes32(uint256(1)));
        vm.prank(alice); vault.commitOrder(cA, 65e6, MARKET_ID);
        _closeBatch(batchId);

        // Calling settleBatch before lockFunds should revert (batch is SETTLING, not LOCKED)
        vm.expectRevert(BatchVault.BatchNotLocked.selector);
        vm.prank(relayer);
        vault.settleBatch(batchId, "");
    }

    // ─── Tests: rescue stuck sell orders ─────────────────────────────────────

    function test_rescueStuckYesSell_afterDelay() public {
        uint256 batchId = _openBatch();
        bytes32 sC = bytes32(uint256(11));
        bytes32 cC = _commitment(BatchVault.OrderSide.YES_SELL, 100e6, 600_000, sC);
        _mintYes(carol, 100e6);
        vm.prank(carol); vault.commitSellOrder(cC, 100e6, MARKET_ID);
        _closeBatch(batchId);

        vm.expectRevert("BatchVault: rescue delay not elapsed");
        vm.prank(carol);
        vault.rescueStuckSellOrder(batchId, BatchVault.OrderSide.YES_SELL, 100e6, 600_000, sC);

        vm.warp(block.timestamp + 7 days + 1);
        uint256 carolYesBefore = ctf.balanceOf(carol, _yesTokenId());
        vm.prank(carol);
        vault.rescueStuckSellOrder(batchId, BatchVault.OrderSide.YES_SELL, 100e6, 600_000, sC);
        assertEq(ctf.balanceOf(carol, _yesTokenId()), carolYesBefore + 100e6);

        vm.expectRevert("BatchVault: invalid or already rescued");
        vm.prank(carol);
        vault.rescueStuckSellOrder(batchId, BatchVault.OrderSide.YES_SELL, 100e6, 600_000, sC);
    }

    function test_rescueStuckNoSell_afterDelay() public {
        uint256 batchId = _openBatch();
        bytes32 sD = bytes32(uint256(12));
        bytes32 cD = _commitment(BatchVault.OrderSide.NO_SELL, 80e6, 300_000, sD);
        _mintNo(dave, 80e6);
        vm.prank(dave); vault.commitSellNoOrder(cD, 80e6, MARKET_ID);
        _closeBatch(batchId);

        vm.warp(block.timestamp + 7 days + 1);
        uint256 daveBefore = ctf.balanceOf(dave, _noTokenId());
        vm.prank(dave);
        vault.rescueStuckSellOrder(batchId, BatchVault.OrderSide.NO_SELL, 80e6, 300_000, sD);
        assertEq(ctf.balanceOf(dave, _noTokenId()), daveBefore + 80e6);
    }

    // ─── Tests: concurrent multi-market ──────────────────────────────────────

    function test_twoMarketsConcurrent() public {
        bytes32 MARKET_2 = keccak256("polymarket:will-btc-reach-150k");

        vm.prank(relayer); uint256 batchId1 = vault.openBatch(MARKET_ID);
        vm.prank(relayer); uint256 batchId2 = vault.openBatch(MARKET_2);

        assertEq(batchId1, 1); assertEq(batchId2, 2);
        assertEq(vault.getCurrentBatchId(MARKET_ID), 1);
        assertEq(vault.getCurrentBatchId(MARKET_2), 2);

        bytes32 cA = keccak256(abi.encode(MARKET_ID, uint8(0), 100e6, 650_000, bytes32(uint256(1))));
        bytes32 cB = keccak256(abi.encode(MARKET_2,  uint8(0),  50e6, 700_000, bytes32(uint256(2))));

        vm.prank(alice); vault.commitOrder(cA, 100e6, MARKET_ID);
        vm.prank(bob);   vault.commitOrder(cB,  50e6, MARKET_2);

        assertEq(vault.getBatch(1).totalDeposited, 100e6);
        assertEq(vault.getBatch(2).totalDeposited,  50e6);

        // Close + settle market 1 only
        vm.warp(block.timestamp + vault.BATCH_WINDOW() + 1);
        vault.closeBatch(MARKET_ID);
        assertEq(uint256(vault.getBatch(2).status), uint256(BatchVault.BatchStatus.OPEN)); // still open

        BatchVault.RevealedOrder[] memory orders1 = new BatchVault.RevealedOrder[](1);
        orders1[0] = BatchVault.RevealedOrder(BatchVault.OrderSide.YES_BUY, 100e6, 650_000, bytes32(uint256(1)));
        BatchVault.TransferAuth[] memory auths1 = new BatchVault.TransferAuth[](1);
        auths1[0] = _buyAuth(alice);

        // Two-phase settle market 1
        vm.prank(relayer);
        vault.lockFunds(batchId1, orders1, auths1, 650_000, 100e6, 0, 0, 0);
        vm.prank(relayer);
        vault.settleBatch(batchId1, "");

        assertEq(uint256(vault.getBatch(1).status), uint256(BatchVault.BatchStatus.SETTLED));
        assertEq(uint256(vault.getBatch(2).status), uint256(BatchVault.BatchStatus.OPEN));
    }

    // ─── Tests: privacy property ──────────────────────────────────────────────

    function test_privacy_onlyHashOnchain_beforeSettlement() public {
        _openBatch();
        bytes32 salt = bytes32(uint256(42));
        bytes32 c = _commitment(BatchVault.OrderSide.YES_BUY, 100e6, 720_000, salt);
        vm.prank(alice); vault.commitOrder(c, 100e6, MARKET_ID);

        // On-chain commitment reveals ONLY hash + amount — no trader address, no limitPrice, no salt
        BatchVault.Commitment memory stored = vault.getCommitment(1, 0);
        assertEq(stored.hash, c);
        assertEq(stored.amount, 100e6);
        // salt, limitPrice, side, trader address not stored
    }

    // ─── Tests: double-claim with claimPosition ───────────────────────────────

    function test_claimPosition_doubleClaim_reverts() public {
        uint256 batchId = _openBatch();
        bytes32 sC = bytes32(uint256(1));
        bytes32 cC = _commitment(BatchVault.OrderSide.YES_SELL, 100e6, 600_000, sC);
        _mintYes(carol, 100e6);
        vm.prank(carol); vault.commitSellOrder(cC, 100e6, MARKET_ID);

        bytes32 sA = bytes32(uint256(2));
        bytes32 cA = _commitment(BatchVault.OrderSide.YES_BUY, 65e6, 700_000, sA);
        vm.prank(alice); vault.commitOrder(cA, 65e6, MARKET_ID);
        _closeBatch(batchId);

        BatchVault.RevealedOrder[] memory orders = new BatchVault.RevealedOrder[](2);
        orders[0] = BatchVault.RevealedOrder(BatchVault.OrderSide.YES_SELL, 100e6, 600_000, sC);
        orders[1] = BatchVault.RevealedOrder(BatchVault.OrderSide.YES_BUY,  65e6,  700_000, sA);
        BatchVault.TransferAuth[] memory auths = new BatchVault.TransferAuth[](2);
        auths[0] = _zeroAuth(); auths[1] = _buyAuth(alice);

        _settle(batchId, orders, auths, CLEARING_PRICE);

        vm.prank(carol);
        vault.claimPosition(batchId, BatchVault.OrderSide.YES_SELL, 100e6, 600_000, sC);
        vm.expectRevert(BatchVault.AlreadyClaimed.selector);
        vm.prank(carol);
        vault.claimPosition(batchId, BatchVault.OrderSide.YES_SELL, 100e6, 600_000, sC);
    }
}
