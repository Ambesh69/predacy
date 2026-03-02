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

    /// @notice EIP-3009 stub — skips all signature/time validation for testing.
    ///         Mirrors MockBatchVerifier philosophy: crypto verification is skipped in tests.
    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256, /*validAfter*/
        uint256, /*validBefore*/
        bytes32, /*nonce*/
        uint8,   /*v*/
        bytes32, /*r*/
        bytes32  /*s*/
    ) external {
        balanceOf[from] -= value;
        balanceOf[to]   += value;
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

    /// @dev Simulate buying YES at a given clearing price: pull USDC, mint price-correct YES.
    ///      Called by BatchVault._executeOnPolymarket() instead of splitPosition().
    function mockBuyYes(
        address collateral,
        bytes32 conditionId,
        uint256 usdcAmount,
        uint256 clearingPrice
    ) external returns (uint256 yesAmount) {
        // Pull USDC from vault (vault approved us before calling)
        MockUSDC(collateral).transferFrom(msg.sender, address(this), usdcAmount);
        // Mint price-correct YES tokens to vault
        yesAmount = usdcAmount * 1_000_000 / clearingPrice;
        uint256 yesId = _getYesId(collateral, conditionId);
        balanceOf[msg.sender][yesId] += yesAmount;
    }

    /// @dev Simulate selling YES at a given clearing price: burn YES, mint USDC proceeds.
    ///      Called by BatchVault._executeSellOnPolymarket().
    function mockSellYes(
        address collateral,
        bytes32 conditionId,
        uint256 yesAmount,
        uint256 clearingPrice
    ) external returns (uint256 usdcAmount) {
        uint256 yesId = _getYesId(collateral, conditionId);
        require(balanceOf[msg.sender][yesId] >= yesAmount, "MockCTF: insufficient YES balance");
        balanceOf[msg.sender][yesId] -= yesAmount;
        usdcAmount = yesAmount * clearingPrice / 1_000_000;
        // Mint USDC directly to vault (simulates Polymarket CLOB fill)
        MockUSDC(collateral).mint(msg.sender, usdcAmount);
    }

    /// @dev Compute YES token ID — mirrors getCollectionId(bytes32(0), conditionId, 2) + getPositionId
    function _getYesId(address collateral, bytes32 conditionId) internal pure returns (uint256) {
        bytes32 collectionId = keccak256(abi.encode(conditionId, uint256(2)));
        return uint256(keccak256(abi.encode(collateral, collectionId)));
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
        // 5-arg constructor: usdc, ctf, relayer, batchVerifier, claimVerifier
        vault = new BatchVault(address(usdc), address(ctf), relayer, address(verifier), address(verifier));

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

        // Fund relayer for gas (USDC no longer paid upfront with EIP-3009 model)
        usdc.mint(relayer, 10_000e6);
        vm.prank(relayer);
        usdc.approve(address(vault), type(uint256).max); // kept for backward compat; not used
    }

    // ─── Helpers ───────────────────────────────────────────────────────────

    function _openBatch() internal returns (uint256 batchId) {
        vm.prank(relayer);
        batchId = vault.openBatch(MARKET_ID);
    }

    /// @dev Commitment hash — no trader address (salt is the 256-bit secret credential).
    function _makeCommitment(
        bytes32 marketId,
        bool isBuy,
        uint256 amount,
        uint256 limitPrice,
        bytes32 salt
    ) internal pure returns (bytes32) {
        return keccak256(abi.encode(marketId, isBuy, amount, limitPrice, salt));
    }

    function _closeBatch(uint256 batchId) internal {
        // Skip past batch window
        vm.warp(block.timestamp + vault.BATCH_WINDOW() + 1);
        vault.closeBatch(MARKET_ID);
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

    /// @dev Zero-value EIP-3009 auth — used for sell orders and unfilled buy orders
    ///      (the vault never calls transferWithAuthorization for these).
    function _zeroAuth() internal pure returns (BatchVault.TransferAuth memory) {
        return BatchVault.TransferAuth({
            from:        address(0),
            validAfter:  0,
            validBefore: 0,
            nonce:       bytes32(0),
            v:           0,
            r:           bytes32(0),
            s:           bytes32(0)
        });
    }

    /// @dev Auth for a filled buy order — sets `from` to the ephemeral wallet address.
    ///      MockUSDC.transferWithAuthorization skips sig validation; it just deducts from `from`.
    function _buyAuth(address from) internal pure returns (BatchVault.TransferAuth memory) {
        return BatchVault.TransferAuth({
            from:        from,
            validAfter:  0,
            validBefore: 0,
            nonce:       bytes32(0),
            v:           0,
            r:           bytes32(0),
            s:           bytes32(0)
        });
    }

    /// @dev Build an auths array of `count` zero-value structs.
    ///      Use only for sell-only or unfilled-buy-only settlements.
    ///      For settlements with filled buys, build the array manually with _buyAuth().
    function _buildAuths(uint256 count) internal pure returns (BatchVault.TransferAuth[] memory auths) {
        auths = new BatchVault.TransferAuth[](count);
        for (uint256 i = 0; i < count; i++) {
            auths[i] = _zeroAuth();
        }
    }

    function _buildSettleParams(BatchVault.RevealedOrder[] memory orders, uint256 clearingPrice)
        internal
        pure
        returns (
            uint256 totalBuyVol,
            uint256 totalSellVol,
            uint256 netBuyAmount,
            uint256 netSellYes
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
        // netSellYes: YES tokens to sell on Polymarket (sell-heavy batches)
        uint256 netSellUSDC = filledSellUSDC > totalBuyVol ? filledSellUSDC - totalBuyVol : 0;
        netSellYes = clearingPrice > 0 ? netSellUSDC * PRICE_DECIMALS / clearingPrice : 0;
    }

    /// @dev Build the 9-element publicInputs array for claimWithProof.
    ///      Mirrors the circuit's public output layout:
    ///        [0] batchId, [1] claimMerkleRoot, [2] clearingPrice,
    ///        [3] nullifier, [4] recipient, [5] fills,
    ///        [6] fillAmount, [7] refundAmount, [8] isBuy
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
        bool    isBuy
    ) internal pure returns (bytes32[] memory inputs) {
        bytes32 nullifier = keccak256(abi.encode(commitment, batchId, salt));
        inputs = new bytes32[](9);
        inputs[0] = bytes32(batchId);
        inputs[1] = claimMerkleRoot;
        inputs[2] = bytes32(clearingPrice);
        inputs[3] = nullifier;
        inputs[4] = bytes32(uint256(uint160(recipient)));
        inputs[5] = bytes32(fills ? uint256(1) : 0);
        inputs[6] = bytes32(fillAmount);
        inputs[7] = bytes32(refundAmount);
        inputs[8] = bytes32(isBuy ? uint256(1) : 0);
    }

    // ─── Tests: batch lifecycle ────────────────────────────────────────────

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

        bytes32 commitment = _makeCommitment(MARKET_ID, true, amount, limitPrice, salt);

        vm.prank(alice);
        vault.commitOrder(commitment, amount, MARKET_ID);

        // EIP-3009: no USDC deposited at commit time — funds stay in user wallet until settlement
        assertEq(usdc.balanceOf(address(vault)), 0);
        assertEq(vault.getBatch(1).commitmentCount, 1);
        assertEq(vault.getBatch(1).totalDeposited, amount); // tracks authorized volume
    }

    function test_commitOrder_emitsEvent() public {
        _openBatch();
        bytes32 salt = bytes32(uint256(1));
        uint256 amount = 50e6;
        bytes32 commitment = _makeCommitment(MARKET_ID, true, amount, 600000, salt);

        vm.expectEmit(true, true, false, false);
        emit BatchVault.OrderCommitted(1, commitment);

        vm.prank(alice);
        vault.commitOrder(commitment, amount, MARKET_ID);
    }

    function test_commitOrder_duplicateReverts() public {
        _openBatch();
        bytes32 commitment = _makeCommitment(MARKET_ID, true, 100e6, 650000, bytes32(uint256(1)));

        vm.prank(alice);
        vault.commitOrder(commitment, 100e6, MARKET_ID);

        vm.expectRevert(BatchVault.DuplicateCommitment.selector);
        vm.prank(alice);
        vault.commitOrder(commitment, 100e6, MARKET_ID);
    }

    function test_commitOrder_whenBatchClosed_reverts() public {
        uint256 batchId = _openBatch();
        _closeBatch(batchId);

        bytes32 commitment = _makeCommitment(MARKET_ID, true, 100e6, 650000, bytes32(uint256(1)));
        vm.expectRevert(BatchVault.BatchNotOpen.selector);
        vm.prank(alice);
        vault.commitOrder(commitment, 100e6, MARKET_ID);
    }

    function test_commitOrder_zeroAmountReverts() public {
        _openBatch();
        bytes32 commitment = bytes32(uint256(1));
        vm.expectRevert(BatchVault.ZeroAmount.selector);
        vm.prank(alice);
        vault.commitOrder(commitment, 0, MARKET_ID);
    }

    // ─── Tests: sell order commitment ──────────────────────────────────────

    function test_commitSellOrder_basic() public {
        _openBatch();

        uint256 yesAmount = 50e6; // 50 YES tokens
        uint256 limitPrice = 600000; // min $0.60
        bytes32 salt = bytes32(uint256(10));

        _mintYes(carol, yesAmount);
        _approveVaultCTF(carol);

        bytes32 commitment = _makeCommitment(MARKET_ID, false, yesAmount, limitPrice, salt);

        vm.prank(carol);
        vault.commitSellOrder(commitment, yesAmount, MARKET_ID);

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
        vault.commitSellOrder(bytes32(uint256(1)), 0, MARKET_ID);
    }

    function test_commitSellOrder_whenBatchClosed_reverts() public {
        uint256 batchId = _openBatch();
        _closeBatch(batchId);

        _mintYes(carol, 50e6);
        _approveVaultCTF(carol);
        bytes32 commitment = _makeCommitment(MARKET_ID, false, 50e6, 600000, bytes32(uint256(1)));
        vm.expectRevert(BatchVault.BatchNotOpen.selector);
        vm.prank(carol);
        vault.commitSellOrder(commitment, 50e6, MARKET_ID);
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
        bytes32 cAlice = _makeCommitment(MARKET_ID, true,  amtAlice, limitAlice, saltAlice);
        bytes32 cBob   = _makeCommitment(MARKET_ID, true,  amtBob,   limitBob,   saltBob);
        // Sell commitment (YES tokens)
        bytes32 cCarol = _makeCommitment(MARKET_ID, false, amtCarol, limitCarol, saltCarol);

        vm.prank(alice);
        vault.commitOrder(cAlice, amtAlice, MARKET_ID);
        vm.prank(bob);
        vault.commitOrder(cBob, amtBob, MARKET_ID);

        // Carol deposits YES tokens
        _mintYes(carol, amtCarol);
        _approveVaultCTF(carol);
        vm.prank(carol);
        vault.commitSellOrder(cCarol, amtCarol, MARKET_ID);

        _closeBatch(batchId);

        // Clearing price: 0.65
        // Alice fills (0.70 >= 0.65), Bob fills (0.65 >= 0.65), Carol fills (0.60 <= 0.65)
        // buyVol = 150 USDC, sellYes = 80 tokens → sellUSDC = 80 * 0.65 = 52 USDC
        // netBuy = 150 - 52 = 98 USDC → Polymarket
        uint256 clearingPrice = 650000;

        BatchVault.RevealedOrder[] memory orders = new BatchVault.RevealedOrder[](3);
        orders[0] = BatchVault.RevealedOrder(true,  amtAlice, limitAlice, saltAlice);
        orders[1] = BatchVault.RevealedOrder(true,  amtBob,   limitBob,   saltBob);
        orders[2] = BatchVault.RevealedOrder(false, amtCarol, limitCarol, saltCarol);

        // Alice and Bob are filled buys — auths must carry the `from` address.
        // Carol is a sell order — zeroAuth (no EIP-3009 pull needed).
        BatchVault.TransferAuth[] memory auths = new BatchVault.TransferAuth[](3);
        auths[0] = _buyAuth(alice);
        auths[1] = _buyAuth(bob);
        auths[2] = _zeroAuth();

        (uint256 buyVol, uint256 sellVol, uint256 netBuy, uint256 netSell) = _buildSettleParams(orders, clearingPrice);

        vm.prank(relayer);
        vault.settleBatch(batchId, orders, auths, clearingPrice, buyVol, sellVol, netBuy, netSell, "");

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
        bytes32 commitment = _makeCommitment(MARKET_ID, true, 100e6, 650000, salt);

        vm.prank(alice);
        vault.commitOrder(commitment, 100e6, MARKET_ID);
        _closeBatch(batchId);

        // Tampered order: different limit price than committed
        BatchVault.RevealedOrder[] memory orders = new BatchVault.RevealedOrder[](1);
        orders[0] = BatchVault.RevealedOrder(true, 100e6, 700000, salt); // 700000 != 650000

        vm.expectRevert(BatchVault.CommitmentMismatch.selector);
        vm.prank(relayer);
        vault.settleBatch(batchId, orders, _buildAuths(orders.length), 650000, 100e6, 0, 100e6, 0, "");
    }

    function test_settleBatch_invalidClearingPrice_reverts() public {
        uint256 batchId = _openBatch();

        bytes32 salt = bytes32(uint256(1));
        bytes32 commitment = _makeCommitment(MARKET_ID, true, 100e6, 650000, salt);
        vm.prank(alice);
        vault.commitOrder(commitment, 100e6, MARKET_ID);
        _closeBatch(batchId);

        BatchVault.RevealedOrder[] memory orders = new BatchVault.RevealedOrder[](1);
        orders[0] = BatchVault.RevealedOrder(true, 100e6, 650000, salt);

        vm.expectRevert(BatchVault.InvalidClearingPrice.selector);
        vm.prank(relayer);
        vault.settleBatch(batchId, orders, _buildAuths(orders.length), 0, 100e6, 0, 100e6, 0, "");
    }

    // ─── Tests: claim position — buy orders ───────────────────────────────

    function test_claimPosition_unfilled_buy_nothingToClaim() public {
        uint256 batchId = _openBatch();

        // Alice bids too low to fill (limit 0.40, clearing will be 0.65)
        // With EIP-3009: Alice's USDC was never deposited — it stays in her wallet.
        // After settlement, claimPosition returns NothingToClaim (no refund needed).
        bytes32 salt = bytes32(uint256(1));
        uint256 amount = 100e6;
        uint256 limitAlice = 400000; // 0.40 — won't fill

        bytes32 commitment = _makeCommitment(MARKET_ID, true, amount, limitAlice, salt);
        vm.prank(alice);
        vault.commitOrder(commitment, amount, MARKET_ID);

        // Alice's USDC never left her wallet
        assertEq(usdc.balanceOf(alice), 1000e6);
        assertEq(usdc.balanceOf(address(vault)), 0);

        _closeBatch(batchId);

        BatchVault.RevealedOrder[] memory orders = new BatchVault.RevealedOrder[](1);
        orders[0] = BatchVault.RevealedOrder(true, amount, limitAlice, salt);

        vm.prank(relayer);
        vault.settleBatch(batchId, orders, _buildAuths(orders.length), 650000, 0, 0, 0, 0, "");

        // Alice still has all her USDC (never deposited)
        assertEq(usdc.balanceOf(alice), 1000e6);

        // claimPosition reverts — unfilled buy orders have nothing to claim
        vm.expectRevert(BatchVault.NothingToClaim.selector);
        vm.prank(alice);
        vault.claimPosition(batchId, true, amount, limitAlice, salt);
    }

    function test_claimPosition_doubleClaim_reverts() public {
        // Use a filled sell order to test AlreadyClaimed (sell orders always have a position to claim).
        // Unfilled buy orders have NothingToClaim with EIP-3009 (USDC was never deposited).
        uint256 batchId = _openBatch();

        uint256 yesCarol  = 100e6;
        uint256 amtAlice  = 100e6;
        bytes32 saltCarol = bytes32(uint256(1));
        bytes32 saltAlice = bytes32(uint256(2));

        bytes32 cCarol = _makeCommitment(MARKET_ID, false, yesCarol, 600000, saltCarol);
        bytes32 cAlice = _makeCommitment(MARKET_ID, true,  amtAlice, 700000, saltAlice);

        _mintYes(carol, yesCarol);
        _approveVaultCTF(carol);
        vm.prank(carol);
        vault.commitSellOrder(cCarol, yesCarol, MARKET_ID);
        vm.prank(alice);
        vault.commitOrder(cAlice, amtAlice, MARKET_ID);

        _closeBatch(batchId);

        BatchVault.RevealedOrder[] memory orders = new BatchVault.RevealedOrder[](2);
        orders[0] = BatchVault.RevealedOrder(false, yesCarol, 600000, saltCarol);
        orders[1] = BatchVault.RevealedOrder(true,  amtAlice, 700000, saltAlice);

        // Carol=sell (zeroAuth), Alice=filled buy (buyAuth)
        BatchVault.TransferAuth[] memory auths = new BatchVault.TransferAuth[](2);
        auths[0] = _zeroAuth();
        auths[1] = _buyAuth(alice);

        (uint256 buyVol, uint256 sellVol, uint256 netBuy, uint256 netSell) = _buildSettleParams(orders, 650000);
        vm.prank(relayer);
        vault.settleBatch(batchId, orders, auths, 650000, buyVol, sellVol, netBuy, netSell, "");

        // Carol claims her USDC from filled sell order
        vm.prank(carol);
        vault.claimPosition(batchId, false, yesCarol, 600000, saltCarol);

        // Second claim reverts AlreadyClaimed
        vm.expectRevert(BatchVault.AlreadyClaimed.selector);
        vm.prank(carol);
        vault.claimPosition(batchId, false, yesCarol, 600000, saltCarol);
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

        bytes32 cAlice = _makeCommitment(MARKET_ID, true,  amtAlice, 700000, saltAlice);
        bytes32 cCarol = _makeCommitment(MARKET_ID, false, yesCarol, 600000, saltCarol);

        vm.prank(alice);
        vault.commitOrder(cAlice, amtAlice, MARKET_ID);

        _mintYes(carol, yesCarol);
        _approveVaultCTF(carol);
        vm.prank(carol);
        vault.commitSellOrder(cCarol, yesCarol, MARKET_ID);

        _closeBatch(batchId);

        uint256 clearingPrice = 650000; // 0.65
        BatchVault.RevealedOrder[] memory orders = new BatchVault.RevealedOrder[](2);
        orders[0] = BatchVault.RevealedOrder(true,  amtAlice, 700000, saltAlice);
        orders[1] = BatchVault.RevealedOrder(false, yesCarol, 600000, saltCarol);

        // Alice=filled buy (buyAuth), Carol=sell (zeroAuth)
        BatchVault.TransferAuth[] memory auths = new BatchVault.TransferAuth[](2);
        auths[0] = _buyAuth(alice);
        auths[1] = _zeroAuth();

        (uint256 buyVol, uint256 sellVol, uint256 netBuy, uint256 netSell) = _buildSettleParams(orders, clearingPrice);
        vm.prank(relayer);
        vault.settleBatch(batchId, orders, auths, clearingPrice, buyVol, sellVol, netBuy, netSell, "");

        // Carol's position: filledAmount = 80 * 0.65 = 52 USDC
        BatchVault.Position memory pos = vault.getPosition(batchId, cCarol);
        uint256 expectedUSDC = yesCarol * clearingPrice / 1e6; // 52e6
        assertEq(pos.filledAmount, expectedUSDC);
        assertEq(pos.refundAmount, 0);
        assertFalse(pos.isBuy);

        uint256 carolUSDCBefore = usdc.balanceOf(carol);
        vm.prank(carol);
        vault.claimPosition(batchId, false, yesCarol, 600000, saltCarol);

        // Carol receives USDC for her sold YES tokens
        assertEq(usdc.balanceOf(carol), carolUSDCBefore + expectedUSDC);
    }

    function test_sellOrder_unfilled_refundsYES() public {
        uint256 batchId = _openBatch();

        // Carol tries to sell YES at min 0.80, but clearing price is 0.65 — won't fill
        uint256 yesCarol = 50e6;
        bytes32 saltCarol = bytes32(uint256(1));
        bytes32 cCarol = _makeCommitment(MARKET_ID, false, yesCarol, 800000, saltCarol);

        _mintYes(carol, yesCarol);
        _approveVaultCTF(carol);
        vm.prank(carol);
        vault.commitSellOrder(cCarol, yesCarol, MARKET_ID);

        _closeBatch(batchId);

        BatchVault.RevealedOrder[] memory orders = new BatchVault.RevealedOrder[](1);
        orders[0] = BatchVault.RevealedOrder(false, yesCarol, 800000, saltCarol);

        // Settlement with no buy orders — just need clearing price for the verify
        vm.prank(relayer);
        vault.settleBatch(batchId, orders, _buildAuths(orders.length), 650000, 0, 0, 0, 0, "");

        // Carol's position: no fill, full refund of YES tokens
        BatchVault.Position memory pos = vault.getPosition(batchId, cCarol);
        assertEq(pos.filledAmount, 0);
        assertEq(pos.refundAmount, yesCarol); // YES tokens back

        uint256 carolYesBefore = ctf.balanceOf(carol, _yesTokenId());
        vm.prank(carol);
        vault.claimPosition(batchId, false, yesCarol, 800000, saltCarol);

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

        bytes32 cAlice = _makeCommitment(MARKET_ID, true,  amtAlice, 700000, bytes32(uint256(1)));
        bytes32 cCarol = _makeCommitment(MARKET_ID, false, yesCarol, 600000, bytes32(uint256(2)));

        vm.prank(alice);
        vault.commitOrder(cAlice, amtAlice, MARKET_ID);

        _mintYes(carol, yesCarol);
        _approveVaultCTF(carol);
        vm.prank(carol);
        vault.commitSellOrder(cCarol, yesCarol, MARKET_ID);

        _closeBatch(batchId);

        uint256 clearingPrice = 650000;
        BatchVault.RevealedOrder[] memory orders = new BatchVault.RevealedOrder[](2);
        orders[0] = BatchVault.RevealedOrder(true,  amtAlice, 700000, bytes32(uint256(1)));
        orders[1] = BatchVault.RevealedOrder(false, yesCarol, 600000, bytes32(uint256(2)));

        // Alice=filled buy (buyAuth), Carol=sell (zeroAuth)
        BatchVault.TransferAuth[] memory auths = new BatchVault.TransferAuth[](2);
        auths[0] = _buyAuth(alice);
        auths[1] = _zeroAuth();

        (uint256 buyVol, uint256 sellVol, uint256 netBuy, uint256 netSell) = _buildSettleParams(orders, clearingPrice);
        vm.prank(relayer);
        vault.settleBatch(batchId, orders, auths, clearingPrice, buyVol, sellVol, netBuy, netSell, "");

        BatchVault.Batch memory b = vault.getBatch(batchId);
        // netBuyAmount = 130 - 80*0.65 = 130 - 52 = 78 USDC
        assertEq(b.netBuyAmount, 78e6);
        // yesTokensReceived via mockBuyYes: 78e6 * 1e6 / 650000 = 120_000_000 (price-correct)
        assertEq(b.yesTokensReceived, 78e6 * 1_000_000 / 650_000);
        assertEq(b.filledSellYes, yesCarol);
        assertEq(b.totalFilledBuyVol, amtAlice);

        // Alice claims: (130/130) * (120 + 80) = 200 YES tokens
        BatchVault.Position memory alicePos = vault.getPosition(batchId, cAlice);
        uint256 expectedYes = (alicePos.filledAmount * (b.yesTokensReceived + b.filledSellYes)) / b.totalFilledBuyVol;
        assertEq(expectedYes, 200e6);

        uint256 aliceYesBefore = ctf.balanceOf(alice, _yesTokenId());
        vm.prank(alice);
        vault.claimPosition(batchId, true, amtAlice, 700000, bytes32(uint256(1)));
        assertEq(ctf.balanceOf(alice, _yesTokenId()), aliceYesBefore + expectedYes);
    }

    // ─── Tests: privacy properties ─────────────────────────────────────────

    function test_privacy_onlyCommitmentsOnchain_beforeSettlement() public {
        _openBatch();

        bytes32 salt = bytes32(uint256(42));
        uint256 amount = 100e6;
        bool isBuy = true;
        uint256 limitPrice = 720000;

        // Commitment hash: no trader address — salt is the 256-bit secret credential
        bytes32 commitment = _makeCommitment(MARKET_ID, isBuy, amount, limitPrice, salt);

        vm.prank(alice);
        vault.commitOrder(commitment, amount, MARKET_ID);

        // On-chain commitment reveals ONLY the hash — no trader address, direction, price, or salt
        BatchVault.Commitment memory c = vault.getCommitment(1, 0);
        assertEq(c.hash, commitment);   // hash is visible (commitment itself)
        assertEq(c.amount, amount);     // amount locked is visible
        // trader address, isBuy, limitPrice, and salt are NOT stored — hidden from on-chain observers
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
        // Note: dave no longer needs to approve vault — EIP-3009 pull happens at settlement only

        uint256 amount = 100e6;
        uint256 limitPrice = 650000;
        bytes32 salt = bytes32(uint256(99));
        uint256 deadline = block.timestamp + 1 hours;

        bytes32 commitment = _makeCommitment(MARKET_ID, true, amount, limitPrice, salt);
        bytes memory sig = _signCommitOrder(daveKey, commitment, amount, batchId, 0, deadline);

        uint256 relayerBefore = usdc.balanceOf(relayer);
        vm.prank(relayer);
        vault.commitOrderFor(commitment, amount, dave, 0, deadline, sig, MARKET_ID);

        // EIP-3009: no USDC moves at commit time — dave's funds stay in his wallet
        assertEq(usdc.balanceOf(dave), 1000e6);           // dave's USDC unchanged
        assertEq(usdc.balanceOf(address(vault)), 0);       // vault gets USDC only at settlement
        assertEq(usdc.balanceOf(relayer), relayerBefore);  // relayer doesn't pay upfront

        BatchVault.Commitment memory c = vault.getCommitment(batchId, 0);
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

        bytes32 commitment = _makeCommitment(MARKET_ID, true, 50e6, 600000, bytes32(uint256(7)));
        bytes memory sig = _signCommitOrder(daveKey, commitment, 50e6, batchId, 0, block.timestamp + 1 hours);

        vm.expectEmit(true, true, false, false);
        emit BatchVault.OrderCommitted(batchId, commitment);

        vm.prank(relayer);
        vault.commitOrderFor(commitment, 50e6, dave, 0, block.timestamp + 1 hours, sig, MARKET_ID);
    }

    function test_commitOrderFor_invalidSignature_reverts() public {
        _openBatch();
        uint256 daveKey  = 0xDA7E;
        uint256 eveKey   = 0xEE7E;
        address dave = vm.addr(daveKey);
        usdc.mint(dave, 500e6);
        vm.prank(dave);
        usdc.approve(address(vault), type(uint256).max);

        bytes32 commitment = _makeCommitment(MARKET_ID, true, 50e6, 600000, bytes32(uint256(1)));
        bytes memory badSig = _signCommitOrder(eveKey, commitment, 50e6, 1, 0, block.timestamp + 1 hours);

        vm.expectRevert(BatchVault.InvalidSignature.selector);
        vm.prank(relayer);
        vault.commitOrderFor(commitment, 50e6, dave, 0, block.timestamp + 1 hours, badSig, MARKET_ID);
    }

    function test_commitOrderFor_expiredDeadline_reverts() public {
        _openBatch();
        uint256 daveKey = 0xDA7E;
        address dave = vm.addr(daveKey);
        usdc.mint(dave, 500e6);
        vm.prank(dave);
        usdc.approve(address(vault), type(uint256).max);

        bytes32 commitment = _makeCommitment(MARKET_ID, true, 50e6, 600000, bytes32(uint256(1)));
        uint256 deadline = block.timestamp - 1;
        bytes memory sig = _signCommitOrder(daveKey, commitment, 50e6, 1, 0, deadline);

        vm.expectRevert(BatchVault.SignatureExpired.selector);
        vm.prank(relayer);
        vault.commitOrderFor(commitment, 50e6, dave, 0, deadline, sig, MARKET_ID);
    }

    function test_commitOrderFor_wrongNonce_reverts() public {
        _openBatch();
        uint256 daveKey = 0xDA7E;
        address dave = vm.addr(daveKey);
        usdc.mint(dave, 500e6);
        vm.prank(dave);
        usdc.approve(address(vault), type(uint256).max);

        bytes32 commitment = _makeCommitment(MARKET_ID, true, 50e6, 600000, bytes32(uint256(1)));
        bytes memory sig = _signCommitOrder(daveKey, commitment, 50e6, 1, 1, block.timestamp + 1 hours);

        vm.expectRevert(BatchVault.InvalidSignature.selector);
        vm.prank(relayer);
        vault.commitOrderFor(commitment, 50e6, dave, 1, block.timestamp + 1 hours, sig, MARKET_ID);
    }

    function test_commitOrderFor_replayReverts() public {
        uint256 batchId = _openBatch();
        uint256 daveKey = 0xDA7E;
        address dave = vm.addr(daveKey);
        usdc.mint(dave, 1000e6);
        vm.prank(dave);
        usdc.approve(address(vault), type(uint256).max);

        bytes32 commitment = _makeCommitment(MARKET_ID, true, 50e6, 600000, bytes32(uint256(1)));
        bytes memory sig = _signCommitOrder(daveKey, commitment, 50e6, batchId, 0, block.timestamp + 1 hours);

        vm.prank(relayer);
        vault.commitOrderFor(commitment, 50e6, dave, 0, block.timestamp + 1 hours, sig, MARKET_ID);

        vm.expectRevert(BatchVault.InvalidSignature.selector);
        vm.prank(relayer);
        vault.commitOrderFor(commitment, 50e6, dave, 0, block.timestamp + 1 hours, sig, MARKET_ID);
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

        bytes32 commitment = _makeCommitment(MARKET_ID, true, amount, limitPrice, salt);
        bytes memory sig = _signCommitOrder(daveKey, commitment, amount, batchId, 0, block.timestamp + 1 hours);

        vm.prank(relayer);
        vault.commitOrderFor(commitment, amount, dave, 0, block.timestamp + 1 hours, sig, MARKET_ID);

        _closeBatch(batchId);

        BatchVault.RevealedOrder[] memory orders = new BatchVault.RevealedOrder[](1);
        orders[0] = BatchVault.RevealedOrder(true, amount, limitPrice, salt);

        // Dave is a filled buy — auth must carry `from = dave`
        BatchVault.TransferAuth[] memory auths = new BatchVault.TransferAuth[](1);
        auths[0] = _buyAuth(dave);

        vm.prank(relayer);
        vault.settleBatch(batchId, orders, auths, 650000, amount, 0, amount, 0, "");

        assertEq(uint256(vault.getBatch(batchId).status), uint256(BatchVault.BatchStatus.SETTLED));

        BatchVault.Position memory pos = vault.getPosition(batchId, commitment);
        assertEq(pos.filledAmount, amount);
    }

    // ─── Tests: sell-only batch via Polymarket ─────────────────────────────

    function test_sellOnly_fillsViaPolymarket() public {
        uint256 batchId = _openBatch();

        // Carol sells 50 YES tokens at min $0.60; no buyers in this batch
        uint256 yesCarol = 50e6;
        bytes32 saltCarol = bytes32(uint256(1));
        bytes32 cCarol = _makeCommitment(MARKET_ID, false, yesCarol, 600000, saltCarol);

        _mintYes(carol, yesCarol);
        _approveVaultCTF(carol);
        vm.prank(carol);
        vault.commitSellOrder(cCarol, yesCarol, MARKET_ID);

        _closeBatch(batchId);

        // Relayer uses Polymarket mid price (0.65) — all sells route to Polymarket
        uint256 clearingPrice = 650_000;
        BatchVault.RevealedOrder[] memory orders = new BatchVault.RevealedOrder[](1);
        orders[0] = BatchVault.RevealedOrder(false, yesCarol, 600_000, saltCarol);

        // netBuyAmount = 0, netSellYes = 50 YES tokens
        uint256 netSellYes = yesCarol;

        vm.prank(relayer);
        vault.settleBatch(batchId, orders, _buildAuths(orders.length), clearingPrice, 0, yesCarol, 0, netSellYes, "");

        // mockSellYes burned 50 YES from vault, minted 50 * 0.65 = 32.5 USDC to vault
        // Carol's filledAmount = 50e6 * 0.65 = 32_500_000 USDC
        uint256 expectedUSDC = yesCarol * clearingPrice / 1e6; // 32_500_000

        BatchVault.Position memory pos = vault.getPosition(batchId, cCarol);
        assertEq(pos.filledAmount, expectedUSDC);
        assertEq(pos.refundAmount, 0);
        assertFalse(pos.isBuy);

        // Vault should have exactly expectedUSDC (minted by mockSellYes)
        assertEq(usdc.balanceOf(address(vault)), expectedUSDC);

        // Carol claims: receives USDC from vault
        uint256 carolUSDCBefore = usdc.balanceOf(carol);
        vm.prank(carol);
        vault.claimPosition(batchId, false, yesCarol, 600_000, saltCarol);

        assertEq(usdc.balanceOf(carol), carolUSDCBefore + expectedUSDC);
        assertEq(usdc.balanceOf(address(vault)), 0);
    }

    // ─── Tests: relayer access control ────────────────────────────────────

    function test_settleByNonRelayer_reverts() public {
        uint256 batchId = _openBatch();

        bytes32 commitment = _makeCommitment(MARKET_ID, true, 100e6, 650000, bytes32(uint256(1)));
        vm.prank(alice);
        vault.commitOrder(commitment, 100e6, MARKET_ID);
        _closeBatch(batchId);

        BatchVault.RevealedOrder[] memory orders = new BatchVault.RevealedOrder[](1);
        orders[0] = BatchVault.RevealedOrder(true, 100e6, 650000, bytes32(uint256(1)));

        vm.expectRevert(BatchVault.OnlyRelayer.selector);
        vm.prank(alice);
        vault.settleBatch(batchId, orders, _buildAuths(orders.length), 650000, 100e6, 0, 100e6, 0, "");
    }

    // ─── Tests: concurrent multi-market ────────────────────────────────────

    function test_twoMarketsConcurrent() public {
        bytes32 MARKET_ID_2 = keccak256("polymarket:will-btc-reach-150k-2026");

        // Fund bob for market 2 (alice already funded in setUp)
        // Both markets open simultaneously
        vm.prank(relayer);
        uint256 batchId1 = vault.openBatch(MARKET_ID);
        vm.prank(relayer);
        uint256 batchId2 = vault.openBatch(MARKET_ID_2);

        assertEq(batchId1, 1);
        assertEq(batchId2, 2);
        assertEq(vault.getCurrentBatchId(MARKET_ID),   1);
        assertEq(vault.getCurrentBatchId(MARKET_ID_2), 2);
        assertEq(uint256(vault.getBatch(1).status), uint256(BatchVault.BatchStatus.OPEN));
        assertEq(uint256(vault.getBatch(2).status), uint256(BatchVault.BatchStatus.OPEN));

        // Alice commits to market 1 with a market-1 commitment hash
        bytes32 saltAlice = bytes32(uint256(1));
        bytes32 saltBob   = bytes32(uint256(2));
        uint256 amtAlice  = 100e6;
        uint256 amtBob    = 50e6;

        bytes32 cAlice = _makeCommitment(MARKET_ID,   true, amtAlice, 650000, saltAlice);
        bytes32 cBob   = _makeCommitment(MARKET_ID_2, true, amtBob,   700000, saltBob);

        vm.prank(alice);
        vault.commitOrder(cAlice, amtAlice, MARKET_ID);
        vm.prank(bob);
        vault.commitOrder(cBob, amtBob, MARKET_ID_2);

        // Orders land in the correct batches
        assertEq(vault.getBatch(1).commitmentCount, 1);
        assertEq(vault.getBatch(2).commitmentCount, 1);
        assertEq(vault.getBatch(1).totalDeposited, amtAlice);
        assertEq(vault.getBatch(2).totalDeposited, amtBob);

        // Close and settle market 1 — market 2 remains OPEN
        vm.warp(block.timestamp + vault.BATCH_WINDOW() + 1);
        vault.closeBatch(MARKET_ID);
        assertEq(uint256(vault.getBatch(1).status), uint256(BatchVault.BatchStatus.SETTLING));
        assertEq(uint256(vault.getBatch(2).status), uint256(BatchVault.BatchStatus.OPEN));

        BatchVault.RevealedOrder[] memory orders1 = new BatchVault.RevealedOrder[](1);
        orders1[0] = BatchVault.RevealedOrder(true, amtAlice, 650000, saltAlice);

        BatchVault.TransferAuth[] memory auths1 = new BatchVault.TransferAuth[](1);
        auths1[0] = _buyAuth(alice);

        vm.prank(relayer);
        vault.settleBatch(batchId1, orders1, auths1, 650000, amtAlice, 0, amtAlice, 0, "");
        assertEq(uint256(vault.getBatch(1).status), uint256(BatchVault.BatchStatus.SETTLED));

        // Market 2 batch is still OPEN after market 1 settles
        assertEq(uint256(vault.getBatch(2).status), uint256(BatchVault.BatchStatus.OPEN));

        // Close and settle market 2
        vault.closeBatch(MARKET_ID_2);
        assertEq(uint256(vault.getBatch(2).status), uint256(BatchVault.BatchStatus.SETTLING));

        BatchVault.RevealedOrder[] memory orders2 = new BatchVault.RevealedOrder[](1);
        orders2[0] = BatchVault.RevealedOrder(true, amtBob, 700000, saltBob);

        BatchVault.TransferAuth[] memory auths2 = new BatchVault.TransferAuth[](1);
        auths2[0] = _buyAuth(bob);

        vm.prank(relayer);
        vault.settleBatch(batchId2, orders2, auths2, 700000, amtBob, 0, amtBob, 0, "");
        assertEq(uint256(vault.getBatch(2).status), uint256(BatchVault.BatchStatus.SETTLED));

        // Each trader's position is in the correct batch (keyed by commitment hash)
        BatchVault.Position memory alicePos = vault.getPosition(batchId1, cAlice);
        BatchVault.Position memory bobPos   = vault.getPosition(batchId2, cBob);
        assertEq(alicePos.filledAmount, amtAlice);
        assertEq(bobPos.filledAmount,   amtBob);

        // Cross-check: alice has no position in batch 2, bob has none in batch 1
        // (use commitment hashes that were never submitted to those batches)
        bytes32 aliceForBatch2 = _makeCommitment(MARKET_ID_2, true, amtAlice, 650000, saltAlice);
        bytes32 bobForBatch1   = _makeCommitment(MARKET_ID,   true, amtBob,   700000, saltBob);
        BatchVault.Position memory aliceInBatch2 = vault.getPosition(batchId2, aliceForBatch2);
        BatchVault.Position memory bobInBatch1   = vault.getPosition(batchId1, bobForBatch1);
        assertEq(aliceInBatch2.filledAmount, 0);
        assertEq(bobInBatch1.filledAmount,   0);
    }

    // ─── Tests: claimWithProof (ZK claim — no address revealed on-chain) ──

    /// @notice Happy path: Alice's filled buy order claimed via ZK proof.
    ///   - Commitment hash has no trader address (just marketId, isBuy, amount, limitPrice, salt).
    ///   - Payout goes to `recipient` derived from public inputs (no msg.sender link).
    ///   - Nullifier prevents double-claim.
    function test_claimWithProof_filledBuy_receivesYES() public {
        uint256 batchId = _openBatch();

        uint256 amount     = 100e6;
        uint256 limitPrice = 650000;
        bytes32 salt       = bytes32(uint256(42));
        address recipient  = alice; // real wallet that receives YES tokens

        bytes32 commitment = _makeCommitment(MARKET_ID, true, amount, limitPrice, salt);

        // Commit order (alice acts as ephemeral here for simplicity)
        vm.prank(alice);
        vault.commitOrder(commitment, amount, MARKET_ID);

        _closeBatch(batchId);

        BatchVault.RevealedOrder[] memory orders = new BatchVault.RevealedOrder[](1);
        orders[0] = BatchVault.RevealedOrder(true, amount, limitPrice, salt);

        BatchVault.TransferAuth[] memory auths = new BatchVault.TransferAuth[](1);
        auths[0] = _buyAuth(alice);

        uint256 clearingPrice = 650000;
        vm.prank(relayer);
        vault.settleBatch(batchId, orders, auths, clearingPrice, amount, 0, amount, 0, "");

        // After settlement: claimMerkleRoot is set.
        // For a single-order batch, root = commitment (leaf == root since depth=0 padding).
        BatchVault.Batch memory b = vault.getBatch(batchId);
        assertEq(uint256(b.status), uint256(BatchVault.BatchStatus.SETTLED));
        assertTrue(b.claimMerkleRoot != bytes32(0));

        // Build public inputs for claimWithProof
        bytes32[] memory publicInputs = _buildClaimPublicInputs(
            batchId,
            b.claimMerkleRoot,
            clearingPrice,
            commitment,
            salt,
            recipient,
            true,   // fills
            amount, // fillAmount = USDC committed
            0,      // refundAmount
            true    // isBuy
        );

        uint256 aliceYesBefore = ctf.balanceOf(alice, _yesTokenId());

        // Anyone can submit the proof (relayer pays gas; recipient receives tokens)
        vault.claimWithProof(batchId, "", publicInputs);

        // Alice received YES tokens
        assertGt(ctf.balanceOf(alice, _yesTokenId()), aliceYesBefore);

        // Nullifier is marked used
        bytes32 nullifier = keccak256(abi.encode(commitment, batchId, salt));
        assertTrue(vault.usedNullifiers(nullifier));
    }

    /// @notice ZK claim double-spend prevention: nullifier reuse reverts.
    function test_claimWithProof_doubleClaim_reverts() public {
        uint256 batchId = _openBatch();

        uint256 amount     = 100e6;
        uint256 limitPrice = 650000;
        bytes32 salt       = bytes32(uint256(42));

        bytes32 commitment = _makeCommitment(MARKET_ID, true, amount, limitPrice, salt);

        vm.prank(alice);
        vault.commitOrder(commitment, amount, MARKET_ID);

        _closeBatch(batchId);

        BatchVault.RevealedOrder[] memory orders = new BatchVault.RevealedOrder[](1);
        orders[0] = BatchVault.RevealedOrder(true, amount, limitPrice, salt);
        BatchVault.TransferAuth[] memory auths = new BatchVault.TransferAuth[](1);
        auths[0] = _buyAuth(alice);

        vm.prank(relayer);
        vault.settleBatch(batchId, orders, auths, 650000, amount, 0, amount, 0, "");

        BatchVault.Batch memory b = vault.getBatch(batchId);
        bytes32[] memory publicInputs = _buildClaimPublicInputs(
            batchId, b.claimMerkleRoot, 650000, commitment, salt,
            alice, true, amount, 0, true
        );

        // First claim succeeds
        vault.claimWithProof(batchId, "", publicInputs);

        // Second claim with same nullifier reverts
        vm.expectRevert(BatchVault.AlreadyClaimed.selector);
        vault.claimWithProof(batchId, "", publicInputs);
    }

    /// @notice claimWithProof reverts if batch is not yet settled.
    function test_claimWithProof_batchNotSettled_reverts() public {
        uint256 batchId = _openBatch();

        uint256 amount     = 100e6;
        bytes32 salt       = bytes32(uint256(1));
        bytes32 commitment = _makeCommitment(MARKET_ID, true, amount, 650000, salt);

        vm.prank(alice);
        vault.commitOrder(commitment, amount, MARKET_ID);

        // Batch is still OPEN — don't close or settle
        bytes32[] memory publicInputs = _buildClaimPublicInputs(
            batchId, bytes32(0), 650000, commitment, salt,
            alice, true, amount, 0, true
        );

        vm.expectRevert(BatchVault.BatchNotSettled.selector);
        vault.claimWithProof(batchId, "", publicInputs);
    }

    /// @notice claimWithProof reverts if publicInputs[0] (batchId) doesn't match.
    function test_claimWithProof_wrongBatchId_reverts() public {
        uint256 batchId = _openBatch();

        uint256 amount     = 100e6;
        bytes32 salt       = bytes32(uint256(1));
        bytes32 commitment = _makeCommitment(MARKET_ID, true, amount, 650000, salt);

        vm.prank(alice);
        vault.commitOrder(commitment, amount, MARKET_ID);

        _closeBatch(batchId);

        BatchVault.RevealedOrder[] memory orders = new BatchVault.RevealedOrder[](1);
        orders[0] = BatchVault.RevealedOrder(true, amount, 650000, salt);
        BatchVault.TransferAuth[] memory auths = new BatchVault.TransferAuth[](1);
        auths[0] = _buyAuth(alice);
        vm.prank(relayer);
        vault.settleBatch(batchId, orders, auths, 650000, amount, 0, amount, 0, "");

        BatchVault.Batch memory b = vault.getBatch(batchId);

        // Pass wrong batchId (999) in public inputs but call with correct batchId
        bytes32[] memory publicInputs = _buildClaimPublicInputs(
            999, // wrong batchId in inputs
            b.claimMerkleRoot, 650000, commitment, salt,
            alice, true, amount, 0, true
        );

        vm.expectRevert(BatchVault.CommitmentMismatch.selector);
        vault.claimWithProof(batchId, "", publicInputs);
    }

    /// @notice claimWithProof reverts if publicInputs[1] (claimMerkleRoot) is wrong.
    function test_claimWithProof_wrongRoot_reverts() public {
        uint256 batchId = _openBatch();

        uint256 amount     = 100e6;
        bytes32 salt       = bytes32(uint256(1));
        bytes32 commitment = _makeCommitment(MARKET_ID, true, amount, 650000, salt);

        vm.prank(alice);
        vault.commitOrder(commitment, amount, MARKET_ID);

        _closeBatch(batchId);

        BatchVault.RevealedOrder[] memory orders = new BatchVault.RevealedOrder[](1);
        orders[0] = BatchVault.RevealedOrder(true, amount, 650000, salt);
        BatchVault.TransferAuth[] memory auths = new BatchVault.TransferAuth[](1);
        auths[0] = _buyAuth(alice);
        vm.prank(relayer);
        vault.settleBatch(batchId, orders, auths, 650000, amount, 0, amount, 0, "");

        // Pass wrong Merkle root
        bytes32[] memory publicInputs = _buildClaimPublicInputs(
            batchId,
            bytes32(uint256(0xDEAD)), // wrong root
            650000, commitment, salt,
            alice, true, amount, 0, true
        );

        vm.expectRevert(BatchVault.CommitmentMismatch.selector);
        vault.claimWithProof(batchId, "", publicInputs);
    }

    /// @notice claimWithProof for a filled sell order — payout is USDC to recipient.
    function test_claimWithProof_filledSell_receivesUSDC() public {
        uint256 batchId = _openBatch();

        // Alice buys 100 USDC, Carol sells 80 YES — Carol uses claimWithProof
        uint256 amtAlice = 100e6;
        uint256 yesCarol = 80e6;
        bytes32 saltAlice = bytes32(uint256(1));
        bytes32 saltCarol = bytes32(uint256(2));

        bytes32 cAlice = _makeCommitment(MARKET_ID, true,  amtAlice, 700000, saltAlice);
        bytes32 cCarol = _makeCommitment(MARKET_ID, false, yesCarol, 600000, saltCarol);

        vm.prank(alice);
        vault.commitOrder(cAlice, amtAlice, MARKET_ID);

        _mintYes(carol, yesCarol);
        _approveVaultCTF(carol);
        vm.prank(carol);
        vault.commitSellOrder(cCarol, yesCarol, MARKET_ID);

        _closeBatch(batchId);

        uint256 clearingPrice = 650000;
        BatchVault.RevealedOrder[] memory orders = new BatchVault.RevealedOrder[](2);
        orders[0] = BatchVault.RevealedOrder(true,  amtAlice, 700000, saltAlice);
        orders[1] = BatchVault.RevealedOrder(false, yesCarol, 600000, saltCarol);

        BatchVault.TransferAuth[] memory auths = new BatchVault.TransferAuth[](2);
        auths[0] = _buyAuth(alice);
        auths[1] = _zeroAuth();

        (uint256 buyVol, uint256 sellVol, uint256 netBuy, uint256 netSell) = _buildSettleParams(orders, clearingPrice);
        vm.prank(relayer);
        vault.settleBatch(batchId, orders, auths, clearingPrice, buyVol, sellVol, netBuy, netSell, "");

        BatchVault.Batch memory b = vault.getBatch(batchId);

        // Carol's filled sell: fillAmount = yesCarol * clearingPrice / 1e6 = 52e6 USDC
        uint256 carolFillUSDC = yesCarol * clearingPrice / 1e6; // 52e6

        // Use a fresh address as recipient (demonstrates address privacy)
        address freshRecipient = address(0xF45E);

        bytes32[] memory publicInputs = _buildClaimPublicInputs(
            batchId,
            b.claimMerkleRoot,
            clearingPrice,
            cCarol,
            saltCarol,
            freshRecipient,
            true,           // fills
            carolFillUSDC,  // fillAmount = USDC payout
            0,              // refundAmount
            false           // isBuy = false (sell order)
        );

        uint256 recipientUSDCBefore = usdc.balanceOf(freshRecipient);
        vault.claimWithProof(batchId, "", publicInputs);

        // Fresh recipient receives USDC — carol's address never appeared on-chain
        assertEq(usdc.balanceOf(freshRecipient), recipientUSDCBefore + carolFillUSDC);
    }
}
