// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import {BatchVaultV11, IAllocationVerifier} from "../src/BatchVaultV11.sol";
import {SettlementAccounting} from "../src/SettlementAccounting.sol";
import {IConditionalTokens} from "../src/interfaces/IConditionalTokens.sol";
import {V11Token, V11CTF, V11Onramp, V11Offramp} from "./BatchVaultV11.t.sol";

contract BatchVaultV11RealProofTest is Test {
    function test_realProofEscrowAndFinalization() public {
        string[] memory args = new string[](4);
        args[0] = "node";
        args[1] = "--import";
        args[2] = "../relayer/node_modules/tsx/dist/loader.mjs";
        args[3] = "../relayer/scripts/generateAllocationProof.ts";
        (bytes memory initialProof, bytes32[] memory inputs, bytes memory finalProof,) =
            abi.decode(vm.ffi(args), (bytes, bytes32[], bytes, bytes32[]));

        bytes32 market = bytes32((uint256(inputs[0]) << 128) | uint256(inputs[1]));
        bytes32 commitment = bytes32((uint256(inputs[2]) << 128) | uint256(inputs[3]));
        address buyer = address(0xA11CE);
        address wallet = address(0xD0D0);

        V11Token usdce = new V11Token();
        V11Token pusd = new V11Token();
        V11CTF ctf = new V11CTF();
        address libraryAddress = vm.deployCode("v11-verifier/out/Verifier.sol/ZKTranscriptLib.json");
        string[] memory linkArgs = new string[](5);
        linkArgs[0] = "node";
        linkArgs[1] = "--import";
        linkArgs[2] = "../relayer/node_modules/tsx/dist/loader.mjs";
        linkArgs[3] = "../relayer/scripts/linkAllocationVerifier.ts";
        linkArgs[4] = vm.toString(libraryAddress);
        bytes memory creationCode = abi.decode(vm.ffi(linkArgs), (bytes));
        address verifier;
        assembly { verifier := create(0, add(creationCode, 0x20), mload(creationCode)) }
        assertTrue(verifier != address(0));
        BatchVaultV11 vault = new BatchVaultV11(
            usdce, pusd, new V11Onramp(usdce, pusd), new V11Offramp(usdce, pusd),
            IConditionalTokens(address(ctf)), IAllocationVerifier(verifier), address(this), wallet
        );
        uint256 batchId = vault.openBatch(market, 11, 12);
        usdce.mint(buyer, 410_000);
        vm.startPrank(buyer);
        usdce.approve(address(vault), 410_000);
        vault.commitBuy(batchId, commitment, SettlementAccounting.Side.NO_BUY, 410_000, initialProof);
        vm.stopPrank();

        vm.warp(block.timestamp + vault.BATCH_WINDOW());
        vault.closeBatch(batchId);
        vault.routeAssets(batchId, 410_000, 0, 0);
        vm.prank(wallet);
        pusd.transfer(address(0xCAFE), 405_000);
        vm.prank(wallet);
        pusd.transfer(address(vault), 5_000);
        ctf.mint(wallet, 12, 1_000_000);
        vm.prank(wallet);
        ctf.safeTransferFrom(wallet, address(vault), 12, 1_000_000, "");

        SettlementAccounting.Allocation[] memory proposed = new SettlementAccounting.Allocation[](1);
        proposed[0] = SettlementAccounting.Allocation(
            SettlementAccounting.Side.NO_BUY, 410_000, 420_000, 1_000_000, 405_000, 5_000
        );
        bytes[] memory proofs = new bytes[](1);
        proofs[0] = finalProof;
        vault.finalize(batchId, proposed, proofs, 5_000);
        vm.prank(buyer);
        vault.claim(batchId, 0);
        assertEq(usdce.balanceOf(buyer), 5_000);
        assertEq(ctf.balanceOf(buyer, 12), 1_000_000);
    }
}
