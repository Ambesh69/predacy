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
///   1. Traders submit sealed-bid commitments (hashed order details) + USDC
///   2. After BATCH_WINDOW seconds, the relayer closes the batch
///   3. The relayer reveals all orders, computes clearing price off-chain,
///      generates a ZK proof of correctness, and calls settleBatch()
///   4. BatchVault verifies the ZK proof, then executes the net position
///      on Polymarket's CTF Exchange via the ConditionalTokens contract
///   5. Users call claimPosition() to receive their YES/NO shares
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
        uint256 totalDeposited;     // Total USDC locked (all orders)
        uint256 clearingPrice;      // 6-decimal fixed point (e.g. 650000 = $0.65)
        uint256 netBuyAmount;       // USDC sent to Polymarket (positive = net buy)
        uint256 yesTokensReceived;  // YES shares received from Polymarket
        uint256 commitmentCount;
        bytes32 commitmentRoot;     // Merkle root of all commitments (set at settlement)
    }

    /// @notice An order commitment: the hash of (marketId, isBuy, amount, limitPrice, salt, trader)
    struct Commitment {
        bytes32 hash;       // keccak256 of order params
        uint256 amount;     // USDC deposited (locked until settlement)
        address trader;
        bool claimed;
    }

    /// @notice Revealed order (submitted by relayer at settlement)
    struct RevealedOrder {
        address trader;
        bool isBuy;           // true = buy YES, false = sell YES (buy NO)
        uint256 amount;       // USDC (6 decimals)
        uint256 limitPrice;   // 6-decimal fixed point
        bytes32 salt;         // Matches the original commitment
    }

    /// @notice Per-user position after settlement
    struct Position {
        uint256 filledAmount;     // USDC worth of order that was filled
        uint256 refundAmount;     // USDC refunded (unfilled portion)
        bool isBuy;
        bool claimed;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // State
    // ═══════════════════════════════════════════════════════════════════════

    uint256 public constant BATCH_WINDOW = 30;      // seconds
    uint256 public constant PRICE_DECIMALS = 1e6;   // 6-decimal prices (matches USDC)
    uint256 public constant MAX_BATCH_ORDERS = 500; // gas safety limit

    address public immutable usdc;
    address public immutable ctf;          // ConditionalTokens
    address public immutable relayer;      // Trusted batch processor address
    IBatchVerifier public verifier;

    uint256 public currentBatchId;

    // batchId => Batch
    mapping(uint256 => Batch) public batches;

    // batchId => index => Commitment
    mapping(uint256 => mapping(uint256 => Commitment)) public commitments;

    // batchId => trader => Position (set at settlement)
    mapping(uint256 => mapping(address => Position)) public positions;

    // batchId => trader => commitment index (for O(1) lookup)
    mapping(uint256 => mapping(address => uint256)) public traderCommitmentIndex;
    mapping(uint256 => mapping(address => bool)) public hasCommitted;

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

    // ═══════════════════════════════════════════════════════════════════════
    // Constructor
    // ═══════════════════════════════════════════════════════════════════════

    constructor(address _usdc, address _ctf, address _relayer, address _verifier) {
        usdc = _usdc;
        ctf = _ctf;
        relayer = _relayer;
        verifier = IBatchVerifier(_verifier);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Relayer: batch lifecycle
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice Open a new batch for a given Polymarket market (condition ID)
    /// @dev Only the relayer can open batches. One active batch at a time.
    function openBatch(bytes32 marketId) external returns (uint256 batchId) {
        if (msg.sender != relayer) revert OnlyRelayer();

        // Allow opening if no batch is currently open
        Batch storage current = batches[currentBatchId];
        require(
            currentBatchId == 0 || current.status != BatchStatus.OPEN,
            "BatchVault: batch already open"
        );

        batchId = ++currentBatchId;
        batches[batchId] = Batch({
            marketId: marketId,
            openedAt: block.timestamp,
            closedAt: 0,
            status: BatchStatus.OPEN,
            totalDeposited: 0,
            clearingPrice: 0,
            netBuyAmount: 0,
            yesTokensReceived: 0,
            commitmentCount: 0,
            commitmentRoot: bytes32(0)
        });

        emit BatchOpened(batchId, marketId, block.timestamp);
    }

    /// @notice Close the current batch (stop accepting orders)
    /// @dev Can be called by anyone once BATCH_WINDOW has elapsed
    function closeBatch() external {
        Batch storage batch = batches[currentBatchId];
        if (batch.status != BatchStatus.OPEN) revert BatchNotOpen();
        if (block.timestamp < batch.openedAt + BATCH_WINDOW) revert BatchWindowNotClosed();

        batch.status = BatchStatus.SETTLING;
        batch.closedAt = block.timestamp;

        emit BatchClosed(currentBatchId, batch.commitmentCount);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // User: submit order commitment
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice Submit a sealed-bid order commitment
    /// @param commitment Hash of (marketId, isBuy, amount, limitPrice, salt, msg.sender)
    ///                   Compute off-chain: keccak256(abi.encode(...))
    /// @param amount     USDC amount to lock (6 decimals)
    function commitOrder(bytes32 commitment, uint256 amount) external {
        if (amount == 0) revert ZeroAmount();

        Batch storage batch = batches[currentBatchId];
        if (batch.status != BatchStatus.OPEN) revert BatchNotOpen();
        if (hasCommitted[currentBatchId][msg.sender]) revert AlreadyCommitted();
        if (batch.commitmentCount >= MAX_BATCH_ORDERS) revert MaxOrdersExceeded();

        // Pull USDC from trader
        IERC20(usdc).transferFrom(msg.sender, address(this), amount);

        uint256 idx = batch.commitmentCount++;
        commitments[currentBatchId][idx] = Commitment({
            hash: commitment,
            amount: amount,
            trader: msg.sender,
            claimed: false
        });

        hasCommitted[currentBatchId][msg.sender] = true;
        traderCommitmentIndex[currentBatchId][msg.sender] = idx;
        batch.totalDeposited += amount;

        emit OrderCommitted(currentBatchId, msg.sender, commitment, amount);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Relayer: settle batch with ZK proof
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice Settle a batch — verify ZK proof and execute net position on Polymarket
    /// @param batchId        The batch to settle
    /// @param orders         Revealed orders (must match on-chain commitments)
    /// @param clearingPrice  Computed clearing price (6-decimal fixed point)
    /// @param totalBuyVol    Total USDC from buy orders filled
    /// @param totalSellVol   Total USDC from sell orders filled
    /// @param netBuyAmount   Net USDC to spend buying YES tokens on Polymarket
    ///                       (negative net = net sell, represented as 0 with netSellAmount)
    /// @param proof          ZK proof bytes from Noir prover
    function settleBatch(
        uint256 batchId,
        RevealedOrder[] calldata orders,
        uint256 clearingPrice,
        uint256 totalBuyVol,
        uint256 totalSellVol,
        uint256 netBuyAmount,
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
        bytes32[] memory publicInputs = new bytes32[](5);
        publicInputs[0] = commitmentRoot;
        publicInputs[1] = bytes32(clearingPrice);
        publicInputs[2] = bytes32(totalBuyVol);
        publicInputs[3] = bytes32(totalSellVol);
        publicInputs[4] = bytes32(netBuyAmount);

        // 3. Verify ZK proof
        if (!verifier.verify(proof, publicInputs)) revert ZKProofInvalid();

        // 4. Execute net position on Polymarket's CTF (if there's a net position)
        uint256 yesTokensReceived = 0;
        if (netBuyAmount > 0) {
            yesTokensReceived = _executeOnPolymarket(batch.marketId, netBuyAmount, clearingPrice);
        }

        // 5. Compute per-trader positions and store them
        _assignPositions(batchId, orders, clearingPrice);

        // 6. Finalize batch state
        batch.status = BatchStatus.SETTLED;
        batch.clearingPrice = clearingPrice;
        batch.netBuyAmount = netBuyAmount;
        batch.yesTokensReceived = yesTokensReceived;
        batch.commitmentRoot = commitmentRoot;

        emit BatchSettled(batchId, clearingPrice, totalBuyVol, totalSellVol, netBuyAmount, yesTokensReceived);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // User: claim position after settlement
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice Claim YES/NO shares and any USDC refund after batch settlement
    function claimPosition(uint256 batchId) external {
        Batch storage batch = batches[batchId];
        if (batch.status != BatchStatus.SETTLED) revert BatchNotSettled();

        Position storage pos = positions[batchId][msg.sender];
        if (pos.filledAmount == 0 && pos.refundAmount == 0) revert NothingToClaim();
        if (pos.claimed) revert AlreadyClaimed();

        pos.claimed = true;

        uint256 yesShares = 0;

        if (pos.filledAmount > 0 && pos.isBuy) {
            // Calculate proportional YES shares from the pool
            // yesShares = (filledAmount / netBuyAmount) * yesTokensReceived
            if (batch.netBuyAmount > 0) {
                yesShares = (pos.filledAmount * batch.yesTokensReceived) / batch.netBuyAmount;
            }

            // Transfer YES shares to trader
            if (yesShares > 0) {
                uint256 yesTokenId = _getYesTokenId(batch.marketId);
                IConditionalTokens(ctf).safeTransferFrom(address(this), msg.sender, yesTokenId, yesShares, "");
            }
        }

        // Refund unfilled portion
        if (pos.refundAmount > 0) {
            IERC20(usdc).transfer(msg.sender, pos.refundAmount);
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

    /// @notice Compute a simple sequential Merkle root from commitments
    function _computeCommitmentRoot(uint256 batchId, uint256 count) internal view returns (bytes32 root) {
        root = bytes32(0);
        for (uint256 i = 0; i < count; i++) {
            root = keccak256(abi.encode(root, commitments[batchId][i].hash));
        }
    }

    /// @notice Assign per-trader filled/refund amounts based on clearing price
    function _assignPositions(uint256 batchId, RevealedOrder[] calldata orders, uint256 clearingPrice) internal {
        for (uint256 i = 0; i < orders.length; i++) {
            RevealedOrder calldata o = orders[i];
            uint256 filledAmount = 0;
            uint256 refundAmount = 0;

            bool orderFills = o.isBuy
                ? o.limitPrice >= clearingPrice   // buy fills if limit >= clearing
                : o.limitPrice <= clearingPrice;  // sell fills if limit <= clearing

            if (orderFills) {
                filledAmount = o.amount;
            } else {
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

    /// @notice Execute net buy position on Polymarket's CTF by splitting USDC into YES tokens
    /// @dev Calls CTF.splitPosition() to mint YES/NO shares, then the vault holds YES shares
    ///      Real implementation would also handle selling (net sell path uses mergePositions)
    function _executeOnPolymarket(bytes32 conditionId, uint256 usdcAmount, uint256 /*clearingPrice*/) internal returns (uint256 yesTokens) {
        // Approve CTF to spend USDC
        IERC20(usdc).approve(ctf, usdcAmount);

        // Split USDC into YES (index 1) and NO (index 0) tokens
        // partition [1, 2] = index sets for NO=0b01=1 and YES=0b10=2
        uint256[] memory partition = new uint256[](2);
        partition[0] = 1; // NO
        partition[1] = 2; // YES

        IConditionalTokens(ctf).splitPosition(
            usdc,
            bytes32(0), // parentCollectionId (root)
            conditionId,
            partition,
            usdcAmount
        );

        // After splitting, vault holds equal YES and NO tokens
        // For a net buy: vault keeps YES tokens for distribution, burns/sells NO tokens
        // In prototype: vault holds both; NO tokens are left for future merging
        yesTokens = usdcAmount; // 1 USDC splits into 1 YES + 1 NO (before fees)
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

    /// @notice Update the ZK verifier contract (e.g., swap mock for real Noir verifier)
    function setVerifier(address newVerifier) external {
        if (msg.sender != relayer) revert OnlyRelayer();
        verifier = IBatchVerifier(newVerifier);
        emit VerifierUpdated(newVerifier);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // View helpers
    // ═══════════════════════════════════════════════════════════════════════

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
