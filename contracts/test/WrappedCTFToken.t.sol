// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/WrappedCTFToken.sol";
import "../src/WrappedCTFFactory.sol";

// ── Minimal CTF (ERC-1155) mock ───────────────────────────────────────────────

contract MockCTF1155 {
    mapping(address => mapping(uint256 => uint256)) public balanceOf;
    mapping(address => mapping(address => bool))    public isApprovedForAll;

    function mint(address to, uint256 id, uint256 amount) external {
        balanceOf[to][id] += amount;
    }

    function setApprovalForAll(address operator, bool approved) external {
        isApprovedForAll[msg.sender][operator] = approved;
    }

    function safeTransferFrom(
        address from,
        address to,
        uint256 id,
        uint256 amount,
        bytes memory
    ) external {
        require(
            from == msg.sender || isApprovedForAll[from][msg.sender],
            "MockCTF1155: not approved"
        );
        require(balanceOf[from][id] >= amount, "MockCTF1155: insufficient");
        balanceOf[from][id] -= amount;
        balanceOf[to][id]   += amount;

        // ERC-1155 receiver callback
        if (to.code.length > 0) {
            bytes4 retval = IERC1155Receiver(to).onERC1155Received(
                msg.sender, from, id, amount, ""
            );
            require(retval == 0xf23a6e61, "MockCTF1155: bad receiver");
        }
    }
}

interface IERC1155Receiver {
    function onERC1155Received(address, address, uint256, uint256, bytes calldata)
        external returns (bytes4);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

contract WrappedCTFTokenTest is Test {

    MockCTF1155     ctf;
    WrappedCTFToken wYES;
    WrappedCTFFactory factory;

    uint256 constant YES_ID  = 12345;
    uint256 constant NO_ID   = 67890;
    address alice = vm.addr(1);
    address bob   = vm.addr(2);
    address relayer = vm.addr(3);

    function setUp() public {
        ctf     = new MockCTF1155();
        wYES    = new WrappedCTFToken(address(ctf), YES_ID, "Wrapped YES", "wYES");
        factory = new WrappedCTFFactory();

        // Give alice some YES tokens
        ctf.mint(alice, YES_ID, 1000e6);

        // Alice approves wYES to pull her ERC-1155
        vm.prank(alice);
        ctf.setApprovalForAll(address(wYES), true);
    }

    // ── Wrap ──────────────────────────────────────────────────────────────────

    function test_wrap_mintsERC20() public {
        vm.prank(alice);
        wYES.wrap(500e6);

        assertEq(wYES.balanceOf(alice), 500e6);
        assertEq(wYES.totalSupply(),    500e6);
        assertEq(ctf.balanceOf(alice, YES_ID),        500e6);
        assertEq(ctf.balanceOf(address(wYES), YES_ID), 500e6);
    }

    function test_wrap_fullAmount() public {
        vm.prank(alice);
        wYES.wrap(1000e6);

        assertEq(wYES.balanceOf(alice), 1000e6);
        assertEq(ctf.balanceOf(alice, YES_ID), 0);
    }

    function test_wrapFor_mintToRecipient() public {
        vm.prank(alice);
        wYES.wrapFor(alice, bob, 300e6);

        assertEq(wYES.balanceOf(alice), 0);     // alice gets no ERC-20
        assertEq(wYES.balanceOf(bob),   300e6); // bob gets ERC-20
        assertEq(ctf.balanceOf(alice, YES_ID), 700e6);
    }

    // ── Unwrap ────────────────────────────────────────────────────────────────

    function test_unwrap_returnsERC1155() public {
        vm.prank(alice);
        wYES.wrap(500e6);

        vm.prank(alice);
        wYES.unwrap(200e6);

        assertEq(wYES.balanceOf(alice), 300e6);
        assertEq(wYES.totalSupply(),    300e6);
        assertEq(ctf.balanceOf(alice, YES_ID), 700e6);
    }

    function test_unwrapFor_withAllowance() public {
        vm.prank(alice);
        wYES.wrap(500e6);

        vm.prank(alice);
        wYES.approve(relayer, 200e6);

        vm.prank(relayer);
        wYES.unwrapFor(alice, bob, 200e6);

        assertEq(wYES.balanceOf(alice),         300e6);
        assertEq(ctf.balanceOf(bob, YES_ID),    200e6);
        assertEq(wYES.allowance(alice, relayer), 0);
    }

    function test_unwrapFor_revertsWithoutAllowance() public {
        vm.prank(alice);
        wYES.wrap(500e6);

        vm.prank(relayer);
        vm.expectRevert(WrappedCTFToken.InsufficientAllowance.selector);
        wYES.unwrapFor(alice, bob, 200e6);
    }

    function test_unwrap_revertsInsufficientBalance() public {
        vm.prank(alice);
        vm.expectRevert(WrappedCTFToken.InsufficientBalance.selector);
        wYES.unwrap(100e6); // never wrapped
    }

    // ── ERC-20 ────────────────────────────────────────────────────────────────

    function test_transfer() public {
        vm.prank(alice);
        wYES.wrap(1000e6);

        vm.prank(alice);
        wYES.transfer(bob, 400e6);

        assertEq(wYES.balanceOf(alice), 600e6);
        assertEq(wYES.balanceOf(bob),   400e6);
    }

    function test_transfer_revertsInsufficientBalance() public {
        vm.prank(alice);
        vm.expectRevert(WrappedCTFToken.InsufficientBalance.selector);
        wYES.transfer(bob, 100e6);
    }

    function test_approve_and_transferFrom() public {
        vm.prank(alice);
        wYES.wrap(1000e6);

        vm.prank(alice);
        wYES.approve(relayer, 500e6);

        vm.prank(relayer);
        wYES.transferFrom(alice, bob, 300e6);

        assertEq(wYES.balanceOf(alice),          700e6);
        assertEq(wYES.balanceOf(bob),            300e6);
        assertEq(wYES.allowance(alice, relayer), 200e6); // decremented
    }

    function test_transferFrom_maxAllowanceNotDecremented() public {
        vm.prank(alice);
        wYES.wrap(1000e6);

        vm.prank(alice);
        wYES.approve(relayer, type(uint256).max);

        vm.prank(relayer);
        wYES.transferFrom(alice, bob, 500e6);

        assertEq(wYES.allowance(alice, relayer), type(uint256).max); // unchanged
    }

    function test_transferFrom_revertsInsufficientAllowance() public {
        vm.prank(alice);
        wYES.wrap(1000e6);

        vm.prank(relayer);
        vm.expectRevert(WrappedCTFToken.InsufficientAllowance.selector);
        wYES.transferFrom(alice, bob, 100e6);
    }

    // ── EIP-2612 Permit ───────────────────────────────────────────────────────

    function test_permit_allowsGaslessApproval() public {
        uint256 aliceKey  = 1;
        address aliceAddr = vm.addr(aliceKey);

        uint256 deadline = block.timestamp + 1 hours;
        bytes32 structHash = keccak256(abi.encode(
            wYES.PERMIT_TYPEHASH(),
            aliceAddr,
            relayer,
            500e6,
            wYES.nonces(aliceAddr),
            deadline
        ));
        bytes32 digest = keccak256(abi.encodePacked(
            "\x19\x01",
            wYES.DOMAIN_SEPARATOR(),
            structHash
        ));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(aliceKey, digest);

        wYES.permit(aliceAddr, relayer, 500e6, deadline, v, r, s);
        assertEq(wYES.allowance(aliceAddr, relayer), 500e6);
    }

    function test_permit_revertsExpired() public {
        vm.warp(block.timestamp + 2 hours);
        uint256 deadline = block.timestamp - 1 hours;

        vm.expectRevert(WrappedCTFToken.PermitExpired.selector);
        wYES.permit(alice, relayer, 100e6, deadline, 0, bytes32(0), bytes32(0));
    }

    function test_permit_revertsInvalidSignature() public {
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(999, bytes32(0));

        vm.expectRevert(WrappedCTFToken.InvalidPermitSignature.selector);
        wYES.permit(alice, relayer, 100e6, deadline, v, r, s);
    }

    // ── ERC-1155 Receiver ─────────────────────────────────────────────────────

    function test_supportsInterface_erc1155Receiver() public view {
        assertTrue(wYES.supportsInterface(0x4e2312e0));
    }

    function test_supportsInterface_erc165() public view {
        assertTrue(wYES.supportsInterface(0x01ffc9a7));
    }

    // ── Factory ───────────────────────────────────────────────────────────────

    function test_factory_deploy() public {
        address wrapper = factory.deploy(address(ctf), YES_ID, "Wrapped YES", "wYES");
        assertEq(factory.wrapperOf(address(ctf), YES_ID), wrapper);
    }

    function test_factory_revertsDoubleDeployment() public {
        factory.deploy(address(ctf), YES_ID, "Wrapped YES", "wYES");
        vm.expectRevert(WrappedCTFFactory.AlreadyDeployed.selector);
        factory.deploy(address(ctf), YES_ID, "Wrapped YES 2", "wYES2");
    }

    function test_factory_computeAddress_matchesDeploy() public {
        address predicted = factory.computeAddress(address(ctf), YES_ID, "Wrapped YES", "wYES");
        address deployed  = factory.deploy(address(ctf), YES_ID, "Wrapped YES", "wYES");
        assertEq(predicted, deployed);
    }

    function test_factory_differentPositions_differentAddresses() public {
        address a = factory.computeAddress(address(ctf), YES_ID, "Wrapped YES", "wYES");
        address b = factory.computeAddress(address(ctf), NO_ID,  "Wrapped NO",  "wNO");
        assertTrue(a != b);
    }

    function test_factory_deployedWrapper_worksForWrapUnwrap() public {
        address wrapper = factory.deploy(address(ctf), YES_ID, "Wrapped YES", "wYES");
        WrappedCTFToken w = WrappedCTFToken(wrapper);

        vm.prank(alice);
        ctf.setApprovalForAll(wrapper, true);

        vm.prank(alice);
        w.wrap(100e6);

        assertEq(w.balanceOf(alice), 100e6);

        vm.prank(alice);
        w.unwrap(50e6);

        assertEq(w.balanceOf(alice),            50e6);
        assertEq(ctf.balanceOf(alice, YES_ID), 950e6);
    }
}
