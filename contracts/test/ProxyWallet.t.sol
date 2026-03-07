// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/ProxyWallet.sol";
import "../src/ProxyWalletFactory.sol";

// ── Minimal ERC-1155 mock for testing ────────────────────────────────────────

contract MockERC1155 {
    mapping(address => mapping(uint256 => uint256)) public balanceOf;

    function mint(address to, uint256 id, uint256 amount) external {
        balanceOf[to][id] += amount;
    }

    function safeTransferFrom(address from, address to, uint256 id, uint256 amount, bytes memory) external {
        require(balanceOf[from][id] >= amount, "MockERC1155: insufficient");
        balanceOf[from][id] -= amount;
        balanceOf[to][id]   += amount;
    }
}

// ── Minimal ERC-20 mock for testing ──────────────────────────────────────────

contract MockERC20 {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "MockERC20: insufficient");
        balanceOf[msg.sender] -= amount;
        balanceOf[to]         += amount;
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }
}

// ── Calldata builder helper ───────────────────────────────────────────────────

contract CallHelper {
    /// @dev Build ERC-20 approve calldata
    function approveData(address spender, uint256 amount) external pure returns (bytes memory) {
        return abi.encodeWithSignature("approve(address,uint256)", spender, amount);
    }

    /// @dev Build ERC-20 transfer calldata
    function transferData(address to, uint256 amount) external pure returns (bytes memory) {
        return abi.encodeWithSignature("transfer(address,uint256)", to, amount);
    }
}

// ── Main test suite ───────────────────────────────────────────────────────────

contract ProxyWalletTest is Test {

    ProxyWalletFactory factory;
    CallHelper          helper;
    MockERC20           usdc;
    MockERC1155         ctf;

    uint256 ownerKey   = 0xA11CE;
    address ownerAddr;
    ProxyWallet wallet;

    function setUp() public {
        factory   = new ProxyWalletFactory();
        helper    = new CallHelper();
        usdc      = new MockERC20();
        ctf       = new MockERC1155();

        ownerAddr = vm.addr(ownerKey);
        wallet    = ProxyWallet(payable(factory.deploy(ownerAddr)));
    }

    // ── Factory ───────────────────────────────────────────────────────────────

    function test_factory_storesWalletOf() public view {
        assertEq(factory.walletOf(ownerAddr), address(wallet));
    }

    function test_factory_revertsDoubleDeply() public {
        vm.expectRevert(ProxyWalletFactory.AlreadyDeployed.selector);
        factory.deploy(ownerAddr);
    }

    function test_factory_computeAddress_matchesDeployed() public view {
        address predicted = factory.computeAddress(ownerAddr);
        assertEq(predicted, address(wallet));
    }

    function test_factory_computeAddress_beforeDeploy() public {
        address newOwner = vm.addr(0xBEEF);
        address predicted = factory.computeAddress(newOwner);
        // Not yet deployed
        assertEq(factory.walletOf(newOwner), address(0));

        // Deploy and verify
        address deployed = factory.deploy(newOwner);
        assertEq(deployed, predicted);
    }

    function test_factory_differentOwners_differentAddresses() public {
        address ownerA = vm.addr(0xAAAA);
        address ownerB = vm.addr(0xBBBB);
        address a = factory.computeAddress(ownerA);
        address b = factory.computeAddress(ownerB);
        assertTrue(a != b);
    }

    // ── Immutables ────────────────────────────────────────────────────────────

    function test_wallet_immutables() public view {
        assertEq(wallet.owner(),   ownerAddr);
        assertEq(wallet.factory(), address(factory));
        assertEq(wallet.nonce(),   0);
    }

    // ── EIP-1271 ──────────────────────────────────────────────────────────────

    function test_eip1271_validSignature() public view {
        bytes32 hash = keccak256("CLOB order hash");
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerKey, hash);
        bytes memory sig = abi.encodePacked(r, s, v);

        bytes4 result = wallet.isValidSignature(hash, sig);
        assertEq(result, bytes4(0x1626ba7e));
    }

    function test_eip1271_invalidSignature_wrongKey() public view {
        bytes32 hash = keccak256("CLOB order hash");
        // Sign with a different key
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(0xDEAD, hash);
        bytes memory sig = abi.encodePacked(r, s, v);

        bytes4 result = wallet.isValidSignature(hash, sig);
        assertEq(result, bytes4(0xffffffff));
    }

    function test_eip1271_invalidSignature_wrongLength() public view {
        bytes32 hash = keccak256("CLOB order hash");
        bytes memory sig = new bytes(64); // wrong length
        bytes4 result = wallet.isValidSignature(hash, sig);
        assertEq(result, bytes4(0xffffffff));
    }

    // ── Direct Execute (owner-only) ───────────────────────────────────────────

    function test_execute_ownerCanCall() public {
        usdc.mint(address(wallet), 1000e6);

        bytes memory data = helper.transferData(address(this), 500e6);

        vm.prank(ownerAddr);
        wallet.execute(address(usdc), 0, data);

        assertEq(usdc.balanceOf(address(this)), 500e6);
        assertEq(usdc.balanceOf(address(wallet)), 500e6);
    }

    function test_execute_revertsIfNotOwner() public {
        bytes memory data = helper.transferData(address(this), 1e6);
        vm.prank(address(0xBEEF));
        vm.expectRevert(ProxyWallet.OnlyOwner.selector);
        wallet.execute(address(usdc), 0, data);
    }

    function test_execute_revertsOnCallFailure() public {
        // Transfer with zero balance → inner call reverts, ProxyWallet wraps in CallFailed
        bytes memory data = helper.transferData(address(this), 1e6);
        vm.prank(ownerAddr);
        // Encode the inner revert reason (MockERC20: insufficient) as the CallFailed payload
        bytes memory innerRevert = abi.encodeWithSignature("Error(string)", "MockERC20: insufficient");
        vm.expectRevert(abi.encodeWithSelector(ProxyWallet.CallFailed.selector, innerRevert));
        wallet.execute(address(usdc), 0, data);
    }

    // ── Meta-Transaction Execute ──────────────────────────────────────────────

    function _signMetaTx(
        uint256 _nonce,
        address to,
        uint256 value,
        bytes memory data,
        uint256 key
    ) internal view returns (bytes memory sig) {
        // Must match ProxyWallet._metaTxDigest
        bytes32 digest = keccak256(abi.encode(
            _nonce,
            block.chainid,
            address(wallet),
            to,
            value,
            keccak256(data)
        ));
        // Must match ProxyWallet._recoverEthSign
        bytes32 prefixed = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", digest));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, prefixed);
        sig = abi.encodePacked(r, s, v);
    }

    function test_executeWithSig_relayerSubmits() public {
        usdc.mint(address(wallet), 1000e6);

        bytes memory data = helper.transferData(address(this), 300e6);
        bytes memory sig  = _signMetaTx(0, address(usdc), 0, data, ownerKey);

        address relayer = vm.addr(0xBEEF); // relayer pays gas
        vm.prank(relayer);
        wallet.executeWithSig(address(usdc), 0, data, sig);

        assertEq(usdc.balanceOf(address(this)), 300e6);
        assertEq(wallet.nonce(), 1);
    }

    function test_executeWithSig_nonceIncrements() public {
        usdc.mint(address(wallet), 1000e6);

        bytes memory data1 = helper.transferData(address(this), 100e6);
        bytes memory data2 = helper.transferData(address(this), 200e6);

        bytes memory sig1 = _signMetaTx(0, address(usdc), 0, data1, ownerKey);
        bytes memory sig2 = _signMetaTx(1, address(usdc), 0, data2, ownerKey);

        wallet.executeWithSig(address(usdc), 0, data1, sig1);
        wallet.executeWithSig(address(usdc), 0, data2, sig2);

        assertEq(usdc.balanceOf(address(this)), 300e6);
        assertEq(wallet.nonce(), 2);
    }

    function test_executeWithSig_replayReverts() public {
        usdc.mint(address(wallet), 1000e6);

        bytes memory data = helper.transferData(address(this), 100e6);
        bytes memory sig  = _signMetaTx(0, address(usdc), 0, data, ownerKey);

        wallet.executeWithSig(address(usdc), 0, data, sig);

        // Replay: nonce now 1, sig was for nonce 0 → invalid sig → revert
        vm.expectRevert(ProxyWallet.InvalidSignature.selector);
        wallet.executeWithSig(address(usdc), 0, data, sig);
    }

    function test_executeWithSig_wrongKeReverts() public {
        bytes memory data = helper.transferData(address(this), 100e6);
        bytes memory sig  = _signMetaTx(0, address(usdc), 0, data, 0xDEAD); // wrong key

        vm.expectRevert(ProxyWallet.InvalidSignature.selector);
        wallet.executeWithSig(address(usdc), 0, data, sig);
    }

    // ── Batch Meta-Transaction ────────────────────────────────────────────────

    function _signBatchMetaTx(
        uint256 _nonce,
        address[] memory targets,
        uint256[] memory values,
        bytes[] memory payloads,
        uint256 key
    ) internal view returns (bytes memory sig) {
        // Mirror _batchMetaTxDigest + _hashBytesArray
        bytes32[] memory hashes = new bytes32[](payloads.length);
        for (uint256 i = 0; i < payloads.length; i++) {
            hashes[i] = keccak256(payloads[i]);
        }
        bytes32 payloadsHash = keccak256(abi.encodePacked(hashes));

        bytes32 digest = keccak256(abi.encode(
            _nonce,
            block.chainid,
            address(wallet),
            targets,
            values,
            payloadsHash
        ));
        bytes32 prefixed = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", digest));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, prefixed);
        sig = abi.encodePacked(r, s, v);
    }

    function test_batchExecuteWithSig_multipleCallsOneSig() public {
        usdc.mint(address(wallet), 1000e6);
        address recipient1 = vm.addr(0x111);
        address recipient2 = vm.addr(0x222);

        address[] memory targets = new address[](2);
        targets[0] = address(usdc);
        targets[1] = address(usdc);

        uint256[] memory values = new uint256[](2);
        // both 0

        bytes[] memory payloads = new bytes[](2);
        payloads[0] = helper.transferData(recipient1, 100e6);
        payloads[1] = helper.transferData(recipient2, 200e6);

        bytes memory sig = _signBatchMetaTx(0, targets, values, payloads, ownerKey);

        wallet.batchExecuteWithSig(targets, values, payloads, sig);

        assertEq(usdc.balanceOf(recipient1), 100e6);
        assertEq(usdc.balanceOf(recipient2), 200e6);
        assertEq(wallet.nonce(), 1);
    }

    // ── ERC-1155 Receiver ─────────────────────────────────────────────────────

    function test_erc1155Received_acceptsTokens() public {
        ctf.mint(address(wallet), 1, 500);
        assertEq(ctf.balanceOf(address(wallet), 1), 500);
    }

    function test_supportsInterface_erc1155Receiver() public view {
        assertTrue(wallet.supportsInterface(0x4e2312e0));
    }

    function test_supportsInterface_erc165() public view {
        assertTrue(wallet.supportsInterface(0x01ffc9a7));
    }

    // ── ETH receive ───────────────────────────────────────────────────────────

    function test_receivesETH() public {
        vm.deal(address(this), 1 ether);
        (bool ok,) = address(wallet).call{value: 0.1 ether}("");
        assertTrue(ok);
        assertEq(address(wallet).balance, 0.1 ether);
    }
}
