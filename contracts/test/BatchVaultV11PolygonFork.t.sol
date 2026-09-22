// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import {BatchVaultV11, IVaultERC20, IAllocationVerifier} from "../src/BatchVaultV11.sol";
import {SettlementAccounting} from "../src/SettlementAccounting.sol";
import {IBridgeERC20, ICollateralOnramp, ICollateralOfframp} from "../src/PolymarketCollateralBridge.sol";
import {IConditionalTokens} from "../src/interfaces/IConditionalTokens.sol";
import {V11CTF, V11Verifier} from "./BatchVaultV11.t.sol";
import {LiveBridgeHarness, ITransferToken} from "./PolymarketCollateralBridge.t.sol";

contract BatchVaultV11PolygonForkTest is Test {
    address constant USDCE = 0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174;
    address constant PUSD = 0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB;
    address constant ONRAMP = 0x93070a847efEf7F70739046A929D47a521F5B8ee;
    address constant OFFRAMP = 0x2957922Eb93258b93368531d39fAcCA3B4dC5854;
    address constant WALLET = address(0xD0D0);
    address constant BUYER = address(0xA11CE);
    address constant SELLER = address(0xB0B);
    bytes32 constant MARKET = bytes32(uint256(1));
    uint256 constant YES = 11;
    uint256 constant NO = 12;

    function _vault(V11CTF ctf) internal returns (BatchVaultV11 vault) {
        vault = new BatchVaultV11(
            IVaultERC20(USDCE), IBridgeERC20(PUSD), ICollateralOnramp(ONRAMP), ICollateralOfframp(OFFRAMP),
            IConditionalTokens(address(ctf)), IAllocationVerifier(address(new V11Verifier())),
            address(this), address(this), WALLET
        );
        vault.setTradingPaused(false);
    }

    function _buy(BatchVaultV11 vault, uint256 id, uint256 amount) internal {
        deal(USDCE, BUYER, amount, true);
        vm.startPrank(BUYER);
        IVaultERC20(USDCE).approve(address(vault), amount);
        vault.commitBuy(id, bytes32(uint256(id)), SettlementAccounting.Side.NO_BUY, amount, hex"01");
        vm.stopPrank();
        vm.warp(block.timestamp + vault.BATCH_WINDOW());
        vault.closeBatch(id);
        vault.routeAssets(id, amount, 0, 0);
        assertEq(IBridgeERC20(PUSD).balanceOf(WALLET), amount);
    }

    function test_partialBuyWithRealPolygonPusdBridgeAndClaim() public {
        if (ONRAMP.code.length == 0 || OFFRAMP.code.length == 0) vm.skip(true);
        V11CTF ctf = new V11CTF();
        BatchVaultV11 vault = _vault(ctf);
        uint256 id = vault.openBatch(MARKET, YES, NO);
        _buy(vault, id, 410_000);

        vm.prank(WALLET);
        assertTrue(ITransferToken(PUSD).transfer(address(0xCAFE), 405_000));
        ctf.mint(WALLET, NO, 1_000_000);
        vm.prank(WALLET);
        assertTrue(ITransferToken(PUSD).transfer(address(vault), 5_000));
        vm.prank(WALLET);
        ctf.safeTransferFrom(WALLET, address(vault), NO, 1_000_000, "");

        SettlementAccounting.Allocation[] memory proposed = new SettlementAccounting.Allocation[](1);
        proposed[0] = SettlementAccounting.Allocation(
            SettlementAccounting.Side.NO_BUY, 410_000, 0, 1_000_000, 405_000, 5_000
        );
        bytes[] memory proofs = new bytes[](1);
        proofs[0] = hex"01";
        vault.finalize(id, proposed, proofs, 5_000);
        vm.prank(BUYER);
        vault.claim(id, 0);
        assertEq(IBridgeERC20(USDCE).balanceOf(BUYER), 5_000);
        assertEq(ctf.balanceOf(BUYER, NO), 1_000_000);
    }

    function test_rejectedBuyReturnsEntireEscrowOnPolygonFork() public {
        if (ONRAMP.code.length == 0 || OFFRAMP.code.length == 0) vm.skip(true);
        V11CTF ctf = new V11CTF();
        BatchVaultV11 vault = _vault(ctf);
        uint256 id = vault.openBatch(MARKET, YES, NO);
        _buy(vault, id, 410_000);
        vm.prank(WALLET);
        assertTrue(ITransferToken(PUSD).transfer(address(vault), 410_000));

        SettlementAccounting.Allocation[] memory proposed = new SettlementAccounting.Allocation[](1);
        proposed[0] = SettlementAccounting.Allocation(
            SettlementAccounting.Side.NO_BUY, 410_000, 0, 0, 0, 410_000
        );
        bytes[] memory proofs = new bytes[](1);
        proofs[0] = hex"01";
        vault.finalize(id, proposed, proofs, 410_000);
        vm.prank(BUYER);
        vault.claim(id, 0);
        assertEq(IBridgeERC20(USDCE).balanceOf(BUYER), 410_000);
    }

    function test_partialSellReturnsNetPusdAndUnsoldSharesOnPolygonFork() public {
        if (ONRAMP.code.length == 0 || OFFRAMP.code.length == 0) vm.skip(true);
        V11CTF ctf = new V11CTF();
        BatchVaultV11 vault = _vault(ctf);
        uint256 id = vault.openBatch(MARKET, YES, NO);
        ctf.mint(SELLER, YES, 1_000_000);
        vm.startPrank(SELLER);
        ctf.setApprovalForAll(address(vault), true);
        vault.commitSell(id, bytes32(uint256(id)), SettlementAccounting.Side.YES_SELL, 1_000_000, hex"01");
        vm.stopPrank();
        vm.warp(block.timestamp + vault.BATCH_WINDOW());
        vault.closeBatch(id);
        vault.routeAssets(id, 0, 1_000_000, 0);
        assertEq(ctf.balanceOf(WALLET, YES), 1_000_000);

        vm.prank(WALLET);
        ctf.safeTransferFrom(WALLET, address(0xCAFE), YES, 500_000, "");
        LiveBridgeHarness counterparty = new LiveBridgeHarness();
        deal(USDCE, address(counterparty), 300_000, true);
        counterparty.wrap(USDCE, PUSD, ONRAMP, WALLET, 300_000);
        vm.prank(WALLET);
        assertTrue(ITransferToken(PUSD).transfer(address(vault), 300_000));
        vm.prank(WALLET);
        ctf.safeTransferFrom(WALLET, address(vault), YES, 500_000, "");

        SettlementAccounting.Allocation[] memory proposed = new SettlementAccounting.Allocation[](1);
        proposed[0] = SettlementAccounting.Allocation(
            SettlementAccounting.Side.YES_SELL, 1_000_000, 0, 500_000, 300_000, 500_000
        );
        bytes[] memory proofs = new bytes[](1);
        proofs[0] = hex"01";
        vault.finalize(id, proposed, proofs, 300_000);
        vm.prank(SELLER);
        vault.claim(id, 0);
        assertEq(IBridgeERC20(USDCE).balanceOf(SELLER), 300_000);
        assertEq(ctf.balanceOf(SELLER, YES), 500_000);
    }
}
