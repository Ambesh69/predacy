// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./interfaces/IBatchVerifier.sol";
import "./interfaces/IConditionalTokens.sol";

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// @notice EIP-3009 subset — only the function used by BatchVault.
interface IUSDC {
    /// @notice Execute a USDC transfer using a signed off-chain authorization.
    ///         `from` signed (off-chain) to allow this contract to pull `value` USDC.
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

/// @title BatchVault
/// @notice Core contract for Predacy's private prediction market layer.
///
/// Mechanism:
///   1. Traders submit sealed-bid commitments (hashed order details).
///      No USDC is transferred at this stage — the user signs an off-chain
///      EIP-3009 authorization alongside their EIP-712 CommitOrder signature.
///   2. After BATCH_WINDOW seconds, the relayer closes the batch.
///   3. The relayer reveals all orders, computes clearing price off-chain,
///      generates a ZK proof of correctness, and calls settleBatch().
///   4. BatchVault verifies the ZK proof, then pulls USDC from filled buy orders
///      via their stored EIP-3009 authorizations (no upfront deposit needed).
///   5. The vault executes the net position on Polymarket's CTF Exchange.
///   6. Users call claimPosition() with their order preimage to receive payouts.
///
/// Privacy model:
///   - OrderCommitted events reveal ONLY the commitment hash and batch ID.
///     No wallet address, no amount, no direction is exposed at order time.
///   - EIP-3009 Transfer events appear at settlement time — the user's address
///     and amount become visible then (unavoidable: real USDC must move).
///   - Claim time also reveals msg.sender and the order preimage.
///   - Uniqueness is enforced by commitment hash, not trader address.
///   - Users prove ownership at claim time by revealing the preimage.
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
        uint256 totalDeposited;     // Total USDC authorized (buy orders) — moves at settlement
        uint256 totalSellYes;       // Total YES tokens deposited by sellers
        uint256 clearingPrice;      // 6-decimal fixed point (e.g. 650000 = $0.65)
        uint256 netBuyAmount;       // USDC sent to Polymarket (positive = net buy)
        uint256 yesTokensReceived;  // YES shares received from Polymarket
        uint256 filledSellYes;      // YES tokens from filled sell orders (distributed to buyers)
        uint256 totalFilledBuyVol;  // USDC from filled buy orders (denominator for YES share calc)
        uint256 commitmentCount;
        bytes32 commitmentRoot;     // Sequential hash of all commitments (set at settlement)
    }

    /// @notice An order commitment — only the hash and amount are stored.
    ///         No trader address is persisted on-chain; position lookup uses commitment hash.
    struct Commitment {
        bytes32 hash;       // keccak256 of order params (includes trader address in preimage)
        uint256 amount;     // USDC authorized (buy) or YES tokens deposited (sell)
        bool claimed;       // set true after claimPosition
    }

    /// @notice Revealed order (submitted by relayer at settlement)
    struct RevealedOrder {
        address trader;
        bool isBuy;           // true = buy YES (USDC in), false = sell YES (YES tokens in)
        uint256 amount;       // USDC (buy) or YES tokens (sell), 6 decimals
        uint256 limitPrice;   // 6-decimal fixed point
        bytes32 salt;         // Matches the original commitment
    }

    /// @notice EIP-3009 transfer authorization — signed off-chain by the user at order time.
    ///         The relayer submits this at settlement for filled buy orders only.
    ///         Sell orders and unfilled buy orders use a zero-value struct (ignored by contract).
    struct TransferAuth {
        uint256 validAfter;   // 0 = valid immediately
        uint256 validBefore;  // expiry unix timestamp (e.g. order time + 7200s)
        bytes32 nonce;        // random 32 bytes chosen by user (prevents replay)
        uint8   v;            // ECDSA sig component
        bytes32 r;            // ECDSA sig component
        bytes32 s;            // ECDSA sig component
    }

    /// @notice Per-commitment position after settlement
    struct Position {
        uint256 filledAmount;     // Buy: USDC filled. Sell: USDC received.
        uint256 refundAmount;     // Buy: USDC refund (unfilled). Sell: YES tokens returned (unfilled).
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

    /// @notice Ephemeral traders sign this struct to authorize a recipient (real wallet) to
    ///         claim their position via claimPositionFor. This enables the ephemeral wallet
    ///         privacy pattern: trader = ephemeral address (no gas), recipient = real wallet.
    bytes32 public constant CLAIM_AUTH_TYPEHASH = keccak256(
        "ClaimAuth(uint256 batchId,bytes32 commitment,address recipient)"
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
    mapping(bytes32 => uint256) public currentBatchIdByMarket;

    // batchId => Batch
    mapping(uint256 => Batch) public batches;

    // batchId => index => Commitment (stores hash + amount; no trader address)
    mapping(uint256 => mapping(uint256 => Commitment)) public commitments;

    // batchId => commitment hash => Position (set at settlement, no trader address key)
    mapping(uint256 => mapping(bytes32 => Position)) public positionsByCommitment;

    // batchId => commitment hash => index (O(1) lookup)
    mapping(uint256 => mapping(bytes32 => uint256)) public commitmentIndex;

    // batchId => commitment hash => submitted? (uniqueness guard — prevents duplicate hashes)
    mapping(uint256 => mapping(bytes32 => bool)) public hasCommittedHash;

    /// @notice EIP-712 per-signer nonces — incremented on each commitOrderFor / commitSellOrderFor call
    mapping(address => uint256) public nonces;

    // ═══════════════════════════════════════════════════════════════════════
    // Events
    // ═══════════════════════════════════════════════════════════════════════

    event BatchOpened(uint256 indexed batchId, bytes32 indexed marketId, uint256 openedAt);

    /// @notice Emitted when an order is committed.
    ///         Only the commitment hash is revealed — no wallet address, no amount.
    event OrderCommitted(uint256 indexed batchId, bytes32 indexed commitment);

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

    event PositionClaimed(uint256 indexed batchId, address indexed claimer, uint256 yesShares, uint256 refund);
    event VerifierUpdated(address newVerifier);

    // ═══════════════════════════════════════════════════════════════════════
    // Errors
    // ═══════════════════════════════════════════════════════════════════════

    error BatchNotOpen();
    error BatchWindowNotClosed();
    error BatchNotSettling();
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
    // User: submit buy order commitment
    // No USDC is transferred here — users sign an EIP-3009 authorization
    // off-chain; the relayer pulls USDC at settlement for filled orders only.
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice Submit a sealed-bid BUY order directly (via direct call).
    ///         NOTE: This path does NOT transfer USDC upfront.
    ///         The caller must separately provide an EIP-3009 TransferAuth to
    ///         the relayer so it can be submitted at settlement.
    function commitOrder(bytes32 commitment, uint256 amount, bytes32 marketId) external {
        if (amount == 0) revert ZeroAmount();
        _executeCommit(commitment, amount, marketId);
    }

    /// @notice Privacy-preserving BUY commitment via EIP-712 meta-transaction.
    ///
    ///         EIP-3009 privacy model:
    ///           - No USDC transferred at order time — user signs an off-chain
    ///             EIP-3009 TransferWithAuthorization alongside CommitOrder.
    ///           - Relayer submits CommitOrder to the chain (only relayer address visible).
    ///           - USDC is pulled from user's wallet at settlement (filled orders only)
    ///             via IUSDC.transferWithAuthorization — the user's address and amount
    ///             appear on-chain at that point (EIP-3009 trade-off).
    ///           - Only the commitment hash is emitted in the OrderCommitted event.
    ///
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
        // No USDC transfer here — EIP-3009 auth is held off-chain by the relayer
        // and submitted at settlement time for filled orders.
        _executeCommit(commitment, amount, marketId);
    }

    /// @dev Shared logic for commitOrder and commitOrderFor.
    ///      Records the commitment on-chain. No USDC transfer — payment is deferred
    ///      to settlement time via EIP-3009 (for filled buy orders only).
    function _executeCommit(bytes32 commitment, uint256 amount, bytes32 marketId) internal {
        uint256 batchId = currentBatchIdByMarket[marketId];
        Batch storage batch = batches[batchId];
        if (batch.status != BatchStatus.OPEN)         revert BatchNotOpen();
        if (hasCommittedHash[batchId][commitment])     revert DuplicateCommitment();
        if (batch.commitmentCount >= MAX_BATCH_ORDERS) revert MaxOrdersExceeded();

        // NOTE: No USDC transferFrom here — EIP-3009 payment happens at settlement.

        uint256 idx = batch.commitmentCount++;
        commitments[batchId][idx] = Commitment({
            hash:    commitment,
            amount:  amount,
            claimed: false
        });

        hasCommittedHash[batchId][commitment] = true;
        commitmentIndex[batchId][commitment]  = idx;
        batch.totalDeposited += amount; // tracks authorized USDC volume (not yet in vault)

        emit OrderCommitted(batchId, commitment); // no trader address, no amount
    }

    // ═══════════════════════════════════════════════════════════════════════
    // User: submit sell order commitment (YES ERC-1155 token collateral)
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice Submit a sealed-bid SELL order directly (trader = msg.sender).
    ///         Deposits YES ERC-1155 tokens; trader receives USDC at clearing price.
    ///         Requires trader to have called ctf.setApprovalForAll(vault, true) first.
    function commitSellOrder(bytes32 commitment, uint256 yesAmount, bytes32 marketId) external {
        if (yesAmount == 0) revert ZeroAmount();
        _executeCommitSell(commitment, yesAmount, msg.sender, marketId);
    }

    /// @notice Privacy-preserving SELL commitment via EIP-712 meta-transaction.
    ///         NOTE: Sell orders require the user to transfer YES ERC-1155 tokens, so the
    ///         user's address appears in the token transfer (CTF safeTransferFrom). This is
    ///         a known limitation — full sell-order privacy requires a different design.
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

    /// @dev Shared logic for sell order commitments (YES token deposits).
    function _executeCommitSell(bytes32 commitment, uint256 yesAmount, address trader, bytes32 marketId) internal {
        uint256 batchId = currentBatchIdByMarket[marketId];
        Batch storage batch = batches[batchId];
        if (batch.status != BatchStatus.OPEN)         revert BatchNotOpen();
        if (hasCommittedHash[batchId][commitment])     revert DuplicateCommitment();
        if (batch.commitmentCount >= MAX_BATCH_ORDERS) revert MaxOrdersExceeded();

        uint256 yesTokenId = _getYesTokenId(batch.marketId);
        IConditionalTokens(ctf).safeTransferFrom(trader, address(this), yesTokenId, yesAmount, "");

        uint256 idx = batch.commitmentCount++;
        commitments[batchId][idx] = Commitment({
            hash:    commitment,
            amount:  yesAmount,
            claimed: false
        });

        hasCommittedHash[batchId][commitment] = true;
        commitmentIndex[batchId][commitment]  = idx;
        batch.totalSellYes += yesAmount;

        emit OrderCommitted(batchId, commitment); // no trader address, no amount
    }

    // ═══════════════════════════════════════════════════════════════════════
    // ERC-1155 receiver (required to accept YES token deposits)
    // ═══════════════════════════════════════════════════════════════════════

    function onERC1155Received(address, address, uint256, uint256, bytes calldata)
        external pure returns (bytes4)
    {
        return 0xf23a6e61;
    }

    function onERC1155BatchReceived(address, address, uint256[] calldata, uint256[] calldata, bytes calldata)
        external pure returns (bytes4)
    {
        return 0xbc197c81;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Relayer: settle batch with ZK proof
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice Settle a batch — verify ZK proof, collect USDC via EIP-3009 for
    ///         filled buy orders, and execute net position on Polymarket.
    ///
    /// @param auths EIP-3009 transfer authorizations — one per order (same length as orders).
    ///              For sell orders or unfilled buy orders, pass a zero-value struct (ignored).
    ///              For filled buy orders, this authorizes the USDC pull from the user's wallet.
    function settleBatch(
        uint256 batchId,
        RevealedOrder[] calldata orders,
        TransferAuth[] calldata auths,
        uint256 clearingPrice,
        uint256 totalBuyVol,
        uint256 totalSellVol,
        uint256 netBuyAmount,
        uint256 netSellYes,
        bytes calldata proof
    ) external {
        if (msg.sender != relayer) revert OnlyRelayer();

        Batch storage batch = batches[batchId];
        if (batch.status != BatchStatus.SETTLING)                    revert BatchNotSettling();
        if (clearingPrice == 0 || clearingPrice >= PRICE_DECIMALS)   revert InvalidClearingPrice();
        if (orders.length != batch.commitmentCount)                  revert CommitmentMismatch();
        if (auths.length  != orders.length)                          revert CommitmentMismatch();

        // 1. Verify all revealed orders match their on-chain commitment hashes
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

        // 4. Collect USDC from filled buy orders via EIP-3009 transferWithAuthorization.
        //    Only filled buy orders pay — unfilled orders and sell orders are skipped.
        //    This must happen before _executeOnPolymarket (which needs USDC in vault).
        for (uint256 i = 0; i < orders.length; i++) {
            bool orderFills = orders[i].isBuy
                ? orders[i].limitPrice >= clearingPrice
                : orders[i].limitPrice <= clearingPrice;

            if (orders[i].isBuy && orderFills) {
                IUSDC(usdc).transferWithAuthorization(
                    orders[i].trader,   // from: user wallet (revealed at settlement)
                    address(this),      // to: this vault
                    orders[i].amount,   // value: full order amount (all-or-nothing fill)
                    auths[i].validAfter,
                    auths[i].validBefore,
                    auths[i].nonce,
                    auths[i].v,
                    auths[i].r,
                    auths[i].s
                );
            }
        }

        // 5a. Execute net buy on Polymarket (USDC now in vault from step 4)
        uint256 yesTokensReceived = 0;
        if (netBuyAmount > 0) {
            yesTokensReceived = _executeOnPolymarket(batch.marketId, netBuyAmount, clearingPrice);
        }

        // 5b. Execute net sell on Polymarket
        if (netSellYes > 0) {
            _executeSellOnPolymarket(batch.marketId, netSellYes, clearingPrice);
        }

        // 6. Compute per-commitment positions and store them (keyed by commitment hash)
        (uint256 filledBuyVol, uint256 filledSellYes) = _assignPositions(batchId, orders, clearingPrice);

        // 7. Finalize batch state
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

    /// @notice Claim position after batch settlement by revealing the order preimage.
    ///
    ///         Privacy-preserving claim: the user proves they know the preimage of their
    ///         commitment hash by providing (isBuy, amount, limitPrice, salt). The contract
    ///         reconstructs the commitment and looks up the position — no address stored on-chain.
    ///         Payout is sent to msg.sender.
    ///
    /// @param batchId    The settled batch to claim from
    /// @param isBuy      Order direction (true = buy YES, false = sell YES)
    /// @param amount     Collateral deposited (USDC for buys, YES tokens for sells)
    /// @param limitPrice Limit price used in the order (6-decimal fixed point)
    /// @param salt       Random blinding factor chosen at order creation
    function claimPosition(
        uint256 batchId,
        bool isBuy,
        uint256 amount,
        uint256 limitPrice,
        bytes32 salt
    ) external {
        Batch storage batch = batches[batchId];
        if (batch.status != BatchStatus.SETTLED) revert BatchNotSettled();

        // Reconstruct commitment from preimage (same formula as frontend)
        bytes32 commitment = keccak256(
            abi.encode(batch.marketId, isBuy, amount, limitPrice, salt, msg.sender)
        );

        Position storage pos = positionsByCommitment[batchId][commitment];
        if (pos.filledAmount == 0 && pos.refundAmount == 0) revert NothingToClaim();
        if (pos.claimed) revert AlreadyClaimed();

        pos.claimed = true;

        uint256 yesShares = 0;

        if (pos.filledAmount > 0) {
            if (pos.isBuy) {
                uint256 totalYes = batch.yesTokensReceived + batch.filledSellYes;
                if (batch.totalFilledBuyVol > 0 && totalYes > 0) {
                    yesShares = (pos.filledAmount * totalYes) / batch.totalFilledBuyVol;
                }
                if (yesShares > 0) {
                    uint256 yesTokenId = _getYesTokenId(batch.marketId);
                    IConditionalTokens(ctf).safeTransferFrom(address(this), msg.sender, yesTokenId, yesShares, "");
                }
            } else {
                IERC20(usdc).transfer(msg.sender, pos.filledAmount);
            }
        }

        if (pos.refundAmount > 0) {
            if (pos.isBuy) {
                IERC20(usdc).transfer(msg.sender, pos.refundAmount);
            } else {
                uint256 yesTokenId = _getYesTokenId(batch.marketId);
                IConditionalTokens(ctf).safeTransferFrom(address(this), msg.sender, yesTokenId, pos.refundAmount, "");
            }
        }

        emit PositionClaimed(batchId, msg.sender, yesShares, pos.refundAmount);
    }

    /// @notice Claim a position on behalf of an ephemeral trader (the ephemeral wallet pattern).
    ///
    ///         Privacy model:
    ///           - trader = ephemeral address (was used as `trader` in the commitment hash)
    ///           - recipient = real wallet (receives YES tokens / USDC, pays gas for this call)
    ///           - traderSig = ephemeral key's EIP-712 ClaimAuth signature authorizing recipient
    ///
    ///         The ephemeral key never needs POL for gas — only the recipient wallet does.
    ///         The ephemeral private key can be discarded after signing the ClaimAuth at order time.
    ///
    /// @param batchId    The settled batch to claim from
    /// @param isBuy      Order direction (true = buy YES, false = sell YES)
    /// @param amount     Collateral (USDC for buys, YES tokens for sells), 6 decimals
    /// @param limitPrice Limit price (6-decimal fixed point)
    /// @param salt       Random blinding factor chosen at order creation
    /// @param trader     The ephemeral address used as `trader` in the commitment hash
    /// @param recipient  The real wallet that receives the payout (msg.sender, pays gas)
    /// @param traderSig  EIP-712 signature from trader: ClaimAuth(batchId, commitment, recipient)
    function claimPositionFor(
        uint256 batchId,
        bool isBuy,
        uint256 amount,
        uint256 limitPrice,
        bytes32 salt,
        address trader,
        address recipient,
        bytes calldata traderSig
    ) external {
        Batch storage batch = batches[batchId];
        if (batch.status != BatchStatus.SETTLED) revert BatchNotSettled();

        // Reconstruct commitment using the ephemeral trader address
        bytes32 commitment = keccak256(
            abi.encode(batch.marketId, isBuy, amount, limitPrice, salt, trader)
        );

        // Verify that the ephemeral trader signed a ClaimAuth authorizing this specific recipient
        bytes32 structHash = keccak256(abi.encode(CLAIM_AUTH_TYPEHASH, batchId, commitment, recipient));
        bytes32 digest      = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
        address recovered   = _recoverSigner(digest, traderSig);
        if (recovered == address(0) || recovered != trader) revert InvalidSignature();

        Position storage pos = positionsByCommitment[batchId][commitment];
        if (pos.filledAmount == 0 && pos.refundAmount == 0) revert NothingToClaim();
        if (pos.claimed) revert AlreadyClaimed();

        pos.claimed = true;

        uint256 yesShares = 0;

        if (pos.filledAmount > 0) {
            if (pos.isBuy) {
                uint256 totalYes = batch.yesTokensReceived + batch.filledSellYes;
                if (batch.totalFilledBuyVol > 0 && totalYes > 0) {
                    yesShares = (pos.filledAmount * totalYes) / batch.totalFilledBuyVol;
                }
                if (yesShares > 0) {
                    uint256 yesTokenId = _getYesTokenId(batch.marketId);
                    IConditionalTokens(ctf).safeTransferFrom(address(this), recipient, yesTokenId, yesShares, "");
                }
            } else {
                IERC20(usdc).transfer(recipient, pos.filledAmount);
            }
        }

        if (pos.refundAmount > 0) {
            if (pos.isBuy) {
                IERC20(usdc).transfer(recipient, pos.refundAmount);
            } else {
                uint256 yesTokenId = _getYesTokenId(batch.marketId);
                IConditionalTokens(ctf).safeTransferFrom(address(this), recipient, yesTokenId, pos.refundAmount, "");
            }
        }

        emit PositionClaimed(batchId, recipient, yesShares, pos.refundAmount);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Internal helpers
    // ═══════════════════════════════════════════════════════════════════════

    function _verifyCommitments(uint256 batchId, bytes32 marketId, RevealedOrder[] calldata orders) internal view {
        for (uint256 i = 0; i < orders.length; i++) {
            Commitment storage c = commitments[batchId][i];

            // Commitment hash includes trader address — verified without storing it separately
            bytes32 expectedHash = keccak256(
                abi.encode(marketId, orders[i].isBuy, orders[i].amount, orders[i].limitPrice, orders[i].salt, orders[i].trader)
            );

            if (c.hash != expectedHash)           revert CommitmentMismatch();
            if (c.amount != orders[i].amount)     revert CommitmentMismatch();
        }
    }

    function _computeCommitmentRoot(uint256 batchId, uint256 count) internal view returns (bytes32 root) {
        root = bytes32(0);
        for (uint256 i = 0; i < count; i++) {
            root = keccak256(abi.encode(root, commitments[batchId][i].hash));
        }
    }

    /// @notice Assign per-commitment positions based on clearing price.
    ///         Positions are keyed by commitment hash — no trader address stored.
    function _assignPositions(
        uint256 batchId,
        RevealedOrder[] calldata orders,
        uint256 clearingPrice
    ) internal returns (uint256 filledBuyVol, uint256 filledSellYes) {
        Batch storage batch = batches[batchId];
        for (uint256 i = 0; i < orders.length; i++) {
            RevealedOrder calldata o = orders[i];
            uint256 filledAmount = 0;
            uint256 refundAmount = 0;

            bool orderFills = o.isBuy
                ? o.limitPrice >= clearingPrice
                : o.limitPrice <= clearingPrice;

            if (orderFills) {
                if (o.isBuy) {
                    filledAmount = o.amount;
                    filledBuyVol += o.amount;
                } else {
                    filledAmount = o.amount * clearingPrice / PRICE_DECIMALS;
                    filledSellYes += o.amount;
                }
            } else {
                if (!o.isBuy) {
                    // Sell orders: return YES tokens that were deposited upfront
                    refundAmount = o.amount;
                }
                // Buy orders: USDC was never deposited (EIP-3009 deferred payment model).
                // The user's USDC stayed in their wallet — claimPosition returns NothingToClaim.
            }

            // Reconstruct commitment hash to key the position — no address stored
            bytes32 commitment = keccak256(
                abi.encode(batch.marketId, o.isBuy, o.amount, o.limitPrice, o.salt, o.trader)
            );
            positionsByCommitment[batchId][commitment] = Position({
                filledAmount: filledAmount,
                refundAmount: refundAmount,
                isBuy:        o.isBuy,
                claimed:      false
            });
        }
    }

    function _executeOnPolymarket(bytes32 conditionId, uint256 usdcAmount, uint256 clearingPrice) internal returns (uint256 yesTokens) {
        IERC20(usdc).approve(ctf, usdcAmount);
        yesTokens = IConditionalTokens(ctf).mockBuyYes(usdc, conditionId, usdcAmount, clearingPrice);
    }

    function _executeSellOnPolymarket(bytes32 conditionId, uint256 yesAmount, uint256 clearingPrice) internal {
        IConditionalTokens(ctf).mockSellYes(usdc, conditionId, yesAmount, clearingPrice);
    }

    function _getYesTokenId(bytes32 conditionId) internal view returns (uint256) {
        bytes32 collectionId = IConditionalTokens(ctf).getCollectionId(
            bytes32(0),
            conditionId,
            2
        );
        return IConditionalTokens(ctf).getPositionId(usdc, collectionId);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Admin
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

    function setVerifier(address newVerifier) external {
        if (msg.sender != relayer) revert OnlyRelayer();
        verifier = IBatchVerifier(newVerifier);
        emit VerifierUpdated(newVerifier);
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

    /// @notice Get position by commitment hash (not trader address).
    ///         Only the user who knows the commitment preimage can derive this key.
    function getPosition(uint256 batchId, bytes32 commitment) external view returns (Position memory) {
        return positionsByCommitment[batchId][commitment];
    }
}
