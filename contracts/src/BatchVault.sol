// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./interfaces/IBatchVerifier.sol";
import "./interfaces/IConditionalTokens.sol";

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// @notice EIP-3009 subset — only the function used by BatchVault.
interface IUSDC {
    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8   v,
        bytes32 r,
        bytes32 s
    ) external;
}

/// @title BatchVault v10
/// @notice Private prediction market layer — supports all 4 Polymarket order types.
///
/// Order types (mirrors Polymarket CLOB exactly):
///   YES_BUY  — pay USDC, receive YES tokens  (EIP-3009 deferred)
///   YES_SELL — deposit YES tokens, receive USDC
///   NO_BUY   — pay USDC, receive NO tokens   (EIP-3009 deferred)
///   NO_SELL  — deposit NO tokens, receive USDC
///
/// Two-phase settlement (ZERO relayer capital):
///   Phase 1 — lockFunds():
///     1. Pull USDC from YES/NO buyers via EIP-3009
///     2. Direct-match YES buyers ↔ YES sellers (internal swap)
///     3. Direct-match NO buyers ↔ NO sellers
///     4. Standard CTF only: remaining balanced YES+NO demand → CTF.splitPosition
///     5. Standard CTF only: excess balanced YES+NO supply → CTF.mergePositions
///     6. Send gap USDC to relayer (vault-funded; relayer buys tokens from CLOB)
///     7. Send finalExcess tokens to relayer (relayer sells on CLOB for USDC)
///     8. Assign per-commitment positions; compute commitmentRoot
///   Phase 2 — settleBatch():
///     1. Verify ZK proof using stored public inputs
///     2. Pull gap tokens from relayer (bought with vault-provided USDC)
///     3. Pull USDC from relayer (from selling vault-provided excess tokens)
///     4. Build Merkle root; finalize batch
///
/// v10: NegRisk token ID overrides.
///   Call setMarketTokenIds(marketId, yesId, noId) before opening a batch for a
///   NegRisk (Polymarket multi-outcome) market. When set, the vault uses the CLOB
///   token IDs directly — bypassing CTF.splitPosition/mergePositions — so users
///   receive tradeable NegRisk YES/NO tokens rather than locked standard CTF positions.
///
/// Net result: relayer never uses its own USDC capital.
///
/// Privacy model:
///   - Commitment = keccak256(marketId, side, amount, limitPrice, salt) — no trader address
///   - EIP-3009: USDC pulled from ephemeral wallet at lockFunds (not upfront)
///   - claimWithProof: relayer submits ZK proof, payout to chosen recipient
contract BatchVault {
    // ═══════════════════════════════════════════════════════════════════════
    // Types
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice Order side — mirrors all 4 Polymarket CLOB order types.
    enum OrderSide {
        YES_BUY,   // 0: pay USDC → receive YES tokens  (EIP-3009 deferred)
        YES_SELL,  // 1: deposit YES tokens → receive USDC
        NO_BUY,    // 2: pay USDC → receive NO tokens   (EIP-3009 deferred)
        NO_SELL    // 3: deposit NO tokens → receive USDC
    }

    enum BatchStatus {
        OPEN,     // Accepting commitments
        SETTLING, // Batch closed (closeBatch called), awaiting lockFunds
        LOCKED,   // lockFunds called — gap USDC/tokens sent to relayer; awaiting settleBatch
        SETTLED   // Clearing price finalized, positions claimable
    }

    struct Batch {
        bytes32 marketId;
        uint256 openedAt;
        uint256 closedAt;
        BatchStatus status;
        // Running totals (updated at commit time)
        uint256 totalDeposited;   // USDC authorized by YES buyers
        uint256 totalDepositedNo; // USDC authorized by NO buyers
        uint256 totalSellYes;     // YES tokens deposited by YES sellers
        uint256 totalSellNo;      // NO tokens deposited by NO sellers
        // Settlement results (set at lockFunds, read at settleBatch + claim time)
        uint256 clearingPrice;    // 6-decimal fixed point (e.g. 650000 = $0.65)
        uint256 commitmentCount;
        bytes32 commitmentRoot;   // Sequential hash chain (for batch clearing ZK)
        bytes32 claimMerkleRoot;  // Binary Merkle root (for ZK claim proofs)
        // Two-phase settlement state (set by lockFunds, consumed by settleBatch)
        uint256 filledYesBuyVol;   // USDC from filled YES buyers (ZK public input)
        uint256 filledNoBuyVol;    // USDC from filled NO buyers (ZK public input)
        uint256 filledYesSellQty;  // YES tokens from filled YES sellers (ZK public input)
        uint256 filledNoSellQty;   // NO tokens from filled NO sellers (ZK public input)
        uint256 yesGap;            // YES tokens relayer must deliver in settleBatch
        uint256 noGap;             // NO tokens relayer must deliver in settleBatch
        uint256 finalExcessYes;    // YES tokens sent to relayer; relayer returns USDC in settleBatch
        uint256 finalExcessNo;     // NO tokens sent to relayer; relayer returns USDC in settleBatch
    }

    /// @notice Stored commitment — only hash and amount, no trader address.
    struct Commitment {
        bytes32 hash;
        uint256 amount;
        bool    claimed;
    }

    /// @notice Revealed order submitted by relayer at settlement.
    struct RevealedOrder {
        OrderSide side;       // YES_BUY / YES_SELL / NO_BUY / NO_SELL
        uint256 amount;       // USDC (for BUY) or token qty (for SELL), 6 decimals
        uint256 limitPrice;   // 6-decimal: max price for BUY, min price for SELL
        bytes32 salt;
    }

    /// @notice EIP-3009 transfer authorization (for YES_BUY and NO_BUY filled orders).
    ///         Pass zero-value struct for SELL orders and unfilled BUY orders.
    struct TransferAuth {
        address from;
        uint256 validAfter;
        uint256 validBefore;
        bytes32 nonce;
        uint8   v;
        bytes32 r;
        bytes32 s;
    }

    /// @notice Per-commitment position stored at lockFunds.
    struct Position {
        uint256  filledAmount;  // BUY: USDC filled. SELL: token qty filled.
        uint256  refundAmount;  // Unfilled SELL: token qty to refund. BUY: 0.
        OrderSide side;
        bool     claimed;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Constants
    // ═══════════════════════════════════════════════════════════════════════

    uint256 public constant BATCH_WINDOW    = 30;      // seconds
    uint256 public constant PRICE_DECIMALS  = 1e6;     // 6-decimal prices
    uint256 public constant MAX_BATCH_ORDERS = 500;
    uint256 public constant RESCUE_DELAY    = 7 days;

    bytes32 private constant EIP712_DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );
    bytes32 public constant COMMITMENT_TYPEHASH = keccak256(
        "CommitOrder(bytes32 commitment,uint256 amount,uint256 nonce,uint256 deadline)"
    );

    // ═══════════════════════════════════════════════════════════════════════
    // Immutables
    // ═══════════════════════════════════════════════════════════════════════

    address public immutable usdc;
    address public immutable ctf;
    address public immutable relayer;
    bytes32 public immutable DOMAIN_SEPARATOR;

    // ═══════════════════════════════════════════════════════════════════════
    // Storage
    // ═══════════════════════════════════════════════════════════════════════

    IBatchVerifier public verifier;
    IBatchVerifier public claimVerifier;

    uint256 private _nextBatchId;

    mapping(bytes32 => uint256)  public currentBatchIdByMarket;
    mapping(uint256 => Batch)    public batches;
    mapping(uint256 => mapping(uint256 => Commitment)) public commitments;
    mapping(uint256 => mapping(bytes32 => Position))   public positionsByCommitment;
    mapping(uint256 => mapping(bytes32 => uint256))    public commitmentIndex;
    mapping(uint256 => mapping(bytes32 => bool))       public hasCommittedHash;
    mapping(address => uint256)  public nonces;
    mapping(bytes32 => bool)     public usedNullifiers;

    // v10: NegRisk token ID overrides — set by relayer before opening batches for
    // NegRisk (Polymarket multi-outcome) markets.  When non-zero, the vault uses
    // these token IDs instead of computing from CTF.getPositionId, and skips
    // CTF.splitPosition / mergePositions (gap fills handled via CLOB by relayer).
    mapping(bytes32 marketId => uint256) public yesTokenIds;
    mapping(bytes32 marketId => uint256) public noTokenIds;

    // ═══════════════════════════════════════════════════════════════════════
    // Events
    // ═══════════════════════════════════════════════════════════════════════

    event BatchOpened(uint256 indexed batchId, bytes32 indexed marketId, uint256 openedAt);
    event OrderCommitted(uint256 indexed batchId, bytes32 indexed commitment);
    event BatchClosed(uint256 indexed batchId, uint256 commitmentCount);
    event FundsLocked(
        uint256 indexed batchId,
        uint256 clearingPrice,
        uint256 splitQty,
        uint256 mergeQty,
        uint256 yesGap,
        uint256 noGap,
        uint256 finalExcessYes,
        uint256 finalExcessNo
    );
    event BatchSettled(
        uint256 indexed batchId,
        uint256 clearingPrice,
        uint256 filledYesBuyVol,
        uint256 filledNoBuyVol,
        uint256 filledYesSellQty,
        uint256 filledNoSellQty,
        uint256 yesGap,
        uint256 noGap
    );
    event PositionClaimed(uint256 indexed batchId, address indexed claimer, uint256 yesShares, uint256 noShares, uint256 usdcPayout, uint256 refund);
    event VerifierUpdated(address newVerifier);
    event ClaimVerifierUpdated(address newClaimVerifier);
    event MarketTokenIdsSet(bytes32 indexed marketId, uint256 yesTokenId, uint256 noTokenId);

    // ═══════════════════════════════════════════════════════════════════════
    // Errors
    // ═══════════════════════════════════════════════════════════════════════

    error BatchNotOpen();
    error BatchWindowNotClosed();
    error BatchNotSettling();
    error BatchNotLocked();
    error BatchNotSettled();
    error DuplicateCommitment();
    error InvalidCommitment();
    error ZKProofInvalid();
    error CommitmentMismatch();
    error MaxOrdersExceeded();
    error OnlyRelayer();
    error ZeroAmount();
    error AlreadyClaimed();
    error NothingToClaim();
    error InvalidClearingPrice();
    error InvalidSignature();
    error SignatureExpired();
    error ClaimVerifierNotSet();

    // ═══════════════════════════════════════════════════════════════════════
    // Constructor
    // ═══════════════════════════════════════════════════════════════════════

    constructor(
        address _usdc,
        address _ctf,
        address _relayer,
        address _verifier,
        address _claimVerifier
    ) {
        usdc    = _usdc;
        ctf     = _ctf;
        relayer = _relayer;
        verifier = IBatchVerifier(_verifier);
        if (_claimVerifier != address(0)) {
            claimVerifier = IBatchVerifier(_claimVerifier);
        }
        DOMAIN_SEPARATOR = keccak256(abi.encode(
            EIP712_DOMAIN_TYPEHASH,
            keccak256("BatchVault"),
            keccak256("1"),
            block.chainid,
            address(this)
        ));
        // Pre-approve CTF to pull vault's USDC for splitPosition calls
        IERC20(_usdc).approve(_ctf, type(uint256).max);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Batch lifecycle
    // ═══════════════════════════════════════════════════════════════════════

    function openBatch(bytes32 marketId) external returns (uint256 batchId) {
        if (msg.sender != relayer) revert OnlyRelayer();

        uint256 existingId = currentBatchIdByMarket[marketId];
        require(
            existingId == 0 || batches[existingId].status != BatchStatus.OPEN,
            "BatchVault: batch already open"
        );

        batchId = ++_nextBatchId;
        currentBatchIdByMarket[marketId] = batchId;
        batches[batchId] = Batch({
            marketId:        marketId,
            openedAt:        block.timestamp,
            closedAt:        0,
            status:          BatchStatus.OPEN,
            totalDeposited:  0,
            totalDepositedNo: 0,
            totalSellYes:    0,
            totalSellNo:     0,
            clearingPrice:   0,
            commitmentCount: 0,
            commitmentRoot:  bytes32(0),
            claimMerkleRoot: bytes32(0),
            filledYesBuyVol:  0,
            filledNoBuyVol:   0,
            filledYesSellQty: 0,
            filledNoSellQty:  0,
            yesGap:          0,
            noGap:           0,
            finalExcessYes:  0,
            finalExcessNo:   0
        });

        emit BatchOpened(batchId, marketId, block.timestamp);
    }

    function closeBatch(bytes32 marketId) external {
        uint256 batchId = currentBatchIdByMarket[marketId];
        Batch storage batch = batches[batchId];
        if (batch.status != BatchStatus.OPEN) revert BatchNotOpen();
        if (block.timestamp < batch.openedAt + BATCH_WINDOW) revert BatchWindowNotClosed();

        batch.status   = BatchStatus.SETTLING;
        batch.closedAt = block.timestamp;

        emit BatchClosed(batchId, batch.commitmentCount);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // YES BUY — pay USDC, receive YES tokens
    // ═══════════════════════════════════════════════════════════════════════

    function commitOrder(bytes32 commitment, uint256 amount, bytes32 marketId) external {
        if (amount == 0) revert ZeroAmount();
        _executeCommit(commitment, amount, marketId, true /* isUsdcDeposit */);
    }

    function commitOrderFor(
        bytes32 commitment,
        uint256 amount,
        address signer,
        uint256 nonce,
        uint256 deadline,
        bytes calldata signature,
        bytes32 marketId
    ) external {
        if (amount == 0) revert ZeroAmount();
        _validateEIP712(signer, commitment, amount, nonce, deadline, signature);
        _executeCommit(commitment, amount, marketId, true);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // YES SELL — deposit YES tokens, receive USDC
    // ═══════════════════════════════════════════════════════════════════════

    function commitSellOrder(bytes32 commitment, uint256 yesAmount, bytes32 marketId) external {
        if (yesAmount == 0) revert ZeroAmount();
        _executeCommitTokenSell(commitment, yesAmount, msg.sender, marketId, true /* isYes */);
    }

    function commitSellOrderFor(
        bytes32 commitment,
        uint256 yesAmount,
        address signer,
        uint256 nonce,
        uint256 deadline,
        bytes calldata signature,
        bytes32 marketId
    ) external {
        if (yesAmount == 0) revert ZeroAmount();
        _validateEIP712(signer, commitment, yesAmount, nonce, deadline, signature);
        _executeCommitTokenSell(commitment, yesAmount, signer, marketId, true);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // NO BUY — pay USDC, receive NO tokens
    // ═══════════════════════════════════════════════════════════════════════

    function commitBuyNoOrder(bytes32 commitment, uint256 amount, bytes32 marketId) external {
        if (amount == 0) revert ZeroAmount();
        _executeCommit(commitment, amount, marketId, false /* isUsdcDeposit — tracks in totalDepositedNo */);
    }

    function commitBuyNoOrderFor(
        bytes32 commitment,
        uint256 amount,
        address signer,
        uint256 nonce,
        uint256 deadline,
        bytes calldata signature,
        bytes32 marketId
    ) external {
        if (amount == 0) revert ZeroAmount();
        _validateEIP712(signer, commitment, amount, nonce, deadline, signature);
        _executeCommitNoBuy(commitment, amount, marketId);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // NO SELL — deposit NO tokens, receive USDC
    // ═══════════════════════════════════════════════════════════════════════

    function commitSellNoOrder(bytes32 commitment, uint256 noAmount, bytes32 marketId) external {
        if (noAmount == 0) revert ZeroAmount();
        _executeCommitTokenSell(commitment, noAmount, msg.sender, marketId, false /* isYes */);
    }

    function commitSellNoOrderFor(
        bytes32 commitment,
        uint256 noAmount,
        address signer,
        uint256 nonce,
        uint256 deadline,
        bytes calldata signature,
        bytes32 marketId
    ) external {
        if (noAmount == 0) revert ZeroAmount();
        _validateEIP712(signer, commitment, noAmount, nonce, deadline, signature);
        _executeCommitTokenSell(commitment, noAmount, signer, marketId, false);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // ERC-1155 receiver
    // ═══════════════════════════════════════════════════════════════════════

    function onERC1155Received(address, address, uint256, uint256, bytes calldata)
        external view returns (bytes4)
    {
        require(msg.sender == ctf, "BatchVault: only CTF tokens accepted");
        return 0xf23a6e61;
    }

    function onERC1155BatchReceived(address, address, uint256[] calldata, uint256[] calldata, bytes calldata)
        external view returns (bytes4)
    {
        require(msg.sender == ctf, "BatchVault: only CTF tokens accepted");
        return 0xbc197c81;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Phase 1: lockFunds — pull USDC, split/merge, send gap to relayer
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice Phase 1 of two-phase zero-capital settlement.
    ///
    /// Pulls user USDC via EIP-3009, performs internal matching and CTF split/merge,
    /// then sends gap USDC to the relayer (so relayer can buy tokens from CLOB using
    /// vault's own USDC — no relayer capital required). Also sends finalExcess tokens
    /// to relayer for CLOB liquidation (relayer returns USDC in settleBatch).
    ///
    /// After this call, batch status = LOCKED. Call settleBatch() once the relayer
    /// has acquired the gap tokens (and sold the excess tokens) on the CLOB.
    ///
    /// @param filledYesBuyVol  Total USDC from filled YES buyers
    /// @param filledNoBuyVol   Total USDC from filled NO buyers
    /// @param filledYesSellQty Total YES tokens from filled YES sellers (already in vault)
    /// @param filledNoSellQty  Total NO tokens from filled NO sellers (already in vault)
    function lockFunds(
        uint256 batchId,
        RevealedOrder[] calldata orders,
        TransferAuth[] calldata auths,
        uint256 clearingPrice,
        uint256 filledYesBuyVol,
        uint256 filledNoBuyVol,
        uint256 filledYesSellQty,
        uint256 filledNoSellQty
    ) external {
        if (msg.sender != relayer) revert OnlyRelayer();

        Batch storage batch = batches[batchId];
        if (batch.status != BatchStatus.SETTLING)                    revert BatchNotSettling();
        if (clearingPrice == 0 || clearingPrice >= PRICE_DECIMALS)   revert InvalidClearingPrice();
        if (orders.length != batch.commitmentCount)                  revert CommitmentMismatch();
        if (auths.length  != orders.length)                          revert CommitmentMismatch();

        // 1. Verify all revealed orders match their on-chain commitment hashes
        _verifyCommitments(batchId, batch.marketId, orders);

        // 2. Pull USDC from filled YES/NO buyers via EIP-3009
        uint256 noPrice = PRICE_DECIMALS - clearingPrice;
        for (uint256 i = 0; i < orders.length; i++) {
            RevealedOrder calldata o = orders[i];
            bool fills;
            if (o.side == OrderSide.YES_BUY) {
                fills = o.limitPrice >= clearingPrice;
            } else if (o.side == OrderSide.NO_BUY) {
                fills = o.limitPrice >= noPrice;
            }
            if ((o.side == OrderSide.YES_BUY || o.side == OrderSide.NO_BUY) && fills) {
                IUSDC(usdc).transferWithAuthorization(
                    auths[i].from,
                    address(this),
                    o.amount,
                    auths[i].validAfter,
                    auths[i].validBefore,
                    auths[i].nonce,
                    auths[i].v,
                    auths[i].r,
                    auths[i].s
                );
            }
        }

        // 3. Compute target token quantities at clearing price
        uint256 yesBuyersNeed = (filledYesBuyVol * PRICE_DECIMALS) / clearingPrice;
        uint256 noBuyersNeed  = (filledNoBuyVol  * PRICE_DECIMALS) / noPrice;

        // 4. Direct matches (internal token swaps — no CTF needed)
        uint256 directYesMatch = yesBuyersNeed < filledYesSellQty ? yesBuyersNeed : filledYesSellQty;
        uint256 directNoMatch  = noBuyersNeed  < filledNoSellQty  ? noBuyersNeed  : filledNoSellQty;

        // 5. Cross-match via CTF split (remaining YES + NO demand → vault's USDC).
        //    Skipped for NegRisk markets: split/merge would create standard CTF tokens
        //    (non-tradeable on Polymarket CLOB).  All unmet demand becomes yesGap/noGap
        //    and is filled by the relayer via the CLOB using vault-provided USDC.
        uint256 remainingYesDemand = yesBuyersNeed - directYesMatch;
        uint256 remainingNoDemand  = noBuyersNeed  - directNoMatch;

        bool negRisk = yesTokenIds[batch.marketId] != 0;

        uint256 splitQty = 0;
        if (!negRisk) {
            splitQty = remainingYesDemand < remainingNoDemand
                ? remainingYesDemand : remainingNoDemand;
            if (splitQty > 0) {
                uint256[] memory partition = new uint256[](2);
                partition[0] = 1; // YES = indexSet 1
                partition[1] = 2; // NO  = indexSet 2
                IConditionalTokens(ctf).splitPosition(
                    usdc, bytes32(0), batch.marketId, partition, splitQty
                );
            }
        }

        // 6. Cross-match excess sellers via CTF merge (excess YES + NO → USDC returned to vault).
        //    Also skipped for NegRisk markets: excess NegRisk tokens are sent to the relayer
        //    (finalExcessYes / finalExcessNo) who sells them on the CLOB and returns USDC.
        uint256 excessYes = filledYesSellQty - directYesMatch;
        uint256 excessNo  = filledNoSellQty  - directNoMatch;

        uint256 mergeQty = 0;
        if (!negRisk) {
            mergeQty = excessYes < excessNo ? excessYes : excessNo;
            if (mergeQty > 0) {
                uint256[] memory partition = new uint256[](2);
                partition[0] = 1;
                partition[1] = 2;
                IConditionalTokens(ctf).mergePositions(
                    usdc, bytes32(0), batch.marketId, partition, mergeQty
                );
            }
        }

        // 7. Compute gap and final excess
        uint256 yesGap        = remainingYesDemand - splitQty;
        uint256 noGap         = remainingNoDemand  - splitQty;
        uint256 finalExcessYes = excessYes - mergeQty;
        uint256 finalExcessNo  = excessNo  - mergeQty;

        uint256 yesTokenId = _getYesTokenId(batch.marketId);
        uint256 noTokenId  = _getNoTokenId(batch.marketId);

        // 8. Send gap USDC to relayer — relayer buys tokens from CLOB using vault's USDC.
        //    Zero relayer capital: the USDC comes from user deposits, not the relayer wallet.
        //
        //    Polymarket CLOB requires makerAmount to be a multiple of 10000 (= $0.01 precision).
        //    We round UP to the nearest 10000 so the relayer always has a valid makerAmount.
        //
        //    Design note: the relayer's CLOB order uses limitPrice = bestAsk × 1.002, so
        //    makerAmount may exceed vault-provided USDC by up to ~$0.01 per batch (due to the
        //    0.2% price buffer and $0.01 USDC rounding). The relayer must maintain a small
        //    USDC.e working capital buffer (~$5) to cover this gap. It cannot come from the
        //    vault because in a pure buy-only batch the vault has exactly (clearingPrice × yesGap)
        //    USDC from user deposits — no surplus to draw from.
        uint256 CLOB_USDC_PREC = 10000; // $0.01 in 6-decimal USDC
        if (yesGap > 0) {
            uint256 usdcForYesGapRaw = (yesGap * clearingPrice) / PRICE_DECIMALS;
            uint256 usdcForYesGap = ((usdcForYesGapRaw + CLOB_USDC_PREC - 1) / CLOB_USDC_PREC) * CLOB_USDC_PREC;
            IERC20(usdc).transfer(relayer, usdcForYesGap);
        }
        if (noGap > 0) {
            uint256 usdcForNoGapRaw = (noGap * noPrice) / PRICE_DECIMALS;
            uint256 usdcForNoGap = ((usdcForNoGapRaw + CLOB_USDC_PREC - 1) / CLOB_USDC_PREC) * CLOB_USDC_PREC;
            IERC20(usdc).transfer(relayer, usdcForNoGap);
        }

        // 9. Send finalExcess tokens to relayer for CLOB liquidation.
        //    Relayer sells them and returns the USDC in settleBatch.
        if (finalExcessYes > 0) {
            IConditionalTokens(ctf).safeTransferFrom(address(this), relayer, yesTokenId, finalExcessYes, "");
        }
        if (finalExcessNo > 0) {
            IConditionalTokens(ctf).safeTransferFrom(address(this), relayer, noTokenId, finalExcessNo, "");
        }

        // 10. Assign per-commitment positions (keyed by commitment hash)
        _assignPositions(batchId, orders, clearingPrice);

        // 11. Compute and store commitment root (ZK public input)
        bytes32 commitmentRoot = _computeCommitmentRoot(batchId, orders.length);

        // 12. Persist settlement geometry for settleBatch
        batch.status          = BatchStatus.LOCKED;
        batch.clearingPrice   = clearingPrice;
        batch.commitmentRoot  = commitmentRoot;
        batch.filledYesBuyVol  = filledYesBuyVol;
        batch.filledNoBuyVol   = filledNoBuyVol;
        batch.filledYesSellQty = filledYesSellQty;
        batch.filledNoSellQty  = filledNoSellQty;
        batch.yesGap           = yesGap;
        batch.noGap            = noGap;
        batch.finalExcessYes   = finalExcessYes;
        batch.finalExcessNo    = finalExcessNo;

        emit FundsLocked(batchId, clearingPrice, splitQty, mergeQty, yesGap, noGap, finalExcessYes, finalExcessNo);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Phase 2: settleBatch — verify ZK proof, pull from relayer, finalize
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice Phase 2 of two-phase zero-capital settlement.
    ///
    /// Must be called after lockFunds() once the relayer has:
    ///   - Acquired yesGap YES tokens from CLOB (using vault-provided USDC)
    ///   - Acquired noGap NO tokens from CLOB (using vault-provided USDC)
    ///   - Sold finalExcessYes YES tokens on CLOB (and holds the USDC proceeds)
    ///   - Sold finalExcessNo NO tokens on CLOB (and holds the USDC proceeds)
    ///
    /// Verifies the ZK proof using public inputs stored at lockFunds, pulls the
    /// gap tokens and excess USDC from the relayer, and finalizes the batch.
    ///
    /// Requires: ctf.isApprovedForAll(relayer, vault) == true
    ///           usdc.allowance(relayer, vault) >= finalExcess USDC owed
    function settleBatch(uint256 batchId, bytes calldata proof) external {
        if (msg.sender != relayer) revert OnlyRelayer();

        Batch storage batch = batches[batchId];
        if (batch.status != BatchStatus.LOCKED) revert BatchNotLocked();

        uint256 noPrice    = PRICE_DECIMALS - batch.clearingPrice;
        uint256 yesTokenId = _getYesTokenId(batch.marketId);
        uint256 noTokenId  = _getNoTokenId(batch.marketId);

        // 1. Build ZK proof public inputs from stored values and verify
        bytes32[] memory publicInputs = new bytes32[](6);
        publicInputs[0] = batch.commitmentRoot;
        publicInputs[1] = bytes32(batch.clearingPrice);
        publicInputs[2] = bytes32(batch.filledYesBuyVol);
        publicInputs[3] = bytes32(batch.filledNoBuyVol);
        publicInputs[4] = bytes32(batch.filledYesSellQty);
        publicInputs[5] = bytes32(batch.filledNoSellQty);
        if (!verifier.verify(proof, publicInputs)) revert ZKProofInvalid();

        // 2. Pull gap tokens from relayer (relayer bought using vault-provided USDC — zero own capital)
        if (batch.yesGap > 0) {
            IConditionalTokens(ctf).safeTransferFrom(msg.sender, address(this), yesTokenId, batch.yesGap, "");
        }
        if (batch.noGap > 0) {
            IConditionalTokens(ctf).safeTransferFrom(msg.sender, address(this), noTokenId, batch.noGap, "");
        }

        // 3. Pull USDC from relayer (proceeds from selling vault-provided excess tokens)
        if (batch.finalExcessYes > 0) {
            uint256 usdcFromExcessYes = (batch.finalExcessYes * batch.clearingPrice) / PRICE_DECIMALS;
            IERC20(usdc).transferFrom(msg.sender, address(this), usdcFromExcessYes);
        }
        if (batch.finalExcessNo > 0) {
            uint256 usdcFromExcessNo = (batch.finalExcessNo * noPrice) / PRICE_DECIMALS;
            IERC20(usdc).transferFrom(msg.sender, address(this), usdcFromExcessNo);
        }

        // 4. Build Merkle root for ZK claim proofs
        bytes32 claimMerkleRoot = _buildMerkleRoot(batchId, batch.commitmentCount);

        // 5. Finalize batch
        batch.status          = BatchStatus.SETTLED;
        batch.claimMerkleRoot = claimMerkleRoot;

        emit BatchSettled(
            batchId, batch.clearingPrice,
            batch.filledYesBuyVol, batch.filledNoBuyVol,
            batch.filledYesSellQty, batch.filledNoSellQty,
            batch.yesGap, batch.noGap
        );
    }

    // ═══════════════════════════════════════════════════════════════════════
    // ZK claim (primary privacy path)
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice Claim a position using a ZK proof.
    ///         msg.sender = relayer. Payout goes to recipient (Alice's address never revealed).
    ///
    /// Public inputs layout (bytes32[], 11 elements):
    ///   [0]  batch_id
    ///   [1]  commitment_root_hi  (high 128 bits of claimMerkleRoot)
    ///   [2]  commitment_root_lo  (low  128 bits)
    ///   [3]  clearing_price
    ///   [4]  nullifier_hi
    ///   [5]  nullifier_lo
    ///   [6]  recipient           (address packed right-aligned)
    ///   [7]  fills               (0 or 1)
    ///   [8]  fill_amount         (USDC for BUY, token qty for SELL)
    ///   [9]  refund_amount       (token qty refund for unfilled SELL; 0 otherwise)
    ///   [10] side                (0=YES_BUY, 1=YES_SELL, 2=NO_BUY, 3=NO_SELL)
    function claimWithProof(
        uint256 batchId,
        bytes calldata proof,
        bytes32[] calldata publicInputs
    ) external {
        if (address(claimVerifier) == address(0)) revert ClaimVerifierNotSet();

        Batch storage batch = batches[batchId];
        if (batch.status != BatchStatus.SETTLED) revert BatchNotSettled();
        if (publicInputs.length != 11) revert CommitmentMismatch();

        bytes32 claimMerkleRoot = bytes32((uint256(publicInputs[1]) << 128) | uint256(publicInputs[2]));
        bytes32 nullifier       = bytes32((uint256(publicInputs[4]) << 128) | uint256(publicInputs[5]));

        if (uint256(publicInputs[0]) != batchId)            revert CommitmentMismatch();
        if (claimMerkleRoot != batch.claimMerkleRoot)        revert CommitmentMismatch();
        if (uint256(publicInputs[3]) != batch.clearingPrice) revert CommitmentMismatch();

        if (!claimVerifier.verify(proof, publicInputs)) revert ZKProofInvalid();
        if (usedNullifiers[nullifier]) revert AlreadyClaimed();
        usedNullifiers[nullifier] = true;

        address   recipient    = address(uint160(uint256(publicInputs[6])));
        bool      fills        = uint256(publicInputs[7]) == 1;
        uint256   fillAmount   = uint256(publicInputs[8]);
        uint256   refundAmount = uint256(publicInputs[9]);
        OrderSide side         = OrderSide(uint256(publicInputs[10]));

        _executePayout(batchId, batch.marketId, batch.clearingPrice, fills, fillAmount, refundAmount, side, recipient);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Direct claim (sell orders — non-private path)
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice Claim by revealing order preimage. Payout to msg.sender.
    ///         WARNING: preimage visible in mempool — use claimWithProof for privacy.
    function claimPosition(
        uint256   batchId,
        OrderSide side,
        uint256   amount,
        uint256   limitPrice,
        bytes32   salt
    ) external {
        Batch storage batch = batches[batchId];
        if (batch.status != BatchStatus.SETTLED) revert BatchNotSettled();

        bytes32 commitment = keccak256(
            abi.encode(batch.marketId, uint8(side), amount, limitPrice, salt)
        );
        bytes32 nullifier = keccak256(abi.encode(commitment, batchId, salt));
        if (usedNullifiers[nullifier]) revert AlreadyClaimed();

        Position storage pos = positionsByCommitment[batchId][commitment];
        if (pos.filledAmount == 0 && pos.refundAmount == 0) revert NothingToClaim();
        if (pos.claimed) revert AlreadyClaimed();

        pos.claimed = true;
        usedNullifiers[nullifier] = true;

        bool fills = pos.filledAmount > 0;
        _executePayout(batchId, batch.marketId, batch.clearingPrice, fills, pos.filledAmount, pos.refundAmount, pos.side, msg.sender);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Emergency rescue for stuck token deposits
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice Emergency rescue for sell orders stuck before lockFunds was called.
    ///         Only available when batch is in SETTLING status (pre-lockFunds).
    ///         After 7 days, sellers can reclaim deposited YES/NO tokens.
    function rescueStuckSellOrder(
        uint256   batchId,
        OrderSide side,     // must be YES_SELL or NO_SELL
        uint256   amount,
        uint256   limitPrice,
        bytes32   salt
    ) external {
        Batch storage batch = batches[batchId];
        require(batch.status == BatchStatus.SETTLING, "BatchVault: batch not stuck");
        require(
            batch.closedAt > 0 && block.timestamp >= batch.closedAt + RESCUE_DELAY,
            "BatchVault: rescue delay not elapsed"
        );
        require(side == OrderSide.YES_SELL || side == OrderSide.NO_SELL, "BatchVault: not a sell order");

        bytes32 commitment = keccak256(
            abi.encode(batch.marketId, uint8(side), amount, limitPrice, salt)
        );
        Commitment storage c = commitments[batchId][commitmentIndex[batchId][commitment]];
        require(c.hash == commitment && !c.claimed, "BatchVault: invalid or already rescued");
        c.claimed = true;

        uint256 tokenId = side == OrderSide.YES_SELL
            ? _getYesTokenId(batch.marketId)
            : _getNoTokenId(batch.marketId);
        IConditionalTokens(ctf).safeTransferFrom(address(this), msg.sender, tokenId, amount, "");
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Internal — commit helpers
    // ═══════════════════════════════════════════════════════════════════════

    function _validateEIP712(
        address signer,
        bytes32 commitment,
        uint256 amount,
        uint256 nonce,
        uint256 deadline,
        bytes calldata signature
    ) internal {
        if (block.timestamp > deadline) revert SignatureExpired();
        if (nonce != nonces[signer]) revert InvalidSignature();

        bytes32 structHash = keccak256(abi.encode(
            COMMITMENT_TYPEHASH, commitment, amount, nonce, deadline
        ));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
        address recovered = _recoverSigner(digest, signature);
        if (recovered == address(0) || recovered != signer) revert InvalidSignature();
        nonces[signer]++;
    }

    /// @dev Commit a BUY order (YES or NO — distinguished by which function called this).
    function _executeCommit(bytes32 commitment, uint256 amount, bytes32 marketId, bool isYesBuy) internal {
        uint256 batchId = currentBatchIdByMarket[marketId];
        Batch storage batch = batches[batchId];
        if (batch.status != BatchStatus.OPEN)          revert BatchNotOpen();
        if (hasCommittedHash[batchId][commitment])      revert DuplicateCommitment();
        if (batch.commitmentCount >= MAX_BATCH_ORDERS)  revert MaxOrdersExceeded();

        uint256 idx = batch.commitmentCount++;
        commitments[batchId][idx] = Commitment({ hash: commitment, amount: amount, claimed: false });
        hasCommittedHash[batchId][commitment] = true;
        commitmentIndex[batchId][commitment]  = idx;

        if (isYesBuy) {
            batch.totalDeposited += amount;
        } else {
            batch.totalDepositedNo += amount;
        }

        emit OrderCommitted(batchId, commitment);
    }

    function _executeCommitNoBuy(bytes32 commitment, uint256 amount, bytes32 marketId) internal {
        _executeCommit(commitment, amount, marketId, false);
    }

    /// @dev Commit a SELL order and deposit tokens upfront (YES or NO).
    function _executeCommitTokenSell(
        bytes32 commitment,
        uint256 tokenAmount,
        address trader,
        bytes32 marketId,
        bool isYes
    ) internal {
        uint256 batchId = currentBatchIdByMarket[marketId];
        Batch storage batch = batches[batchId];
        if (batch.status != BatchStatus.OPEN)          revert BatchNotOpen();
        if (hasCommittedHash[batchId][commitment])      revert DuplicateCommitment();
        if (batch.commitmentCount >= MAX_BATCH_ORDERS)  revert MaxOrdersExceeded();

        // Pull tokens from trader into vault
        uint256 tokenId = isYes
            ? _getYesTokenId(batch.marketId)
            : _getNoTokenId(batch.marketId);
        IConditionalTokens(ctf).safeTransferFrom(trader, address(this), tokenId, tokenAmount, "");

        uint256 idx = batch.commitmentCount++;
        commitments[batchId][idx] = Commitment({ hash: commitment, amount: tokenAmount, claimed: false });
        hasCommittedHash[batchId][commitment] = true;
        commitmentIndex[batchId][commitment]  = idx;

        if (isYes) {
            batch.totalSellYes += tokenAmount;
        } else {
            batch.totalSellNo += tokenAmount;
        }

        emit OrderCommitted(batchId, commitment);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Internal — settlement helpers
    // ═══════════════════════════════════════════════════════════════════════

    function _verifyCommitments(
        uint256 batchId,
        bytes32 marketId,
        RevealedOrder[] calldata orders
    ) internal view {
        for (uint256 i = 0; i < orders.length; i++) {
            Commitment storage c = commitments[batchId][i];
            bytes32 expectedHash = keccak256(
                abi.encode(marketId, uint8(orders[i].side), orders[i].amount, orders[i].limitPrice, orders[i].salt)
            );
            if (c.hash != expectedHash)       revert CommitmentMismatch();
            if (c.amount != orders[i].amount) revert CommitmentMismatch();
        }
    }

    function _computeCommitmentRoot(uint256 batchId, uint256 count) internal view returns (bytes32 root) {
        root = bytes32(0);
        for (uint256 i = 0; i < count; i++) {
            root = keccak256(abi.encode(root, commitments[batchId][i].hash));
        }
    }

    function _buildMerkleRoot(uint256 batchId, uint256 count) internal view returns (bytes32) {
        if (count == 0) return bytes32(0);
        uint256 n = 512;
        bytes32[] memory nodes = new bytes32[](2 * n);
        for (uint256 i = 0; i < count; i++) {
            nodes[n + i] = commitments[batchId][i].hash;
        }
        for (uint256 i = n - 1; i > 0; i--) {
            nodes[i] = keccak256(abi.encode(nodes[2 * i], nodes[2 * i + 1]));
        }
        return nodes[1];
    }

    function _assignPositions(
        uint256 batchId,
        RevealedOrder[] calldata orders,
        uint256 clearingPrice
    ) internal {
        Batch storage batch = batches[batchId];
        uint256 noPrice = PRICE_DECIMALS - clearingPrice;

        for (uint256 i = 0; i < orders.length; i++) {
            RevealedOrder calldata o = orders[i];
            uint256 filledAmount = 0;
            uint256 refundAmount = 0;

            bool fills;
            if (o.side == OrderSide.YES_BUY)  fills = o.limitPrice >= clearingPrice;
            else if (o.side == OrderSide.YES_SELL) fills = o.limitPrice <= clearingPrice;
            else if (o.side == OrderSide.NO_BUY)  fills = o.limitPrice >= noPrice;
            else /* NO_SELL */                     fills = o.limitPrice <= noPrice;

            if (fills) {
                filledAmount = o.amount; // BUY: USDC amount; SELL: token qty
            } else {
                // Unfilled SELL: refund deposited tokens. Unfilled BUY: nothing (EIP-3009 deferred).
                if (o.side == OrderSide.YES_SELL || o.side == OrderSide.NO_SELL) {
                    refundAmount = o.amount;
                }
            }

            bytes32 commitment = keccak256(
                abi.encode(batch.marketId, uint8(o.side), o.amount, o.limitPrice, o.salt)
            );
            positionsByCommitment[batchId][commitment] = Position({
                filledAmount: filledAmount,
                refundAmount: refundAmount,
                side:         o.side,
                claimed:      false
            });
        }
    }

    /// @dev Execute payout for a claimed position.
    ///      YES_BUY  → YES tokens (amount * 1e6 / clearingPrice)
    ///      NO_BUY   → NO tokens  (amount * 1e6 / noPrice)
    ///      YES_SELL → USDC       (tokenQty * clearingPrice / 1e6)
    ///      NO_SELL  → USDC       (tokenQty * noPrice / 1e6)
    ///      Unfilled SELL → token refund. Unfilled BUY → nothing.
    function _executePayout(
        uint256   batchId,
        bytes32   marketId,
        uint256   clearingPrice,
        bool      fills,
        uint256   fillAmount,
        uint256   refundAmount,
        OrderSide side,
        address   recipient
    ) internal {
        uint256 noPrice     = PRICE_DECIMALS - clearingPrice;
        uint256 yesTokenId  = _getYesTokenId(marketId);
        uint256 noTokenId   = _getNoTokenId(marketId);
        uint256 yesShares   = 0;
        uint256 noShares    = 0;
        uint256 usdcPayout  = 0;
        uint256 refund      = 0;

        if (fills && fillAmount > 0) {
            if (side == OrderSide.YES_BUY) {
                yesShares = (fillAmount * PRICE_DECIMALS) / clearingPrice;
                if (yesShares > 0) {
                    IConditionalTokens(ctf).safeTransferFrom(address(this), recipient, yesTokenId, yesShares, "");
                }
            } else if (side == OrderSide.NO_BUY) {
                noShares = (fillAmount * PRICE_DECIMALS) / noPrice;
                if (noShares > 0) {
                    IConditionalTokens(ctf).safeTransferFrom(address(this), recipient, noTokenId, noShares, "");
                }
            } else if (side == OrderSide.YES_SELL) {
                usdcPayout = (fillAmount * clearingPrice) / PRICE_DECIMALS;
                if (usdcPayout > 0) IERC20(usdc).transfer(recipient, usdcPayout);
            } else { // NO_SELL
                usdcPayout = (fillAmount * noPrice) / PRICE_DECIMALS;
                if (usdcPayout > 0) IERC20(usdc).transfer(recipient, usdcPayout);
            }
        }

        if (!fills && refundAmount > 0) {
            refund = refundAmount;
            uint256 tokenId = (side == OrderSide.YES_SELL) ? yesTokenId : noTokenId;
            IConditionalTokens(ctf).safeTransferFrom(address(this), recipient, tokenId, refundAmount, "");
        }

        emit PositionClaimed(batchId, recipient, yesShares, noShares, usdcPayout, refund);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Internal — token ID helpers
    // ═══════════════════════════════════════════════════════════════════════

    function _getYesTokenId(bytes32 conditionId) internal view returns (uint256) {
        // v10: return NegRisk CLOB token ID if registered by relayer
        if (yesTokenIds[conditionId] != 0) return yesTokenIds[conditionId];
        bytes32 collectionId = IConditionalTokens(ctf).getCollectionId(
            bytes32(0), conditionId, 1  // YES = indexSet 1
        );
        return IConditionalTokens(ctf).getPositionId(usdc, collectionId);
    }

    function _getNoTokenId(bytes32 conditionId) internal view returns (uint256) {
        // v10: return NegRisk CLOB token ID if registered by relayer
        if (noTokenIds[conditionId] != 0) return noTokenIds[conditionId];
        bytes32 collectionId = IConditionalTokens(ctf).getCollectionId(
            bytes32(0), conditionId, 2  // NO = indexSet 2
        );
        return IConditionalTokens(ctf).getPositionId(usdc, collectionId);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Internal — ECDSA
    // ═══════════════════════════════════════════════════════════════════════

    function _recoverSigner(bytes32 digest, bytes calldata sig) internal pure returns (address) {
        if (sig.length != 65) return address(0);
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(sig.offset)
            s := calldataload(add(sig.offset, 32))
            v := byte(0, calldataload(add(sig.offset, 64)))
        }
        if (v < 27) v += 27;
        if (v != 27 && v != 28) return address(0);
        return ecrecover(digest, v, r, s);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Admin
    // ═══════════════════════════════════════════════════════════════════════

    function setVerifier(address newVerifier) external {
        if (msg.sender != relayer) revert OnlyRelayer();
        verifier = IBatchVerifier(newVerifier);
        emit VerifierUpdated(newVerifier);
    }

    function setClaimVerifier(address newClaimVerifier) external {
        if (msg.sender != relayer) revert OnlyRelayer();
        claimVerifier = IBatchVerifier(newClaimVerifier);
        emit ClaimVerifierUpdated(newClaimVerifier);
    }

    /// @notice Register NegRisk (Polymarket CLOB) token IDs for a market.
    ///
    /// Must be called once per NegRisk market before the first batch for that market.
    /// Once set, the vault will:
    ///   - Use these token IDs for all ERC-1155 transfers (buyers receive NegRisk
    ///     tokens; sellers must deposit NegRisk tokens).
    ///   - Skip CTF.splitPosition and CTF.mergePositions — all unmet demand and
    ///     excess supply route through the CLOB (via the relayer gap-fill mechanism).
    ///
    /// To reset to standard CTF mode, pass yesTokenId = 0 and noTokenId = 0.
    function setMarketTokenIds(bytes32 marketId, uint256 yesTokenId, uint256 noTokenId) external {
        if (msg.sender != relayer) revert OnlyRelayer();
        yesTokenIds[marketId] = yesTokenId;
        noTokenIds[marketId]  = noTokenId;
        emit MarketTokenIdsSet(marketId, yesTokenId, noTokenId);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // View helpers
    // ═══════════════════════════════════════════════════════════════════════

    function getCurrentBatchId(bytes32 marketId) external view returns (uint256) {
        return currentBatchIdByMarket[marketId];
    }

    function getBatch(uint256 batchId) external view returns (Batch memory) {
        return batches[batchId];
    }

    function getCommitment(uint256 batchId, uint256 index) external view returns (Commitment memory) {
        return commitments[batchId][index];
    }

    function getPosition(uint256 batchId, bytes32 commitment) external view returns (Position memory) {
        return positionsByCommitment[batchId][commitment];
    }
}
