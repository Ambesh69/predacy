// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/PolymarketCollateralBridge.sol";

contract BridgeToken is IBridgeERC20 {
    mapping(address => uint256) public override balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external { balanceOf[to] += amount; }
    function approve(address spender, uint256 amount) external override returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }
    function transferFrom(address from, address to, uint256 amount) external {
        require(allowance[from][msg.sender] >= amount, "allowance");
        require(balanceOf[from] >= amount, "balance");
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
    }
    function burnFrom(address from, uint256 amount) external {
        require(allowance[from][msg.sender] >= amount, "allowance");
        require(balanceOf[from] >= amount, "balance");
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
    }
}

contract MockOnramp is ICollateralOnramp {
    BridgeToken public immutable usdce;
    BridgeToken public immutable pusd;
    bool public shortMint;

    constructor(BridgeToken usdce_, BridgeToken pusd_) { usdce = usdce_; pusd = pusd_; }
    function setShortMint(bool value) external { shortMint = value; }
    function wrap(address asset, address to, uint256 amount) external {
        require(asset == address(usdce), "asset");
        usdce.transferFrom(msg.sender, address(this), amount);
        pusd.mint(to, shortMint ? amount - 1 : amount);
    }
}

contract MockOfframp is ICollateralOfframp {
    BridgeToken public immutable usdce;
    BridgeToken public immutable pusd;
    bool public shortRedeem;

    constructor(BridgeToken usdce_, BridgeToken pusd_) { usdce = usdce_; pusd = pusd_; }
    function setShortRedeem(bool value) external { shortRedeem = value; }
    function unwrap(address asset, address to, uint256 amount) external {
        require(asset == address(usdce), "asset");
        pusd.burnFrom(msg.sender, amount);
        usdce.mint(to, shortRedeem ? amount - 1 : amount);
    }
}

contract BridgeHarness {
    function wrap(BridgeToken usdce, BridgeToken pusd, MockOnramp onramp, address wallet, uint256 amount) external {
        PolymarketCollateralBridge.wrapToDepositWallet(usdce, pusd, onramp, wallet, amount);
    }
    function unwrap(BridgeToken usdce, BridgeToken pusd, MockOfframp offramp, uint256 amount) external {
        PolymarketCollateralBridge.unwrapToVault(usdce, pusd, offramp, amount);
    }
}

contract PolymarketCollateralBridgeTest is Test {
    BridgeToken usdce;
    BridgeToken pusd;
    MockOnramp onramp;
    MockOfframp offramp;
    BridgeHarness vault;
    address constant DEPOSIT_WALLET = address(0x1234);

    function setUp() public {
        usdce = new BridgeToken();
        pusd = new BridgeToken();
        onramp = new MockOnramp(usdce, pusd);
        offramp = new MockOfframp(usdce, pusd);
        vault = new BridgeHarness();
    }

    function test_wrapToDepositWalletTracksExactBalances() public {
        usdce.mint(address(vault), 2_000_000);
        vault.wrap(usdce, pusd, onramp, DEPOSIT_WALLET, 1_000_000);
        assertEq(usdce.balanceOf(address(vault)), 1_000_000);
        assertEq(pusd.balanceOf(DEPOSIT_WALLET), 1_000_000);
        assertEq(usdce.allowance(address(vault), address(onramp)), 0);
    }

    function test_unwrapReturnedPusdTracksExactBalances() public {
        pusd.mint(address(vault), 800_000);
        vault.unwrap(usdce, pusd, offramp, 800_000);
        assertEq(pusd.balanceOf(address(vault)), 0);
        assertEq(usdce.balanceOf(address(vault)), 800_000);
        assertEq(pusd.allowance(address(vault), address(offramp)), 0);
    }

    function test_rejectsShortMintAndRevertsEntireWrap() public {
        usdce.mint(address(vault), 1_000_000);
        onramp.setShortMint(true);
        vm.expectRevert(PolymarketCollateralBridge.IncorrectBalanceDelta.selector);
        vault.wrap(usdce, pusd, onramp, DEPOSIT_WALLET, 1_000_000);
        assertEq(usdce.balanceOf(address(vault)), 1_000_000);
        assertEq(pusd.balanceOf(DEPOSIT_WALLET), 0);
    }

    function test_rejectsShortRedeemAndRevertsEntireUnwrap() public {
        pusd.mint(address(vault), 1_000_000);
        offramp.setShortRedeem(true);
        vm.expectRevert(PolymarketCollateralBridge.IncorrectBalanceDelta.selector);
        vault.unwrap(usdce, pusd, offramp, 1_000_000);
        assertEq(pusd.balanceOf(address(vault)), 1_000_000);
        assertEq(usdce.balanceOf(address(vault)), 0);
    }

    function test_rejectsZeroAmountAndWallet() public {
        vm.expectRevert(PolymarketCollateralBridge.ZeroAmount.selector);
        vault.wrap(usdce, pusd, onramp, DEPOSIT_WALLET, 0);
        vm.expectRevert(PolymarketCollateralBridge.ZeroWallet.selector);
        vault.wrap(usdce, pusd, onramp, address(0), 1);
    }
}

interface ITransferToken {
    function transfer(address to, uint256 amount) external returns (bool);
}

contract LiveBridgeHarness {
    function wrap(address usdce, address pusd, address onramp, address wallet, uint256 amount) external {
        PolymarketCollateralBridge.wrapToDepositWallet(
            IBridgeERC20(usdce), IBridgeERC20(pusd), ICollateralOnramp(onramp), wallet, amount
        );
    }
    function unwrap(address usdce, address pusd, address offramp, uint256 amount) external {
        PolymarketCollateralBridge.unwrapToVault(
            IBridgeERC20(usdce), IBridgeERC20(pusd), ICollateralOfframp(offramp), amount
        );
    }
}

contract PolymarketCollateralBridgeForkTest is Test {
    address constant USDCE = 0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174;
    address constant PUSD = 0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB;
    address constant ONRAMP = 0x93070a847efEf7F70739046A929D47a521F5B8ee;
    address constant OFFRAMP = 0x2957922Eb93258b93368531d39fAcCA3B4dC5854;
    address constant DEPOSIT_WALLET = address(0xBEEF);

    function test_wrapAndUnwrapOnPolygonFork() public {
        if (ONRAMP.code.length == 0 || OFFRAMP.code.length == 0) vm.skip(true);

        LiveBridgeHarness vault = new LiveBridgeHarness();
        deal(USDCE, address(vault), 1_000_000, true);
        uint256 walletBefore = IBridgeERC20(PUSD).balanceOf(DEPOSIT_WALLET);
        vault.wrap(USDCE, PUSD, ONRAMP, DEPOSIT_WALLET, 1_000_000);
        assertEq(IBridgeERC20(PUSD).balanceOf(DEPOSIT_WALLET), walletBefore + 1_000_000);

        vm.prank(DEPOSIT_WALLET);
        assertTrue(ITransferToken(PUSD).transfer(address(vault), 1_000_000));
        vault.unwrap(USDCE, PUSD, OFFRAMP, 1_000_000);
        assertEq(IBridgeERC20(USDCE).balanceOf(address(vault)), 1_000_000);
    }
}
