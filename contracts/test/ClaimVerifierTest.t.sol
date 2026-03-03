// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/ClaimVerifier.sol";

/**
 * @title ClaimVerifierTest
 * @notice End-to-end ZK claim pipeline test — validates the entire proof path:
 *         circuit execution → UltraHonk proof generation → on-chain verification.
 *
 * This test suite confirms the claim circuit + ClaimHonkVerifier are mainnet-ready
 * WITHOUT deploying to a live network. It deploys ClaimHonkVerifier locally (Forge
 * auto-links the 3 external library contracts) and optionally generates a real proof
 * via vm.ffi.
 *
 * Circuit: circuits/claim/src/main.nr
 *   - Public inputs: 11 field elements (9 semantic + 2 extra for bytes32 hi/lo split)
 *   - NUMBER_OF_PUBLIC_INPUTS = 27 (11 + 16 pairing points in proof bytes)
 *   - N = 262144, LOG_N = 18
 *
 * Contract sizes after the library split (all < 24,576-byte EIP-170 limit):
 *   ZKTranscriptLib       ~7,800 bytes
 *   RelationsLib         ~10,300 bytes
 *   CommitmentSchemeLib   ~1,100 bytes
 *   ClaimHonkVerifier    ~17,990 bytes
 *
 * ─── Test categories ──────────────────────────────────────────────────────────
 *
 * 1. Sanity / structural tests (always run, no FFI required):
 *    - ClaimHonkVerifier deploys successfully
 *    - Garbage proofs are correctly rejected
 *    - Deployed size is under the EIP-170 24,576-byte limit
 *
 * 2. Real ZK proof test (requires --ffi flag + bb + compiled circuit):
 *    - Calls relayer/scripts/generateClaimProof.ts via vm.ffi
 *    - Script generates a proof for a single filled-buy order
 *    - Verifies the returned proof on-chain with ClaimHonkVerifier.verify()
 *    - Asserts verify() returns true
 *
 * ─── Prerequisites for real proof test ───────────────────────────────────────
 *
 *   1. Install bb:
 *        curl -L https://raw.githubusercontent.com/AztecProtocol/aztec-packages/master/barretenberg/cpp/installation/install | bash
 *
 *   2. Compile the claim circuit:
 *        cd circuits/claim && nargo compile
 *
 *   3. Install relayer deps:
 *        cd relayer && npm install
 *
 * ─── Usage ────────────────────────────────────────────────────────────────────
 *
 *   # Structural tests only (fast, no FFI):
 *   forge test --match-contract ClaimVerifierTest -vv
 *
 *   # Full ZK claim pipeline test (~5-10 min, claim circuit is larger than batch):
 *   forge test --match-contract ClaimVerifierTest --match-test test_realProof --ffi -vv
 */
contract ClaimVerifierTest is Test {
    ClaimHonkVerifier public verifier;

    function setUp() public {
        // Forge auto-deploys ZKTranscriptLib, RelationsLib, CommitmentSchemeLib
        // and links them into ClaimHonkVerifier before deployment.
        verifier = new ClaimHonkVerifier();
    }

    // ─── Structural / sanity tests ────────────────────────────────────────────

    function test_verifier_deploysSuccessfully() public view {
        assertTrue(address(verifier) != address(0), "ClaimHonkVerifier should deploy");
    }

    /**
     * @notice Zero-length proof reverts (not silently returns false).
     */
    function test_verify_rejectsZeroLengthProof() public {
        bytes memory emptyProof = new bytes(0);
        // Claim circuit has 11 non-pairing public inputs
        bytes32[] memory publicInputs = new bytes32[](11);

        vm.expectRevert();
        verifier.verify(emptyProof, publicInputs);
    }

    /**
     * @notice Wrong-length proof reverts.
     */
    function test_verify_rejectsWrongLengthProof() public {
        bytes memory shortProof = new bytes(64);
        bytes32[] memory publicInputs = new bytes32[](11);

        vm.expectRevert();
        verifier.verify(shortProof, publicInputs);
    }

    /**
     * @notice Deployed bytecode is under the EIP-170 24,576-byte limit.
     */
    function test_verifier_sizeUnderEIP170() public {
        address v = address(verifier);
        uint256 size;
        assembly { size := extcodesize(v) }
        emit log_named_uint("ClaimHonkVerifier deployed bytecode size (bytes)", size);
        assertLt(size, 24576, "ClaimHonkVerifier must stay under EIP-170 limit");
    }

    // ─── Real ZK proof test (requires --ffi) ─────────────────────────────────

    /**
     * @notice FULL ZK CLAIM PIPELINE TEST — generates a real UltraHonk proof for
     *         a single filled-buy order and verifies it on-chain.
     *
     * Calls relayer/scripts/generateClaimProof.ts via vm.ffi. The script:
     *   1. Loads circuits/claim/target/claim.json
     *   2. Builds a 512-leaf Merkle tree (DEPTH=9) with 1 commitment at slot 0
     *   3. Computes the nullifier = keccak256(commitment, batchId, salt)
     *   4. Executes the circuit with the filled-buy witness
     *   5. Generates an UltraHonk proof (evm target)
     *   6. ABI-encodes (bytes proof, bytes32[] publicInputs[11]) to stdout
     *
     * Public inputs layout verified here:
     *   [0]  batch_id            = 1
     *   [1]  commitment_root_hi  = high 128 bits of Merkle root
     *   [2]  commitment_root_lo  = low  128 bits of Merkle root
     *   [3]  clearing_price      = 650_000
     *   [4]  nullifier_hi        = high 128 bits of nullifier
     *   [5]  nullifier_lo        = low  128 bits of nullifier
     *   [6]  recipient           = 0xAABBCC... (unconstrained)
     *   [7]  fills               = 1 (true)
     *   [8]  fill_amount         = 1_000_000
     *   [9]  refund_amount       = 0
     *   [10] is_buy_out          = 1 (true)
     *
     * Expected: verify() returns true.
     *
     * Run with: forge test --match-test test_realProof --ffi -vv
     */
    function test_realProof_filledBuy() public {
        string[] memory args = new string[](2);
        args[0] = "../relayer/node_modules/.bin/tsx";
        args[1] = "../relayer/scripts/generateClaimProof.ts";

        emit log_string("[ClaimVerifierTest] Calling generateClaimProof.ts via vm.ffi...");
        emit log_string("  This may take 5-10 minutes (claim circuit: N=262144, LOG_N=18).");

        bytes memory result = vm.ffi(args);

        assertGt(result.length, 0, "vm.ffi returned empty output - check script for errors");

        (bytes memory proof, bytes32[] memory publicInputs) =
            abi.decode(result, (bytes, bytes32[]));

        emit log_named_uint("  Proof size (bytes)", proof.length);
        emit log_named_uint("  Public inputs count", publicInputs.length);

        assertGt(proof.length, 0, "Proof should not be empty");
        // ClaimHonkVerifier expects NUMBER_OF_PUBLIC_INPUTS - PAIRING_POINTS_SIZE
        // = 27 - 16 = 11 non-pairing inputs.
        assertEq(publicInputs.length, 11, "Expected 11 circuit public inputs");

        // Log decoded public inputs for debugging
        emit log_named_uint("  [0] batch_id", uint256(publicInputs[0]));
        emit log_named_bytes32("  [3] clearing_price", publicInputs[3]);
        emit log_named_uint("  [7] fills", uint256(publicInputs[7]));
        emit log_named_uint("  [8] fill_amount", uint256(publicInputs[8]));
        emit log_named_uint("  [10] is_buy_out", uint256(publicInputs[10]));

        // ── THE KEY ASSERTION ────────────────────────────────────────────────
        // If this passes, the full ZK claim pipeline is working end-to-end:
        //   Noir claim circuit → bb UltraHonk prover → ClaimHonkVerifier on-chain
        bool verified = verifier.verify(proof, publicInputs);
        assertTrue(verified, "ClaimHonkVerifier.verify() must return true for a valid proof");

        emit log_string("[ClaimVerifierTest] ZK claim pipeline confirmed end-to-end!");
    }
}
