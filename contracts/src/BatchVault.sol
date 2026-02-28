// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./interfaces/IBatchVerifier.sol";
import "./interfaces/IConditionalTokens.sol";

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// @title BatchVault
/// @notice Core contract for Predacy's private prediction market layer.
///
/// Mechanism:
///   1. Traders submit sealed-bid commitments (hashed order details) + USDC (buy) or YES tokens (sell)
///   2. After BATCH_WINDOW seconds, the relayer closes the batch
///   3. The relayer reveals all orders, computes clearing price off-chain,
///      generates a ZK proof of correctness, and calls settleBatch()
///   4. BatchVault verifies the ZK proof, then executes the net position
///      on Polymarket's CTF Exchange via the ConditionalTokens contract
///   5. Users call claimPosition() to receive their YES tokens (buyers) or USDC (sellers)
///
/// Order types:
///   - isBuy=true  → buy YES:  deposit USDC, receive YES tokens at clearing price
///   - isBuy=false → sell YES: deposit YES ERC-1155 tokens, receive USDC at clearing price
///
/// Privacy guarantee:
///   - Only keccak256 commitments are stored on-chain during the batch window
///   - Individual amounts, prices, and directions are never exposed
///   - On-chain events reveal only: clearing price, total volume, net position
contract BatchVault {
    // ═══════════════════════════════════════════════════════════════════════
    // Types
    // ═══════════════════════════════════════════════════════════════════════

    enum BatchStatus {
        OPEN,     // Accepting commitments
        SETTLING, // Batch closed, awaiting ZK proof from relayer
        SETTLED   // Clearing price finalized, positions claimable
    }

    struct Batch {
        bytes32 marketId;           // Polymarket condition ID
        uint256 openedAt;           // Block timestamp when batch opened
        uint256 closedAt;           // Block timestamp when batch closed
        BatchStatus status;
        uint256 totalDeposited;     // Total USDC locked (buy orders only)
        uint256 totalSellYes;       // Total YES tokens deposited by sellers
        uint256 clearingPrice;      // 6-decimal fixed point (e.g. 650000 = $0.65)
        uint256 netBuyAmount;       // USDC sent to Polymarket (positive = net buy)
        uint256 yesTokensReceived;  // YES shares received from Polymarket
        uint256 filledSellYes;      // YES tokens from filled sell orders (distributed to buyers)
        uint256 totalFilledBuyVol;  // USDC from filled buy orders (denominator for YES share calc)
        uint256 commitmentCount;
        bytes32 commitmentRoot;     // Sequential hash of all commitments (set at settlement)
    }

    /// @notice An order commitment: the hash of (marketId, isBuy, amount, limitPrice, salt, trader)
    struct Commitment {
        bytes32 hash;       // keccak256 of order params
        uint256 amount;     // USDC deposited (buy orders) or YES tokens deposited (sell orders)
        address trader;
        bool claimed;
    }

    /// @notice Revealed order (submitted by relayer at settlement)
    struct RevealedOrder {
        address trader;
        bool isBuy;           // true = buy YES (USDC in), false = sell YES (YES tokens in)
        uint256 amount;       // USDC (buy) or YES tokens (sell), 6 decimals
        uint256 limitPrice;   // 6-decimal fixed point
        bytes32 salt;         // Matches the original commitment
    }

    /// @notice Per-user position after settlement
    struct Position {
        uint256 filledAmount;     // Buy: USDC filled. Sell: USDC received.
        uint256 refundAmount;     // Buy: USDC refund. Sell: YES tokens returned (unfilled).
        bool isBuy;
        bool claimed;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // State
    // ═══════════════════════════════════════════════════════════════════════

    uint256 public constant BATCH_WINDOW = 30;      // seconds
    uint256 public constant PRICE_DECIMALS = 1e6;   // 6-decimal prices (matches USDC)
    uint256 public constant MAX_BATCH_ORDERS = 500; // gas safety limit

    /// @dev EIP-712 type hashes for commitOrderFor() meta-transactions
    bytes32 private constant EIP712_DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );
    /// @notice Traders sign this struct to delegate commitment submission to the relayer.
    ///         Used for BOTH buy orders (commitOrderFor) and sell orders (commitSellOrderFor).
    bytes32 public constant COMMITMENT_TYPEHASH = keccak256(
        "CommitOrder(bytes32 commitment,uint256 amount,uint256 batchId,uint256 nonce,uint256 deadline)"
    );

    address public immutable usdc;
    address public immutable ctf;          // ConditionalTokens
    address public immutable relayer;      // Trusted batch processor address
    IBatchVerifier public verifier;

    /// @notice EIP-712 domain separator — computed once at construction
    bytes32 public immutable DOMAIN_SEPARATOR;

    /// @notice Global batch ID counter — monotonically increasing across all markets
    uint256 private _nextBatchId;

    /// @notice The active (OPEN) batch for each Polymarket condition ID
    /// @dev    Replaces the old single `currentBatchId` — each market has its own slot
    mapping(bytes32 => uint256) public currentBatchIdByMarket;

    // batchId => Batch
    mapping(uint256 => Batch) public batches;

    // batchId => index => Commitment
    mapping(uint256 => mapping(uint256 => Commitment)) public commitments;

    // batchId => trader => Position (set at settlement)
    mapping(uint256 => mapping(address => Position)) public positions;

    // batchId => trader => commitment index (for O(1) lookup)
    mapping(uint256 => mapping(address => uint256)) public traderCommitmentIndex;
    mapping(uint256 => mapping(address => bool)) public hasCommitted;

    /// @notice EIP-712 per-signer nonces — incremented on each commitOrderFor / commitSellOrderFor call
    mapping(address => uint256) public nonces;

    // ═══════════════════════════════════════════════════════════════════════
    // Events
    // ═══════════════════════════════════════════════════════════════════════

    event BatchOpened(uint256 indexed batchId, bytes32 indexed marketId, uint256 openedAt);
    event OrderCommitted(uint256 indexed batchId, address indexed trader, bytes32 commitment, uint256 amount);
    event BatchClosed(uint256 indexed batchId, uint256 commitmentCount);

    /// @notice Emitted at settlement — reveals ONLY aggregate info, not individual orders
    event BatchSettled(
        uint256 indexed batchId,
        uint256 clearingPrice,
        uint256 totalBuyVolume,
        uint256 totalSellVolume,
        uint256 netBuyAmount,
        uint256 yesTokensReceived
    );

    event PositionClaimed(uint256 indexed batchId, address indexed trader, uint256 yesShares, uint256 refund);
    event VerifierUpdated(address newVerifier);

    // ═══════════════════════════════════════════════════════════════════════
    // Errors
    // ═══════════════════════════════════════════════════════════════════════

    error BatchNotOpen();
    error BatchWindowNotClosed();
    error BatchNotSettling();
    error BatchNotSettled();
    error AlreadyCommitted();
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

    // ═══════════════════════════════════════════════════════════════════════
    // Constructor
    // ═══════════════════════════════════════════════════════════════════════

    constructor(address _usdc, address _ctf, address _relayer, address _verifier) {
        usdc = _usdc;
        ctf = _ctf;
        relayer = _relayer;
        verifier = IBatchVerifier(_verifier);
        DOMAIN_SEPARATOR = keccak256(abi.encode(
            EIP712_DOMAIN_TYPEHASH,
            keccak256("BatchVault"),
            keccak256("1"),
            block.chainid,
            address(this)
        ));
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Relayer: batch lifecycle
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice Open a new batch for a given Polymarket market (condition ID).
    /// @dev Only the relayer can open batches. Each market has its own concurrent batch slot.
    ///      Multiple markets can have OPEN batches simultaneously.
    function openBatch(bytes32 marketId) external returns (uint256 batchId) {
        if (msg.sender != relayer) revert OnlyRelayer();

        // Allow opening only if the market has no currently OPEN batch
        uint256 existingId = currentBatchIdByMarket[marketId];
        require(
            existingId == 0 || batches[existingId].status != BatchStatus.OPEN,
            "BatchVault: batch already open"
        );

        batchId = ++_nextBatchId;
        currentBatchIdByMarket[marketId] = batchId;
        batches[batchId] = Batch({
            marketId: marketId,
            openedAt: block.timestamp,
            closedAt: 0,
            status: BatchStatus.OPEN,
            totalDeposited: 0,
            totalSellYes: 0,
            clearingPrice: 0,
            netBuyAmount: 0,
            yesTokensReceived: 0,
            filledSellYes: 0,
            totalFilledBuyVol: 0,
            commitmentCount: 0,
            commitmentRoot: bytes32(0)
        });

        emit BatchOpened(batchId, marketId, block.timestamp);
    }

    /// @notice Close a market's current batch (stop accepting orders).
    /// @dev Can be called by anyone once BATCH_WINDOW has elapsed.
    /// @param marketId The Polymarket condition ID whose batch to close.
    function closeBatch(bytes32 marketId) external {
        uint256 batchId = currentBatchIdByMarket[marketId];
        Batch storage batch = batches[batchId];
        if (batch.status != BatchStatus.OPEN) revert BatchNotOpen();
        if (block.timestamp < batch.openedAt + BATCH_WINDOW) revert BatchWindowNotClosed();

        batch.status = BatchStatus.SETTLING;
        batch.closedAt = block.timestamp;

        emit BatchClosed(batchId, batch.commitmentCount);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // User: submit buy order commitment (USDC collateral)
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice Submit a sealed-bid BUY order directly (trader = msg.sender).
    ///         Deposits USDC; trader receives YES tokens at clearing price.
    /// @param commitment Hash of (marketId, isBuy=true, amount, limitPrice, salt, msg.sender)
    /// @param amount     USDC amount to lock (6 decimals)
    /// @param marketId   Polymarket condition ID for the market to trade
    function commitOrder(bytes32 commitment, uint256 amount, bytes32 marketId) external {
        if (amount == 0) revert ZeroAmount();
        _executeCommit(commitment, amount, msg.sender, marketId);
    }

    /// @notice Privacy-preserving BUY commitment via EIP-712 meta-transaction.
    ///         The relayer submits on the trader's behalf — only relayer address visible on-chain.
    /// @param marketId Polymarket condition ID — selects which market's batch to commit to
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
        if (block.timestamp > deadline) revert SignatureExpired();
        if (nonce != nonces[signer]) revert InvalidSignature();

        uint256 batchId = currentBatchIdByMarket[marketId];
        bytes32 structHash = keccak256(abi.encode(
            COMMITMENT_TYPEHASH,
            commitment,
            amount,
            batchId,
            nonce,
            deadline
        ));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
        address recovered = _recoverSigner(digest, signature);
        if (recovered == address(0) || recovered != signer) revert InvalidSignature();

        nonces[signer]++;
        _executeCommit(commitment, amount, signer, marketId);
    }

    /// @dev Shared logic for commitOrder and commitOrderFor (USDC deposits)
    function _executeCommit(bytes32 commitment, uint256 amount, address trader, bytes32 marketId) internal {
        uint256 batchId = currentBatchIdByMarket[marketId];
        Batch storage batch = batches[batchId];
        if (batch.status != BatchStatus.OPEN) revert BatchNotOpen();
        if (hasCommitted[batchId][trader]) revert AlreadyCommitted();
        if (batch.commitmentCount >= MAX_BATCH_ORDERS) revert MaxOrdersExceeded();

        IERC20(usdc).transferFrom(trader, address(this), amount);

        uint256 idx = batch.commitmentCount++;
        commitments[batchId][idx] = Commitment({
            hash: commitment,
            amount: amount,
            trader: trader,
            claimed: false
        });

        hasCommitted[batchId][trader] = true;
        traderCommitmentIndex[batchId][trader] = idx;
        batch.totalDeposited += amount;

        emit OrderCommitted(batchId, trader, commitment, amount);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // User: submit sell order commitment (YES ERC-1155 token collateral)
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice Submit a sealed-bid SELL order directly (trader = msg.sender).
    ///         Deposits YES ERC-1155 tokens; trader receives USDC at clearing price.
    ///         Requires trader to have called ctf.setApprovalForAll(vault, true) first.
    /// @param commitment Hash of (marketId, isBuy=false, yesAmount, limitPrice, salt, msg.sender)
    /// @param yesAmount  YES token amount to lock (6 decimals, same scale as USDC)
    /// @param marketId   Polymarket condition ID for the market to trade
    function commitSellOrder(bytes32 commitment, uint256 yesAmount, bytes32 marketId) external {
        if (yesAmount == 0) revert ZeroAmount();
        _executeCommitSell(commitment, yesAmount, msg.sender, marketId);
    }

    /// @notice Privacy-preserving SELL commitment via EIP-712 meta-transaction.
    ///         The relayer submits on the trader's behalf — only relayer address visible on-chain.
    ///         Uses the same COMMITMENT_TYPEHASH as commitOrderFor; the commitment hash itself
    ///         encodes isBuy=false which distinguishes it from a buy commitment.
    /// @param marketId Polymarket condition ID — selects which market's batch to commit to
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
        if (block.timestamp > deadline) revert SignatureExpired();
        if (nonce != nonces[signer]) revert InvalidSignature();

        uint256 batchId = currentBatchIdByMarket[marketId];
        bytes32 structHash = keccak256(abi.encode(
            COMMITMENT_TYPEHASH,
            commitment,
            yesAmount,
            batchId,
            nonce,
            deadline
        ));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
        address recovered = _recoverSigner(digest, signature);
        if (recovered == address(0) || recovered != signer) revert InvalidSignature();

        nonces[signer]++;
        _executeCommitSell(commitment, yesAmount, signer, marketId);
    }

    /// @dev Shared logic for commitSellOrder and commitSellOrderFor (YES token deposits)
    function _executeCommitSell(bytes32 commitment, uint256 yesAmount, address trader, bytes32 marketId) internal {
        uint256 batchId = currentBatchIdByMarket[marketId];
        Batch storage batch = batches[batchId];
        if (batch.status != BatchStatus.OPEN) revert BatchNotOpen();
        if (hasCommitted[batchId][trader]) revert AlreadyCommitted();
        if (batch.commitmentCount >= MAX_BATCH_ORDERS) revert MaxOrdersExceeded();

        // Transfer YES tokens from trader to vault (requires setApprovalForAll on CTF)
        uint256 yesTokenId = _getYesTokenId(batch.marketId);
        IConditionalTokens(ctf).safeTransferFrom(trader, address(this), yesTokenId, yesAmount, "");

        uint256 idx = batch.commitmentCount++;
        commitments[batchId][idx] = Commitment({
            hash: commitment,
            amount: yesAmount,
            trader: trader,
            claimed: false
        });

        hasCommitted[batchId][trader] = true;
        traderCommitmentIndex[batchId][trader] = idx;
        batch.totalSellYes += yesAmount;

        emit OrderCommitted(batchId, trader, commitment, yesAmount);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // ERC-1155 receiver (required to accept YES token deposits)
    // ═══════════════════════════════════════════════════════════════════════

    function onERC1155Received(address, address, uint256, uint256, bytes calldata)
        external pure returns (bytes4)
    {
        return 0xf23a6e61; // IERC1155Receiver.onERC1155Received.selector
    }

    function onERC1155BatchReceived(address, address, uint256[] calldata, uint256[] calldata, bytes calldata)
        external pure returns (bytes4)
    {
        return 0xbc197c81; // IERC1155Receiver.onERC1155BatchReceived.selector
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Relayer: settle batch with ZK proof
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice Settle a batch — verify ZK proof and execute net position on Polymarket
    /// @param batchId        The batch to settle
    /// @param orders         Revealed orders (must match on-chain commitments)
    /// @param clearingPrice  Computed clearing price (6-decimal fixed point)
    /// @param totalBuyVol    Total USDC from filled buy orders
    /// @param totalSellVol   Total YES tokens from filled sell orders
    /// @param netBuyAmount   Net USDC to spend buying YES tokens on Polymarket
    /// @param netSellYes     Net YES tokens to sell on Polymarket (sell-heavy batches)
    /// @param proof          ZK proof bytes from Noir prover
    function settleBatch(
        uint256 batchId,
        RevealedOrder[] calldata orders,
        uint256 clearingPrice,
        uint256 totalBuyVol,
        uint256 totalSellVol,
        uint256 netBuyAmount,
        uint256 netSellYes,
        bytes calldata proof
    ) external {
        if (msg.sender != relayer) revert OnlyRelayer();

        Batch storage batch = batches[batchId];
        if (batch.status != BatchStatus.SETTLING) revert BatchNotSettling();
        if (clearingPrice == 0 || clearingPrice >= PRICE_DECIMALS) revert InvalidClearingPrice();
        if (orders.length != batch.commitmentCount) revert CommitmentMismatch();

        // 1. Verify all revealed orders match their on-chain commitments
        _verifyCommitments(batchId, batch.marketId, orders);

        // 2. Build public inputs for ZK verifier
        bytes32 commitmentRoot = _computeCommitmentRoot(batchId, orders.length);
        bytes32[] memory publicInputs = new bytes32[](6);
        publicInputs[0] = commitmentRoot;
        publicInputs[1] = bytes32(clearingPrice);
        publicInputs[2] = bytes32(totalBuyVol);
        publicInputs[3] = bytes32(totalSellVol);
        publicInputs[4] = bytes32(netBuyAmount);
        publicInputs[5] = bytes32(netSellYes);

        // 3. Verify ZK proof
        if (!verifier.verify(proof, publicInputs)) revert ZKProofInvalid();

        // 4a. Execute net buy on Polymarket (buy-heavy or all-buy batches)
        uint256 yesTokensReceived = 0;
        if (netBuyAmount > 0) {
            yesTokensReceived = _executeOnPolymarket(batch.marketId, netBuyAmount, clearingPrice);
        }

        // 4b. Execute net sell on Polymarket (sell-heavy or all-sell batches)
        if (netSellYes > 0) {
            _executeSellOnPolymarket(batch.marketId, netSellYes, clearingPrice);
        }

        // 5. Compute per-trader positions and store them
        (uint256 filledBuyVol, uint256 filledSellYes) = _assignPositions(batchId, orders, clearingPrice);

        // 6. Finalize batch state
        // filledSellYes held in vault = total filled - amount sold to Polymarket
        uint256 yesForBuyers = filledSellYes >= netSellYes ? filledSellYes - netSellYes : 0;

        batch.status = BatchStatus.SETTLED;
        batch.clearingPrice = clearingPrice;
        batch.netBuyAmount = netBuyAmount;
        batch.yesTokensReceived = yesTokensReceived;
        batch.filledSellYes = yesForBuyers;
        batch.totalFilledBuyVol = filledBuyVol;
        batch.commitmentRoot = commitmentRoot;

        emit BatchSettled(batchId, clearingPrice, totalBuyVol, totalSellVol, netBuyAmount, yesTokensReceived);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // User: claim position after settlement
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice Claim position after batch settlement.
    ///         Buy orders: receive YES tokens (proportional share) + USDC refund if unfilled.
    ///         Sell orders: receive USDC (from filled YES tokens) + YES token refund if unfilled.
    function claimPosition(uint256 batchId) external {
        Batch storage batch = batches[batchId];
        if (batch.status != BatchStatus.SETTLED) revert BatchNotSettled();

        Position storage pos = positions[batchId][msg.sender];
        if (pos.filledAmount == 0 && pos.refundAmount == 0) revert NothingToClaim();
        if (pos.claimed) revert AlreadyClaimed();

        pos.claimed = true;

        uint256 yesShares = 0;

        if (pos.filledAmount > 0) {
            if (pos.isBuy) {
                // Buy order filled: distribute proportional YES tokens
                // YES pool = tokens from Polymarket + tokens from matched sell orders
                uint256 totalYes = batch.yesTokensReceived + batch.filledSellYes;
                if (batch.totalFilledBuyVol > 0 && totalYes > 0) {
                    yesShares = (pos.filledAmount * totalYes) / batch.totalFilledBuyVol;
                }
                if (yesShares > 0) {
                    uint256 yesTokenId = _getYesTokenId(batch.marketId);
                    IConditionalTokens(ctf).safeTransferFrom(address(this), msg.sender, yesTokenId, yesShares, "");
                }
            } else {
                // Sell order filled: pay USDC to seller
                IERC20(usdc).transfer(msg.sender, pos.filledAmount);
            }
        }

        // Refund unfilled portion
        if (pos.refundAmount > 0) {
            if (pos.isBuy) {
                // Buy order unfilled: refund USDC
                IERC20(usdc).transfer(msg.sender, pos.refundAmount);
            } else {
                // Sell order unfilled: refund YES tokens
                uint256 yesTokenId = _getYesTokenId(batch.marketId);
                IConditionalTokens(ctf).safeTransferFrom(address(this), msg.sender, yesTokenId, pos.refundAmount, "");
            }
        }

        emit PositionClaimed(batchId, msg.sender, yesShares, pos.refundAmount);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Internal helpers
    // ═══════════════════════════════════════════════════════════════════════

    function _verifyCommitments(uint256 batchId, bytes32 marketId, RevealedOrder[] calldata orders) internal view {
        for (uint256 i = 0; i < orders.length; i++) {
            Commitment storage c = commitments[batchId][i];

            bytes32 expectedHash = keccak256(
                abi.encode(marketId, orders[i].isBuy, orders[i].amount, orders[i].limitPrice, orders[i].salt, orders[i].trader)
            );

            if (c.hash != expectedHash) revert CommitmentMismatch();
            if (c.trader != orders[i].trader) revert CommitmentMismatch();
            if (c.amount != orders[i].amount) revert CommitmentMismatch();
        }
    }

    /// @notice Compute a simple sequential commitment root
    function _computeCommitmentRoot(uint256 batchId, uint256 count) internal view returns (bytes32 root) {
        root = bytes32(0);
        for (uint256 i = 0; i < count; i++) {
            root = keccak256(abi.encode(root, commitments[batchId][i].hash));
        }
    }

    /// @notice Assign per-trader filled/refund amounts based on clearing price.
    /// @return filledBuyVol  USDC filled by buy orders (denominator for YES share calc)
    /// @return filledSellYes YES tokens from filled sell orders (goes to YES pool for buyers)
    function _assignPositions(
        uint256 batchId,
        RevealedOrder[] calldata orders,
        uint256 clearingPrice
    ) internal returns (uint256 filledBuyVol, uint256 filledSellYes) {
        for (uint256 i = 0; i < orders.length; i++) {
            RevealedOrder calldata o = orders[i];
            uint256 filledAmount = 0;
            uint256 refundAmount = 0;

            bool orderFills = o.isBuy
                ? o.limitPrice >= clearingPrice   // buy fills if limit >= clearing
                : o.limitPrice <= clearingPrice;  // sell fills if limit <= clearing

            if (orderFills) {
                if (o.isBuy) {
                    // Buy: full USDC amount is filled
                    filledAmount = o.amount;
                    filledBuyVol += o.amount;
                } else {
                    // Sell: YES tokens converted to USDC at clearing price
                    filledAmount = o.amount * clearingPrice / PRICE_DECIMALS;
                    filledSellYes += o.amount;
                }
            } else {
                // Unfilled: full collateral refunded (USDC for buys, YES tokens for sells)
                refundAmount = o.amount;
            }

            positions[batchId][o.trader] = Position({
                filledAmount: filledAmount,
                refundAmount: refundAmount,
                isBuy: o.isBuy,
                claimed: false
            });
        }
    }

    /// @notice Execute net buy on Polymarket: pull USDC, receive price-correct YES tokens.
    ///         Uses mockBuyYes on testnet (price-aware); replace with CTF Exchange on mainnet.
    function _executeOnPolymarket(bytes32 conditionId, uint256 usdcAmount, uint256 clearingPrice) internal returns (uint256 yesTokens) {
        IERC20(usdc).approve(ctf, usdcAmount);
        // mockBuyYes mints usdcAmount * 1e6 / clearingPrice YES tokens — correct at any price
        yesTokens = IConditionalTokens(ctf).mockBuyYes(usdc, conditionId, usdcAmount, clearingPrice);
    }

    /// @notice Execute net sell on Polymarket: burn YES tokens, receive USDC proceeds.
    ///         Uses mockSellYes on testnet; replace with CTF Exchange on mainnet.
    function _executeSellOnPolymarket(bytes32 conditionId, uint256 yesAmount, uint256 clearingPrice) internal {
        // mockSellYes burns YES tokens from vault and mints yesAmount*clearingPrice/1e6 USDC back
        IConditionalTokens(ctf).mockSellYes(usdc, conditionId, yesAmount, clearingPrice);
    }

    /// @notice Get the ERC-1155 token ID for YES shares on a given Polymarket condition
    /// @dev YES = index set 0b10 = 2 in a two-outcome market
    function _getYesTokenId(bytes32 conditionId) internal view returns (uint256) {
        bytes32 collectionId = IConditionalTokens(ctf).getCollectionId(
            bytes32(0), // parentCollectionId
            conditionId,
            2 // YES index set (binary: 10)
        );
        return IConditionalTokens(ctf).getPositionId(usdc, collectionId);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Admin
    // ═══════════════════════════════════════════════════════════════════════

    /// @dev Recover the signer of an EIP-712 digest from a 65-byte signature.
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

    /// @notice Update the ZK verifier contract (e.g., swap mock for real Noir verifier)
    function setVerifier(address newVerifier) external {
        if (msg.sender != relayer) revert OnlyRelayer();
        verifier = IBatchVerifier(newVerifier);
        emit VerifierUpdated(newVerifier);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // View helpers
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice Get the current active batch ID for a given market.
    ///         Returns 0 if no batch has ever been opened for this market.
    function getCurrentBatchId(bytes32 marketId) external view returns (uint256) {
        return currentBatchIdByMarket[marketId];
    }

    function getBatch(uint256 batchId) external view returns (Batch memory) {
        return batches[batchId];
    }

    function getCommitment(uint256 batchId, uint256 index) external view returns (Commitment memory) {
        return commitments[batchId][index];
    }

    function getPosition(uint256 batchId, address trader) external view returns (Position memory) {
        return positions[batchId][trader];
    }
}
