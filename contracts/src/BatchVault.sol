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
///   6. Users call claimWithProof() with a ZK claim proof to receive payouts
///      at a recipient address of their choice — their identity is never revealed.
///
/// Privacy model (post Fix #2):
///   - OrderCommitted events reveal ONLY the commitment hash and batch ID.
///     No wallet address, no amount, no direction is exposed at order time.
///   - Commitment = keccak256(marketId, isBuy, amount, limitPrice, salt).
///     No trader address — the 256-bit salt is the secret credential.
///   - settleBatch calldata contains RevealedOrder WITHOUT trader addresses.
///   - EIP-3009 Transfer: ephemeral→vault (not Alice's real address).
///   - claimWithProof: relayer submits ZK proof, payout goes to chosen recipient.
///     Alice's address never appears on-chain at claim time.
///   - Remaining link: Transfer(Alice→ephemeral) at order funding (Fix #1 target).
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
        bytes32 commitmentRoot;     // Sequential hash chain of commitments (for batch clearing ZK)
        bytes32 claimMerkleRoot;    // Standard binary Merkle root (for ZK claim proofs)
    }

    /// @notice An order commitment — only the hash and amount are stored.
    ///         No trader address is persisted on-chain; position lookup uses commitment hash.
    struct Commitment {
        bytes32 hash;       // keccak256(marketId, isBuy, amount, limitPrice, salt) — NO trader address
        uint256 amount;     // USDC authorized (buy) or YES tokens deposited (sell)
        bool claimed;       // set true after claimPosition (direct claims)
    }

    /// @notice Revealed order (submitted by relayer at settlement).
    ///         No trader address — the 256-bit salt is the secret credential.
    struct RevealedOrder {
        bool isBuy;           // true = buy YES (USDC in), false = sell YES (YES tokens in)
        uint256 amount;       // USDC (buy) or YES tokens (sell), 6 decimals
        uint256 limitPrice;   // 6-decimal fixed point
        bytes32 salt;         // Matches the original commitment
    }

    /// @notice EIP-3009 transfer authorization — signed off-chain by the user at order time.
    ///         The relayer submits this at settlement for filled buy orders only.
    ///         Sell orders and unfilled buy orders use a zero-value struct (ignored by contract).
    struct TransferAuth {
        address from;         // The address whose USDC is being pulled (ephemeral wallet)
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
        uint256 refundAmount;     // Buy: 0 (EIP-3009 deferred). Sell: YES tokens returned (unfilled).
        bool isBuy;
        bool claimed;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // State
    // ═══════════════════════════════════════════════════════════════════════

    uint256 public constant BATCH_WINDOW = 30;      // seconds
    uint256 public constant PRICE_DECIMALS = 1e6;   // 6-decimal prices (matches USDC)
    uint256 public constant MAX_BATCH_ORDERS = 500; // gas safety limit

    /// @dev EIP-712 type hashes for meta-transactions
    bytes32 private constant EIP712_DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );
    /// @notice Traders sign this struct to delegate commitment submission to the relayer.
    ///         Used for BOTH buy orders (commitOrderFor) and sell orders (commitSellOrderFor).
    ///
    /// @dev  v6 change: batchId removed from the signed message.
    ///       Previously the sig was batch-specific, which prevented the relayer from
    ///       resubmitting excluded orders to the next batch without a fresh user signature.
    ///       Now the sig is valid for whichever batch is currently open for the given marketId,
    ///       so the frontend can pre-sign 2 requeue sigs (nonce+1, nonce+2) at submission time
    ///       and the relayer auto-requeues excluded buy orders — zero extra UX friction.
    bytes32 public constant COMMITMENT_TYPEHASH = keccak256(
        "CommitOrder(bytes32 commitment,uint256 amount,uint256 nonce,uint256 deadline)"
    );

    address public immutable usdc;
    address public immutable ctf;          // ConditionalTokens
    address public immutable relayer;      // Trusted batch processor address
    IBatchVerifier public verifier;        // ZK verifier for batch clearing proofs
    IBatchVerifier public claimVerifier;   // ZK verifier for ZK claim proofs

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

    // batchId => commitment hash => submitted? (uniqueness guard)
    mapping(uint256 => mapping(bytes32 => bool)) public hasCommittedHash;

    /// @notice EIP-712 per-signer nonces — incremented on each commitOrderFor / commitSellOrderFor call
    mapping(address => uint256) public nonces;

    /// @notice ZK claim nullifiers — prevents double-claim via claimWithProof.
    ///         nullifier = keccak256(abi.encode(commitment, batchId, salt))
    mapping(bytes32 => bool) public usedNullifiers;

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
    event ClaimVerifierUpdated(address newClaimVerifier);

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
    error ClaimVerifierNotSet();

    // ═══════════════════════════════════════════════════════════════════════
    // Constructor
    // ═══════════════════════════════════════════════════════════════════════

    /// @param _verifier      ZK verifier for batch clearing proofs
    /// @param _claimVerifier ZK verifier for claim proofs (pass address(0) to set later via setClaimVerifier)
    constructor(
        address _usdc,
        address _ctf,
        address _relayer,
        address _verifier,
        address _claimVerifier
    ) {
        usdc = _usdc;
        ctf = _ctf;
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
            marketId:        marketId,
            openedAt:        block.timestamp,
            closedAt:        0,
            status:          BatchStatus.OPEN,
            totalDeposited:  0,
            totalSellYes:    0,
            clearingPrice:   0,
            netBuyAmount:    0,
            yesTokensReceived: 0,
            filledSellYes:   0,
            totalFilledBuyVol: 0,
            commitmentCount: 0,
            commitmentRoot:  bytes32(0),
            claimMerkleRoot: bytes32(0)
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

    function commitOrder(bytes32 commitment, uint256 amount, bytes32 marketId) external {
        if (amount == 0) revert ZeroAmount();
        _executeCommit(commitment, amount, marketId);
    }

    /// @notice Privacy-preserving BUY commitment via EIP-712 meta-transaction.
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

        bytes32 structHash = keccak256(abi.encode(
            COMMITMENT_TYPEHASH,
            commitment,
            amount,
            nonce,
            deadline
        ));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
        address recovered = _recoverSigner(digest, signature);
        if (recovered == address(0) || recovered != signer) revert InvalidSignature();

        nonces[signer]++;
        _executeCommit(commitment, amount, marketId);
    }

    function _executeCommit(bytes32 commitment, uint256 amount, bytes32 marketId) internal {
        uint256 batchId = currentBatchIdByMarket[marketId];
        Batch storage batch = batches[batchId];
        if (batch.status != BatchStatus.OPEN)         revert BatchNotOpen();
        if (hasCommittedHash[batchId][commitment])     revert DuplicateCommitment();
        if (batch.commitmentCount >= MAX_BATCH_ORDERS) revert MaxOrdersExceeded();

        uint256 idx = batch.commitmentCount++;
        commitments[batchId][idx] = Commitment({
            hash:    commitment,
            amount:  amount,
            claimed: false
        });

        hasCommittedHash[batchId][commitment] = true;
        commitmentIndex[batchId][commitment]  = idx;
        batch.totalDeposited += amount;

        emit OrderCommitted(batchId, commitment);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // User: submit sell order commitment (YES ERC-1155 token collateral)
    // ═══════════════════════════════════════════════════════════════════════

    function commitSellOrder(bytes32 commitment, uint256 yesAmount, bytes32 marketId) external {
        if (yesAmount == 0) revert ZeroAmount();
        _executeCommitSell(commitment, yesAmount, msg.sender, marketId);
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
        if (block.timestamp > deadline) revert SignatureExpired();
        if (nonce != nonces[signer]) revert InvalidSignature();

        bytes32 structHash = keccak256(abi.encode(
            COMMITMENT_TYPEHASH,
            commitment,
            yesAmount,
            nonce,
            deadline
        ));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
        address recovered = _recoverSigner(digest, signature);
        if (recovered == address(0) || recovered != signer) revert InvalidSignature();

        nonces[signer]++;
        _executeCommitSell(commitment, yesAmount, signer, marketId);
    }

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

        emit OrderCommitted(batchId, commitment);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // ERC-1155 receiver (required to accept YES token deposits)
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
    // Relayer: settle batch with ZK proof
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice Settle a batch — verify ZK proof, collect USDC via EIP-3009 for
    ///         filled buy orders, and execute net position on Polymarket.
    ///
    /// @param auths EIP-3009 transfer authorizations — one per order (same length as orders).
    ///              For sell orders or unfilled buy orders, pass a zero-value struct (ignored).
    ///              For filled buy orders: auth.from = ephemeral wallet address.
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

        // 2. Build public inputs for batch clearing ZK verifier
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

        // 4. Collect USDC from filled buy orders via EIP-3009.
        //    auth.from = ephemeral wallet (not Alice's real address).
        for (uint256 i = 0; i < orders.length; i++) {
            bool orderFills = orders[i].isBuy
                ? orders[i].limitPrice >= clearingPrice
                : orders[i].limitPrice <= clearingPrice;

            if (orders[i].isBuy && orderFills) {
                IUSDC(usdc).transferWithAuthorization(
                    auths[i].from,        // ephemeral wallet address
                    address(this),
                    orders[i].amount,
                    auths[i].validAfter,
                    auths[i].validBefore,
                    auths[i].nonce,
                    auths[i].v,
                    auths[i].r,
                    auths[i].s
                );
            }
        }

        // 5a. Execute net buy on Polymarket
        uint256 yesTokensReceived = 0;
        if (netBuyAmount > 0) {
            yesTokensReceived = _executeOnPolymarket(batch.marketId, netBuyAmount, clearingPrice);
        }

        // 5b. Execute net sell on Polymarket
        if (netSellYes > 0) {
            _executeSellOnPolymarket(batch.marketId, netSellYes, clearingPrice);
        }

        // 6. Compute per-commitment positions (keyed by commitment hash, no trader address)
        (uint256 filledBuyVol, uint256 filledSellYes) = _assignPositions(batchId, orders, clearingPrice);

        // 7. Build binary Merkle root for ZK claim proofs
        bytes32 claimMerkleRoot = _buildMerkleRoot(batchId, orders.length);

        // 8. Finalize batch state
        uint256 yesForBuyers = filledSellYes >= netSellYes ? filledSellYes - netSellYes : 0;

        batch.status            = BatchStatus.SETTLED;
        batch.clearingPrice     = clearingPrice;
        batch.netBuyAmount      = netBuyAmount;
        batch.yesTokensReceived = yesTokensReceived;
        batch.filledSellYes     = yesForBuyers;
        batch.totalFilledBuyVol = filledBuyVol;
        batch.commitmentRoot    = commitmentRoot;
        batch.claimMerkleRoot   = claimMerkleRoot;

        emit BatchSettled(batchId, clearingPrice, totalBuyVol, totalSellVol, netBuyAmount, yesTokensReceived);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // User: ZK-private claim (primary path for buy orders)
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice Claim a position using a ZK proof — Alice's address is never revealed.
    ///
    ///         Privacy model:
    ///           - The relayer generates the ZK proof server-side using Alice's private
    ///             order preimage (marketId, isBuy, amount, limitPrice, salt).
    ///           - The proof shows Merkle membership WITHOUT revealing which leaf is Alice's,
    ///             and verifies the payout WITHOUT revealing her identity.
    ///           - msg.sender = the relayer (Alice never sends this tx).
    ///           - The recipient can be any address Alice specifies (e.g. a fresh wallet).
    ///
    ///         Public inputs layout (bytes32[] — 11 field elements):
    ///           [0]  batch_id            must equal batchId param
    ///           [1]  commitment_root_hi  high 128 bits of batch.claimMerkleRoot
    ///           [2]  commitment_root_lo  low  128 bits of batch.claimMerkleRoot
    ///           [3]  clearing_price      must equal batch.clearingPrice
    ///           [4]  nullifier_hi        high 128 bits of nullifier
    ///           [5]  nullifier_lo        low  128 bits of nullifier
    ///           [6]  recipient           address packed right-aligned in bytes32
    ///           [7]  fills               0 or 1
    ///           [8]  fill_amount         USDC or YES token payout
    ///           [9]  refund_amount       YES tokens for unfilled sell; 0 for buy
    ///           [10] is_buy              0 or 1
    ///
    ///         bytes32 values are split into two u128 halves so each field element
    ///         fits in the BN254 scalar field (~254 bits).  Reconstructed here as:
    ///           bytes32 v = bytes32((uint256(hi) << 128) | uint256(lo))
    function claimWithProof(
        uint256 batchId,
        bytes calldata proof,
        bytes32[] calldata publicInputs
    ) external {
        if (address(claimVerifier) == address(0)) revert ClaimVerifierNotSet();

        Batch storage batch = batches[batchId];
        if (batch.status != BatchStatus.SETTLED) revert BatchNotSettled();
        if (publicInputs.length != 11) revert CommitmentMismatch();

        // Reconstruct bytes32 values from hi/lo u128 pairs
        bytes32 claimMerkleRoot = bytes32((uint256(publicInputs[1]) << 128) | uint256(publicInputs[2]));
        bytes32 nullifier       = bytes32((uint256(publicInputs[4]) << 128) | uint256(publicInputs[5]));

        // Verify public inputs match on-chain state
        if (uint256(publicInputs[0]) != batchId)      revert CommitmentMismatch();
        if (claimMerkleRoot != batch.claimMerkleRoot)  revert CommitmentMismatch();
        if (uint256(publicInputs[3]) != batch.clearingPrice) revert CommitmentMismatch();

        // Verify ZK proof
        if (!claimVerifier.verify(proof, publicInputs)) revert ZKProofInvalid();

        // Nullifier check (prevents double-claim)
        if (usedNullifiers[nullifier]) revert AlreadyClaimed();
        usedNullifiers[nullifier] = true;

        // Decode remaining public inputs
        address recipient    = address(uint160(uint256(publicInputs[6])));
        bool fills           = uint256(publicInputs[7]) == 1;
        uint256 fillAmount   = uint256(publicInputs[8]);
        uint256 refundAmount = uint256(publicInputs[9]);
        bool isBuy           = uint256(publicInputs[10]) == 1;

        uint256 yesShares = 0;

        if (fills && fillAmount > 0) {
            if (isBuy) {
                uint256 totalYes = batch.yesTokensReceived + batch.filledSellYes;
                if (batch.totalFilledBuyVol > 0 && totalYes > 0) {
                    yesShares = (fillAmount * totalYes) / batch.totalFilledBuyVol;
                }
                if (yesShares > 0) {
                    uint256 yesTokenId = _getYesTokenId(batch.marketId);
                    IConditionalTokens(ctf).safeTransferFrom(address(this), recipient, yesTokenId, yesShares, "");
                }
            } else {
                // Filled sell: USDC proceeds to recipient
                IERC20(usdc).transfer(recipient, fillAmount);
            }
        }

        if (!fills && refundAmount > 0) {
            if (!isBuy) {
                // Unfilled sell: return YES tokens to recipient
                uint256 yesTokenId = _getYesTokenId(batch.marketId);
                IConditionalTokens(ctf).safeTransferFrom(address(this), recipient, yesTokenId, refundAmount, "");
            }
            // Unfilled buy: EIP-3009 deferred — USDC was never deposited, nothing to refund.
            // (Circuit enforces refundAmount == 0 for unfilled buys.)
        }

        emit PositionClaimed(batchId, recipient, yesShares, refundAmount);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // User: direct claim (primarily for sell orders)
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice Claim position by revealing the order preimage. Primarily for SELL orders.
    ///         Buy order holders should prefer claimWithProof() to preserve privacy.
    ///
    ///         Commitment = keccak256(marketId, isBuy, amount, limitPrice, salt) — no trader address.
    ///         Payout sent to msg.sender.
    ///
    ///         WARNING: This function's preimage (including salt) appears in calldata and is
    ///         visible in the mempool before confirmation. Frontrunners who observe a pending
    ///         claimPosition call can copy it and claim the payout to their own address first.
    ///         Use claimWithProof() (the ZK path via the relayer) to avoid this risk.
    function claimPosition(
        uint256 batchId,
        bool isBuy,
        uint256 amount,
        uint256 limitPrice,
        bytes32 salt
    ) external {
        Batch storage batch = batches[batchId];
        if (batch.status != BatchStatus.SETTLED) revert BatchNotSettled();

        // Reconstruct commitment (no trader address — same formula as frontend commitmentHash.ts)
        bytes32 commitment = keccak256(
            abi.encode(batch.marketId, isBuy, amount, limitPrice, salt)
        );

        // Compute nullifier — cross-checks with claimWithProof to prevent double-claiming
        // across both claim paths. Must match the nullifier formula in the claim circuit.
        bytes32 nullifier = keccak256(abi.encode(commitment, batchId, salt));
        if (usedNullifiers[nullifier]) revert AlreadyClaimed();

        Position storage pos = positionsByCommitment[batchId][commitment];
        if (pos.filledAmount == 0 && pos.refundAmount == 0) revert NothingToClaim();
        if (pos.claimed) revert AlreadyClaimed();

        pos.claimed = true;
        usedNullifiers[nullifier] = true;

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
            if (!pos.isBuy) {
                uint256 yesTokenId = _getYesTokenId(batch.marketId);
                IConditionalTokens(ctf).safeTransferFrom(address(this), msg.sender, yesTokenId, pos.refundAmount, "");
            }
            // Unfilled buy: should not occur with EIP-3009 deferred model (USDC never deposited)
        }

        emit PositionClaimed(batchId, msg.sender, yesShares, pos.refundAmount);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Internal helpers
    // ═══════════════════════════════════════════════════════════════════════

    /// @dev Verify each revealed order matches its on-chain commitment.
    ///      Hash = keccak256(marketId, isBuy, amount, limitPrice, salt) — NO trader address.
    function _verifyCommitments(uint256 batchId, bytes32 marketId, RevealedOrder[] calldata orders) internal view {
        for (uint256 i = 0; i < orders.length; i++) {
            Commitment storage c = commitments[batchId][i];

            bytes32 expectedHash = keccak256(
                abi.encode(marketId, orders[i].isBuy, orders[i].amount, orders[i].limitPrice, orders[i].salt)
            );

            if (c.hash != expectedHash)           revert CommitmentMismatch();
            if (c.amount != orders[i].amount)     revert CommitmentMismatch();
        }
    }

    /// @dev Sequential hash chain — used by batch clearing ZK proof.
    function _computeCommitmentRoot(uint256 batchId, uint256 count) internal view returns (bytes32 root) {
        root = bytes32(0);
        for (uint256 i = 0; i < count; i++) {
            root = keccak256(abi.encode(root, commitments[batchId][i].hash));
        }
    }

    /// @dev Standard binary Merkle tree — used by ZK claim proofs.
    ///      Always builds a 512-leaf tree (2^DEPTH, DEPTH=9 in claim circuit).
    ///      Unfilled slots are bytes32(0). MAX_BATCH_ORDERS=500 < 512.
    ///      Internal nodes: keccak256(abi.encode(left, right)).
    function _buildMerkleRoot(uint256 batchId, uint256 count) internal view returns (bytes32) {
        if (count == 0) return bytes32(0);

        uint256 n = 512; // must match DEPTH=9 in circuits/claim/src/main.nr

        bytes32[] memory nodes = new bytes32[](2 * n);
        for (uint256 i = 0; i < count; i++) {
            nodes[n + i] = commitments[batchId][i].hash;
        }
        for (uint256 i = n - 1; i > 0; i--) {
            nodes[i] = keccak256(abi.encode(nodes[2 * i], nodes[2 * i + 1]));
        }
        return nodes[1];
    }

    /// @dev Assign per-commitment positions based on clearing price.
    ///      Keyed by commitment hash — no trader address stored.
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
                    refundAmount = o.amount; // YES tokens returned for unfilled sells
                }
                // Unfilled buy: USDC never deposited (EIP-3009 deferred), nothing to refund
            }

            // Key by commitment hash — no trader address
            bytes32 commitment = keccak256(
                abi.encode(batch.marketId, o.isBuy, o.amount, o.limitPrice, o.salt)
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
    // Emergency: rescue stuck sell-order deposits
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice 7-day grace period after closedAt before rescue is permitted.
    uint256 public constant RESCUE_DELAY = 7 days;

    /// @notice Emergency rescue for sell-order depositors when a batch is stuck in SETTLING.
    ///
    ///         If the relayer fails to call settleBatch within RESCUE_DELAY after closedAt,
    ///         sell-order holders can recover their YES tokens by revealing their preimage.
    ///         This is a safety valve only — honest relayers will never leave batches stuck.
    ///
    ///         Only valid for SELL orders (sell orders transfer YES tokens upfront).
    ///         Buy orders use EIP-3009 deferred transfer — no USDC is ever held by the vault.
    function rescueStuckSellOrder(
        uint256 batchId,
        uint256 amount,
        uint256 limitPrice,
        bytes32 salt
    ) external {
        Batch storage batch = batches[batchId];
        require(batch.status == BatchStatus.SETTLING, "BatchVault: batch not stuck");
        require(
            batch.closedAt > 0 && block.timestamp >= batch.closedAt + RESCUE_DELAY,
            "BatchVault: rescue delay not elapsed"
        );

        bytes32 commitment = keccak256(
            abi.encode(batch.marketId, false, amount, limitPrice, salt)
        );

        Commitment storage c = commitments[batchId][commitmentIndex[batchId][commitment]];
        require(c.hash == commitment && !c.claimed, "BatchVault: invalid or already rescued");
        c.claimed = true;

        uint256 yesTokenId = _getYesTokenId(batch.marketId);
        IConditionalTokens(ctf).safeTransferFrom(address(this), msg.sender, yesTokenId, amount, "");
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

    function setClaimVerifier(address newClaimVerifier) external {
        if (msg.sender != relayer) revert OnlyRelayer();
        claimVerifier = IBatchVerifier(newClaimVerifier);
        emit ClaimVerifierUpdated(newClaimVerifier);
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
    function getPosition(uint256 batchId, bytes32 commitment) external view returns (Position memory) {
        return positionsByCommitment[batchId][commitment];
    }
}
