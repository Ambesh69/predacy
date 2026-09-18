// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/BatchVaultV11.sol";

contract V11Token is IVaultERC20 {
    mapping(address => uint256) public override balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external { balanceOf[to] += amount; }
    function burn(address from, uint256 amount) external {
        require(balanceOf[from] >= amount, "balance");
        balanceOf[from] -= amount;
    }
    function approve(address spender, uint256 amount) external override returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }
    function transfer(address to, uint256 amount) external override returns (bool) {
        require(balanceOf[msg.sender] >= amount, "balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }
    function transferFrom(address from, address to, uint256 amount) external override returns (bool) {
        require(allowance[from][msg.sender] >= amount, "allowance");
        require(balanceOf[from] >= amount, "balance");
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

contract V11CTF {
    mapping(address => mapping(uint256 => uint256)) public balanceOf;
    mapping(address => mapping(address => bool)) public isApprovedForAll;

    function mint(address to, uint256 id, uint256 amount) external { balanceOf[to][id] += amount; }
    function setApprovalForAll(address operator, bool approved) external {
        isApprovedForAll[msg.sender][operator] = approved;
    }
    function safeTransferFrom(address from, address to, uint256 id, uint256 amount, bytes calldata) external {
        require(from == msg.sender || isApprovedForAll[from][msg.sender], "approval");
        require(balanceOf[from][id] >= amount, "balance");
        balanceOf[from][id] -= amount;
        balanceOf[to][id] += amount;
        if (to.code.length > 0) {
            bytes4 accepted = BatchVaultV11(to).onERC1155Received(msg.sender, from, id, amount, "");
            require(accepted == 0xf23a6e61, "receiver");
        }
    }
}

contract V11Onramp is ICollateralOnramp {
    V11Token public immutable usdce;
    V11Token public immutable pusd;
    constructor(V11Token usdce_, V11Token pusd_) { usdce = usdce_; pusd = pusd_; }
    function wrap(address asset, address to, uint256 amount) external {
        require(asset == address(usdce), "asset");
        usdce.transferFrom(msg.sender, address(this), amount);
        pusd.mint(to, amount);
    }
}

contract V11Offramp is ICollateralOfframp {
    V11Token public immutable usdce;
    V11Token public immutable pusd;
    constructor(V11Token usdce_, V11Token pusd_) { usdce = usdce_; pusd = pusd_; }
    function unwrap(address asset, address to, uint256 amount) external {
        require(asset == address(usdce), "asset");
        pusd.transferFrom(msg.sender, address(this), amount);
        pusd.burn(address(this), amount);
        usdce.mint(to, amount);
    }
}

contract V11Verifier is IAllocationVerifier {
    bool public valid = true;
    function setValid(bool value) external { valid = value; }
    function verify(bytes calldata, bytes32[] calldata) external view returns (bool) { return valid; }
}

contract BatchVaultV11Test is Test {
    V11Token usdce;
    V11Token pusd;
    V11CTF ctf;
    V11Onramp onramp;
    V11Offramp offramp;
    V11Verifier verifier;
    BatchVaultV11 vault;

    address constant BUYER = address(0xA11CE);
    address constant SELLER = address(0xB0B);
    address constant WALLET = address(0xD0D0);
    address constant GUARDIAN = address(0xBEEF);
    bytes32 constant MARKET = bytes32(uint256(1));
    uint256 constant YES = 11;
    uint256 constant NO = 12;

    function setUp() public {
        usdce = new V11Token();
        pusd = new V11Token();
        ctf = new V11CTF();
        onramp = new V11Onramp(usdce, pusd);
        offramp = new V11Offramp(usdce, pusd);
        verifier = new V11Verifier();
        vault = new BatchVaultV11(
            usdce, pusd, onramp, offramp, IConditionalTokens(address(ctf)),
            verifier, address(this), GUARDIAN, WALLET
        );
        vm.prank(GUARDIAN);
        vault.setTradingPaused(false);
    }

    function test_partialNoBuyRoutesPusdAndRefundsUnspentCollateral() public {
        uint256 id = vault.openBatch(MARKET, YES, NO);
        _buy(id, SettlementAccounting.Side.NO_BUY, 410_000, bytes32(uint256(1)));
        _close(id);
        vault.routeAssets(id, 410_000, 0, 0);
        assertEq(pusd.balanceOf(WALLET), 410_000);

        vm.prank(WALLET);
        pusd.transfer(address(0xCAFE), 405_000);
        ctf.mint(WALLET, NO, 1_000_000);
        vm.prank(WALLET);
        pusd.transfer(address(vault), 5_000);
        vm.prank(WALLET);
        ctf.safeTransferFrom(WALLET, address(vault), NO, 1_000_000, "");

        SettlementAccounting.Allocation[] memory allocations = new SettlementAccounting.Allocation[](1);
        allocations[0] = SettlementAccounting.Allocation(
            SettlementAccounting.Side.NO_BUY, 410_000, 0, 1_000_000, 405_000, 5_000
        );
        vault.finalize(id, allocations, _proofs(1), 5_000);
        assertEq(vault.reservedUsdc(), 5_000);
        assertEq(vault.reservedTokens(NO), 1_000_000);

        vm.prank(BUYER);
        vault.claim(id, 0);
        assertEq(usdce.balanceOf(BUYER), 5_000);
        assertEq(ctf.balanceOf(BUYER, NO), 1_000_000);
        assertEq(vault.reservedUsdc(), 0);
        assertEq(vault.reservedTokens(NO), 0);
    }

    function test_yesSellReturnsActualNetProceeds() public {
        uint256 id = vault.openBatch(MARKET, YES, NO);
        _sell(id, SettlementAccounting.Side.YES_SELL, 1_000_000, bytes32(uint256(2)));
        _close(id);
        vault.routeAssets(id, 0, 1_000_000, 0);
        assertEq(ctf.balanceOf(WALLET, YES), 1_000_000);

        pusd.mint(WALLET, 575_000);
        vm.prank(WALLET);
        pusd.transfer(address(vault), 575_000);
        SettlementAccounting.Allocation[] memory allocations = new SettlementAccounting.Allocation[](1);
        allocations[0] = SettlementAccounting.Allocation(
            SettlementAccounting.Side.YES_SELL, 1_000_000, 0, 1_000_000, 575_000, 0
        );
        vault.finalize(id, allocations, _proofs(1), 575_000);

        vm.prank(SELLER);
        vault.claim(id, 0);
        assertEq(usdce.balanceOf(SELLER), 575_000);
        assertEq(vault.reservedUsdc(), 0);
    }

    function test_underfundedAllocationCannotSettle() public {
        uint256 id = vault.openBatch(MARKET, YES, NO);
        _buy(id, SettlementAccounting.Side.YES_BUY, 400_000, bytes32(uint256(3)));
        _close(id);
        vault.routeAssets(id, 400_000, 0, 0);
        ctf.mint(WALLET, YES, 900_000);
        vm.prank(WALLET);
        ctf.safeTransferFrom(WALLET, address(vault), YES, 900_000, "");

        SettlementAccounting.Allocation[] memory allocations = new SettlementAccounting.Allocation[](1);
        allocations[0] = SettlementAccounting.Allocation(
            SettlementAccounting.Side.YES_BUY, 400_000, 0, 1_000_000, 400_000, 0
        );
        vm.expectRevert(abi.encodeWithSelector(SettlementAccounting.AssetMismatch.selector, uint8(1)));
        vault.finalize(id, allocations, _proofs(1), 0);
        assertEq(uint256(_status(id)), uint256(BatchVaultV11.Status.ROUTED));
    }

    function test_expiredUnroutedBatchRefundsSeller() public {
        uint256 id = vault.openBatch(MARKET, YES, NO);
        _sell(id, SettlementAccounting.Side.NO_SELL, 1_000_000, bytes32(uint256(4)));
        vm.warp(block.timestamp + vault.BATCH_WINDOW() + vault.RESCUE_DELAY());
        vault.abortUnrouted(id);
        vm.prank(SELLER);
        vault.claim(id, 0);
        assertEq(ctf.balanceOf(SELLER, NO), 1_000_000);
        assertEq(vault.reservedTokens(NO), 0);
    }

    function test_routedBatchCannotAutoRefund() public {
        uint256 id = vault.openBatch(MARKET, YES, NO);
        _buy(id, SettlementAccounting.Side.YES_BUY, 400_000, bytes32(uint256(5)));
        _close(id);
        vault.routeAssets(id, 400_000, 0, 0);
        vm.warp(block.timestamp + vault.RESCUE_DELAY());
        vm.expectRevert(BatchVaultV11.InvalidStatus.selector);
        vault.abortUnrouted(id);
    }

    function test_onlyOwnerCanClaimAndOnlyOnce() public {
        uint256 id = vault.openBatch(MARKET, YES, NO);
        _buy(id, SettlementAccounting.Side.YES_BUY, 400_000, bytes32(uint256(6)));
        vm.warp(block.timestamp + vault.BATCH_WINDOW() + vault.RESCUE_DELAY());
        vault.abortUnrouted(id);
        vm.prank(SELLER);
        vm.expectRevert(BatchVaultV11.NotOwner.selector);
        vault.claim(id, 0);
        vm.prank(BUYER);
        vault.claim(id, 0);
        vm.prank(BUYER);
        vm.expectRevert(BatchVaultV11.AlreadyClaimed.selector);
        vault.claim(id, 0);
    }

    function test_invalidInitialProofCannotEscrow() public {
        uint256 id = vault.openBatch(MARKET, YES, NO);
        verifier.setValid(false);
        usdce.mint(BUYER, 400_000);
        vm.startPrank(BUYER);
        usdce.approve(address(vault), 400_000);
        vm.expectRevert(BatchVaultV11.ProofInvalid.selector);
        vault.commitBuy(id, bytes32(uint256(7)), SettlementAccounting.Side.YES_BUY, 400_000, hex"01");
        vm.stopPrank();
        assertEq(usdce.balanceOf(BUYER), 400_000);
    }

    function test_unboundPublicLimitCannotBePresentedAsUserLimit() public {
        uint256 id = vault.openBatch(MARKET, YES, NO);
        _buy(id, SettlementAccounting.Side.NO_BUY, 400_000, bytes32(uint256(8)));
        _close(id);
        vault.routeAssets(id, 0, 0, 0);
        SettlementAccounting.Allocation[] memory proposed = new SettlementAccounting.Allocation[](1);
        proposed[0] = SettlementAccounting.Allocation(
            SettlementAccounting.Side.NO_BUY, 400_000, 999_999, 0, 0, 400_000
        );
        vm.expectRevert(BatchVaultV11.InvalidOrder.selector);
        vault.finalize(id, proposed, _proofs(1), 0);
    }

    function test_guardianPauseBlocksNewRoutingButAllowsRecoveryAndClaims() public {
        uint256 id = vault.openBatch(MARKET, YES, NO);
        _buy(id, SettlementAccounting.Side.YES_BUY, 400_000, bytes32(uint256(9)));
        _close(id);
        vm.prank(GUARDIAN);
        vault.setTradingPaused(true);
        vm.expectRevert(BatchVaultV11.TradingPaused.selector);
        vault.routeAssets(id, 400_000, 0, 0);
        vm.expectRevert(BatchVaultV11.TradingPaused.selector);
        vault.openBatch(bytes32(uint256(2)), YES, NO);
        vm.warp(block.timestamp + vault.RESCUE_DELAY());
        vault.abortUnrouted(id);
        vm.prank(BUYER);
        vault.claim(id, 0);
        assertEq(usdce.balanceOf(BUYER), 400_000);
        vm.prank(BUYER);
        vm.expectRevert(BatchVaultV11.OnlyGuardian.selector);
        vault.setTradingPaused(false);
    }

    function test_guardianCanFinalizeReturnedAssetsWhilePaused() public {
        uint256 id = vault.openBatch(MARKET, YES, NO);
        _buy(id, SettlementAccounting.Side.YES_BUY, 400_000, bytes32(uint256(13)));
        _close(id);
        vault.routeAssets(id, 0, 0, 0);
        vm.prank(GUARDIAN);
        vault.setTradingPaused(true);
        SettlementAccounting.Allocation[] memory proposed = new SettlementAccounting.Allocation[](1);
        proposed[0] = SettlementAccounting.Allocation(
            SettlementAccounting.Side.YES_BUY, 400_000, 0, 0, 0, 400_000
        );
        vm.prank(GUARDIAN);
        vault.finalize(id, proposed, _proofs(1), 0);
        vm.prank(BUYER);
        vault.claim(id, 0);
        assertEq(usdce.balanceOf(BUYER), 400_000);
    }

    function test_unsolicitedCtfTransferCannotContaminateBatchBalance() public {
        ctf.mint(SELLER, YES, 1_000_000);
        vm.prank(SELLER);
        vm.expectRevert(BatchVaultV11.InvalidAsset.selector);
        ctf.safeTransferFrom(SELLER, address(vault), YES, 1_000_000, "");
        assertEq(ctf.balanceOf(address(vault), YES), 0);
    }

    function test_ownerCanClaimToAnotherRecipientOnlyOnce() public {
        uint256 id = vault.openBatch(MARKET, YES, NO);
        _buy(id, SettlementAccounting.Side.NO_BUY, 400_000, bytes32(uint256(14)));
        vm.warp(block.timestamp + vault.BATCH_WINDOW() + vault.RESCUE_DELAY());
        vault.abortUnrouted(id);
        vm.prank(SELLER);
        vm.expectRevert(BatchVaultV11.NotOwner.selector);
        vault.claimTo(id, 0, SELLER);
        vm.prank(BUYER);
        vault.claimTo(id, 0, SELLER);
        assertEq(usdce.balanceOf(SELLER), 400_000);
        vm.prank(BUYER);
        vm.expectRevert(BatchVaultV11.AlreadyClaimed.selector);
        vault.claim(id, 0);
    }

    function test_laterBatchCannotConsumeEarlierUnclaimedAssets() public {
        uint256 first = vault.openBatch(MARKET, YES, NO);
        _buy(first, SettlementAccounting.Side.YES_BUY, 600_000, bytes32(uint256(10)));
        _sell(first, SettlementAccounting.Side.YES_SELL, 1_000_000, bytes32(uint256(11)));
        _close(first);
        vault.routeAssets(first, 0, 0, 0);
        SettlementAccounting.Allocation[] memory firstAllocations = new SettlementAccounting.Allocation[](2);
        firstAllocations[0] = SettlementAccounting.Allocation(
            SettlementAccounting.Side.YES_BUY, 600_000, 0, 1_000_000, 600_000, 0
        );
        firstAllocations[1] = SettlementAccounting.Allocation(
            SettlementAccounting.Side.YES_SELL, 1_000_000, 0, 1_000_000, 600_000, 0
        );
        vault.finalize(first, firstAllocations, _proofs(2), 0);
        assertEq(vault.reservedUsdc(), 600_000);
        assertEq(vault.reservedTokens(YES), 1_000_000);

        uint256 second = vault.openBatch(MARKET, YES, NO);
        _buy(second, SettlementAccounting.Side.NO_BUY, 400_000, bytes32(uint256(12)));
        _close(second);
        vm.expectRevert(BatchVaultV11.InsufficientAssets.selector);
        vault.routeAssets(second, 600_000, 0, 0);
        vault.routeAssets(second, 400_000, 0, 0);
        ctf.mint(WALLET, NO, 1_000_000);
        vm.prank(WALLET);
        ctf.safeTransferFrom(WALLET, address(vault), NO, 1_000_000, "");
        SettlementAccounting.Allocation[] memory secondAllocations = new SettlementAccounting.Allocation[](1);
        secondAllocations[0] = SettlementAccounting.Allocation(
            SettlementAccounting.Side.NO_BUY, 400_000, 0, 1_000_000, 400_000, 0
        );
        vault.finalize(second, secondAllocations, _proofs(1), 0);

        vm.prank(BUYER);
        vault.claim(second, 0);
        vm.prank(SELLER);
        vault.claim(first, 1);
        vm.prank(BUYER);
        vault.claim(first, 0);
        assertEq(ctf.balanceOf(BUYER, NO), 1_000_000);
        assertEq(ctf.balanceOf(BUYER, YES), 1_000_000);
        assertEq(usdce.balanceOf(SELLER), 600_000);
        assertEq(vault.reservedUsdc(), 0);
        assertEq(vault.reservedTokens(YES), 0);
        assertEq(vault.reservedTokens(NO), 0);
    }

    function _buy(uint256 id, SettlementAccounting.Side side, uint256 amount, bytes32 commitment) private {
        usdce.mint(BUYER, amount);
        vm.startPrank(BUYER);
        usdce.approve(address(vault), amount);
        vault.commitBuy(id, commitment, side, amount, hex"01");
        vm.stopPrank();
    }

    function _sell(uint256 id, SettlementAccounting.Side side, uint256 amount, bytes32 commitment) private {
        uint256 tokenId = side == SettlementAccounting.Side.YES_SELL ? YES : NO;
        ctf.mint(SELLER, tokenId, amount);
        vm.startPrank(SELLER);
        ctf.setApprovalForAll(address(vault), true);
        vault.commitSell(id, commitment, side, amount, hex"01");
        vm.stopPrank();
    }

    function _close(uint256 id) private {
        vm.warp(block.timestamp + vault.BATCH_WINDOW());
        vault.closeBatch(id);
    }

    function _status(uint256 id) private view returns (BatchVaultV11.Status status) {
        (,,,,,,,,,,,, status) = vault.batches(id);
    }

    function _proofs(uint256 count) private pure returns (bytes[] memory proofs) {
        proofs = new bytes[](count);
        for (uint256 i = 0; i < count; i++) proofs[i] = hex"01";
    }
}
