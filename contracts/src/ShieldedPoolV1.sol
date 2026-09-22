// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IShieldedPoolERC20 {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

interface IShieldedWithdrawVerifier {
    function verify(bytes calldata proof, bytes32[] calldata publicInputs) external view returns (bool);
}

interface IShieldedPoolCTF {
    function balanceOf(address account, uint256 tokenId) external view returns (uint256);
    function safeTransferFrom(address from, address to, uint256 tokenId, uint256 amount, bytes calldata data) external;
}

interface IShieldedExecutionAdapter {
    function routeBuy(uint256 collateralAmount, uint256 positionTokenId) external;
}

/// @notice Collateral and outcome-token pool for unlinkable private balance notes.
/// @dev Deposits are public, while note ownership and later spends are proven in zero knowledge.
///      Amounts and limits remain hidden. Each locked order's outcome asset and its later
///      membership in a public Polymarket aggregate are visible on-chain.
contract ShieldedPoolV1 {
    uint256 public constant TREE_DEPTH = 20;
    uint256 public constant MAX_LEAVES = 1 << TREE_DEPTH;

    IShieldedPoolERC20 public immutable collateral;
    IShieldedPoolCTF public immutable ctf;
    IShieldedWithdrawVerifier public immutable withdrawVerifier;
    IShieldedWithdrawVerifier public immutable transferVerifier;
    IShieldedWithdrawVerifier public immutable orderVerifier;
    IShieldedWithdrawVerifier public immutable batchVerifier;
    IShieldedExecutionAdapter public immutable executionAdapter;
    address public immutable guardian;
    address public immutable relayer;
    bytes32 public immutable collateralAssetId;

    bool public paused = true;
    uint256 public nextLeafIndex;
    bytes32 public currentRoot;
    uint256 private _entered = 1;

    bytes32[TREE_DEPTH] public zeros;
    bytes32[TREE_DEPTH] public filledSubtrees;
    mapping(bytes32 => bool) public knownRoots;
    mapping(bytes32 => bool) public spentNullifiers;
    mapping(bytes32 => uint256) public liabilities;
    mapping(bytes32 => bytes32) public lockedOrderAsset;
    mapping(bytes32 => bool) public settledOrders;

    struct BuyExecution {
        bytes32 orderSetHash;
        bytes32 positionAssetId;
        uint256 positionTokenId;
        uint256 totalDeposit;
        uint8 orderCount;
        bool active;
    }

    BuyExecution public activeBuy;
    bytes32[2] private _activeBuyOrders;
    bytes32[2] private _activeBuyFullRefunds;

    event NoteDeposited(uint256 indexed leafIndex, bytes32 indexed commitment, bytes32 indexed assetId, uint256 amount);
    event NoteInserted(uint256 indexed leafIndex, bytes32 indexed commitment);
    event NoteWithdrawn(bytes32 indexed nullifier, bytes32 indexed assetId, address indexed recipient, uint256 amount);
    event NotesTransferred(bytes32 indexed nullifier, bytes32 indexed firstCommitment, bytes32 secondCommitment);
    event BuyOrderLocked(bytes32 indexed orderCommitment, bytes32 indexed positionAssetId, bytes32 indexed nullifier);
    event BuyOrderCancelled(bytes32 indexed orderCommitment, bytes32 indexed refundCommitment);
    event BuyBatchRouted(bytes32 indexed orderSetHash, uint256 indexed positionTokenId, uint256 totalDeposit);
    event BuyBatchSettled(bytes32 indexed orderSetHash, uint256 totalSpent, uint256 totalShares, uint256 totalRefund);
    event BuyBatchCancelled(bytes32 indexed orderSetHash);
    event PauseChanged(bool paused);

    error OnlyGuardian();
    error OnlyRelayer();
    error OnlyOperator();
    error Paused();
    error InvalidInput();
    error InvalidRoot();
    error NullifierSpent();
    error ProofInvalid();
    error TransferFailed();
    error TreeFull();
    error Reentrant();
    error ExecutionActive();
    error NoExecution();
    error InsufficientBacking();

    modifier onlyGuardian() {
        if (msg.sender != guardian) revert OnlyGuardian();
        _;
    }

    modifier onlyRelayer() {
        if (msg.sender != relayer) revert OnlyRelayer();
        _;
    }

    modifier onlyOperator() {
        if (msg.sender != relayer && msg.sender != guardian) revert OnlyOperator();
        _;
    }

    modifier whenActive() {
        if (paused) revert Paused();
        _;
    }

    modifier nonReentrant() {
        if (_entered != 1) revert Reentrant();
        _entered = 2;
        _;
        _entered = 1;
    }

    constructor(
        IShieldedPoolERC20 collateral_,
        IShieldedPoolCTF ctf_,
        IShieldedWithdrawVerifier withdrawVerifier_,
        IShieldedWithdrawVerifier transferVerifier_,
        IShieldedWithdrawVerifier orderVerifier_,
        IShieldedWithdrawVerifier batchVerifier_,
        IShieldedExecutionAdapter executionAdapter_,
        address relayer_,
        address guardian_
    ) {
        if (
            address(collateral_) == address(0) || address(ctf_) == address(0)
                || address(withdrawVerifier_) == address(0) || address(transferVerifier_) == address(0)
                || address(orderVerifier_) == address(0) || address(batchVerifier_) == address(0)
                || address(executionAdapter_) == address(0) || relayer_ == address(0) || guardian_ == address(0)
        ) {
            revert InvalidInput();
        }
        collateral = collateral_;
        ctf = ctf_;
        withdrawVerifier = withdrawVerifier_;
        transferVerifier = transferVerifier_;
        orderVerifier = orderVerifier_;
        batchVerifier = batchVerifier_;
        executionAdapter = executionAdapter_;
        relayer = relayer_;
        guardian = guardian_;
        collateralAssetId = keccak256(abi.encode(block.chainid, address(collateral_), uint256(0)));

        bytes32 zero;
        for (uint256 level = 0; level < TREE_DEPTH; level++) {
            zeros[level] = zero;
            filledSubtrees[level] = zero;
            zero = _hashPair(zero, zero);
        }
        currentRoot = zero;
        knownRoots[zero] = true;
    }

    function setPaused(bool value) external onlyGuardian {
        paused = value;
        emit PauseChanged(value);
    }

    /// @notice Deposit collateral into a note controlled by the preimage of `notePublicKey`.
    /// @dev Splitting deposits into standard denominations is handled by the client to reduce
    ///      amount correlation. Amount is bounded to match the withdrawal circuit's u64 value.
    function deposit(uint256 amount, bytes32 notePublicKey)
        external
        whenActive
        nonReentrant
        returns (uint256 leafIndex, bytes32 commitment)
    {
        if (amount == 0 || amount > type(uint64).max || notePublicKey == bytes32(0)) revert InvalidInput();
        commitment = noteCommitment(uint64(amount), notePublicKey);
        leafIndex = _insert(commitment);

        uint256 beforeBalance = collateral.balanceOf(address(this));
        if (!collateral.transferFrom(msg.sender, address(this), amount)) revert TransferFailed();
        if (collateral.balanceOf(address(this)) != beforeBalance + amount) revert TransferFailed();
        liabilities[collateralAssetId] += amount;
        emit NoteDeposited(leafIndex, commitment, collateralAssetId, amount);
    }

    /// @notice Deposit one Polymarket outcome token into a shielded position note.
    function depositPosition(uint256 tokenId, uint256 amount, bytes32 notePublicKey)
        external
        whenActive
        nonReentrant
        returns (uint256 leafIndex, bytes32 commitment)
    {
        if (tokenId == 0 || amount == 0 || amount > type(uint64).max || notePublicKey == bytes32(0)) {
            revert InvalidInput();
        }
        bytes32 assetId = positionAssetId(tokenId);
        commitment = noteCommitmentForAsset(assetId, uint64(amount), notePublicKey);
        leafIndex = _insert(commitment);

        uint256 beforeBalance = ctf.balanceOf(address(this), tokenId);
        ctf.safeTransferFrom(msg.sender, address(this), tokenId, amount, "");
        if (ctf.balanceOf(address(this), tokenId) != beforeBalance + amount) revert TransferFailed();
        liabilities[assetId] += amount;
        emit NoteDeposited(leafIndex, commitment, assetId, amount);
    }

    /// @notice Withdraw a note without revealing which deposit commitment is being spent.
    function withdraw(bytes calldata proof, bytes32 root, bytes32 nullifier, uint256 amount, address recipient)
        external
        whenActive
        nonReentrant
    {
        _authorizeWithdrawal(proof, root, nullifier, collateralAssetId, amount, recipient);
        if (!collateral.transfer(recipient, amount)) revert TransferFailed();
        emit NoteWithdrawn(nullifier, collateralAssetId, recipient, amount);
    }

    /// @notice Withdraw a private outcome-token note to an arbitrary recipient.
    function withdrawPosition(
        bytes calldata proof,
        bytes32 root,
        bytes32 nullifier,
        uint256 tokenId,
        uint256 amount,
        address recipient
    ) external whenActive nonReentrant {
        if (tokenId == 0) revert InvalidInput();
        bytes32 assetId = positionAssetId(tokenId);
        _authorizeWithdrawal(proof, root, nullifier, assetId, amount, recipient);
        ctf.safeTransferFrom(address(this), recipient, tokenId, amount, "");
        emit NoteWithdrawn(nullifier, assetId, recipient, amount);
    }

    /// @notice Privately split or transfer one note into one or two notes of the same hidden asset.
    /// @dev The proof enforces membership, ownership, nullification, asset equality, and value conservation.
    function transferNotes(
        bytes calldata proof,
        bytes32 root,
        bytes32 nullifier,
        bytes32 firstCommitment,
        bytes32 secondCommitment
    ) external whenActive nonReentrant {
        if (!knownRoots[root]) revert InvalidRoot();
        if (spentNullifiers[nullifier]) revert NullifierSpent();
        if (nullifier == bytes32(0) || firstCommitment == bytes32(0)) revert InvalidInput();

        bytes32[] memory publicInputs = new bytes32[](8);
        (publicInputs[0], publicInputs[1]) = _halves(root);
        (publicInputs[2], publicInputs[3]) = _halves(nullifier);
        (publicInputs[4], publicInputs[5]) = _halves(firstCommitment);
        (publicInputs[6], publicInputs[7]) = _halves(secondCommitment);
        if (!transferVerifier.verify(proof, publicInputs)) revert ProofInvalid();

        spentNullifiers[nullifier] = true;
        _insert(firstCommitment);
        if (secondCommitment != bytes32(0)) _insert(secondCommitment);
        emit NotesTransferred(nullifier, firstCommitment, secondCommitment);
    }

    /// @notice Consume a private collateral note into a hidden buy-order commitment.
    /// @dev The proof binds the note amount to the order deposit and binds the order to
    ///      a specific outcome token, hidden limit, and private settlement note keys.
    function lockBuyOrder(
        bytes calldata proof,
        bytes32 root,
        bytes32 nullifier,
        uint256 positionTokenId,
        bytes32 orderCommitment
    ) external whenActive nonReentrant {
        if (!knownRoots[root]) revert InvalidRoot();
        if (spentNullifiers[nullifier]) revert NullifierSpent();
        if (nullifier == bytes32(0) || positionTokenId == 0 || orderCommitment == bytes32(0)) {
            revert InvalidInput();
        }
        if (lockedOrderAsset[orderCommitment] != bytes32(0) || settledOrders[orderCommitment]) revert InvalidInput();

        bytes32 positionAsset = positionAssetId(positionTokenId);
        bytes32[] memory publicInputs = new bytes32[](10);
        (publicInputs[0], publicInputs[1]) = _halves(root);
        (publicInputs[2], publicInputs[3]) = _halves(nullifier);
        (publicInputs[4], publicInputs[5]) = _halves(collateralAssetId);
        (publicInputs[6], publicInputs[7]) = _halves(positionAsset);
        (publicInputs[8], publicInputs[9]) = _halves(orderCommitment);
        if (!orderVerifier.verify(proof, publicInputs)) revert ProofInvalid();

        spentNullifiers[nullifier] = true;
        lockedOrderAsset[orderCommitment] = positionAsset;
        emit BuyOrderLocked(orderCommitment, positionAsset, nullifier);
    }

    /// @notice Recover a locked order into its full-refund note without relying on the relayer.
    /// @dev The batch proof opens the order commitment and proves that the refund note contains
    ///      the entire hidden deposit. The deposit becomes public only when this escape hatch is used.
    function cancelLockedBuyOrder(
        bytes calldata proof,
        uint256 positionTokenId,
        bytes32 orderCommitment,
        bytes32 fullRefundCommitment,
        uint256 totalDeposit
    ) external nonReentrant {
        if (
            activeBuy.active || positionTokenId == 0 || orderCommitment == bytes32(0)
                || fullRefundCommitment == bytes32(0) || totalDeposit == 0
        ) revert InvalidInput();
        bytes32 positionAsset = positionAssetId(positionTokenId);
        if (lockedOrderAsset[orderCommitment] != positionAsset || settledOrders[orderCommitment]) {
            revert InvalidInput();
        }

        bytes32[2] memory orders = [orderCommitment, bytes32(0)];
        bytes32[2] memory refunds = [fullRefundCommitment, bytes32(0)];
        bytes32[2] memory positions;
        bytes32[] memory publicInputs =
            _batchInputsMemory(1, positionAsset, orders, refunds, positions, totalDeposit, 0, 0);
        if (!batchVerifier.verify(proof, publicInputs)) revert ProofInvalid();

        settledOrders[orderCommitment] = true;
        delete lockedOrderAsset[orderCommitment];
        _insert(fullRefundCommitment);
        emit BuyOrderCancelled(orderCommitment, fullRefundCommitment);
    }

    /// @notice Route one proof-authorized aggregate buy to the Polymarket Deposit Wallet.
    /// @dev A zero-fill batch proof proves the hidden deposits sum to `totalDeposit` without
    ///      exposing any individual amount or limit. Output commitments are not inserted yet.
    function startBuyBatch(
        bytes calldata proof,
        uint8 orderCount,
        uint256 positionTokenId,
        bytes32[2] calldata orderCommitments,
        bytes32[2] calldata fullRefundCommitments,
        uint256 totalDeposit
    ) external onlyRelayer whenActive nonReentrant {
        if (activeBuy.active) revert ExecutionActive();
        if (orderCount == 0 || orderCount > 2 || positionTokenId == 0 || totalDeposit == 0) revert InvalidInput();

        bytes32 positionAsset = positionAssetId(positionTokenId);
        _validateOrders(orderCount, positionAsset, orderCommitments);

        bytes32[2] memory zeroPositions;
        bytes32[] memory publicInputs = _batchInputs(
            orderCount, positionAsset, orderCommitments, fullRefundCommitments, zeroPositions, totalDeposit, 0, 0
        );
        if (!batchVerifier.verify(proof, publicInputs)) revert ProofInvalid();
        if (liabilities[collateralAssetId] < totalDeposit) revert InvalidInput();

        bytes32 orderSetHash = keccak256(abi.encode(orderCount, positionTokenId, orderCommitments, totalDeposit));
        activeBuy = BuyExecution({
            orderSetHash: orderSetHash,
            positionAssetId: positionAsset,
            positionTokenId: positionTokenId,
            totalDeposit: totalDeposit,
            orderCount: orderCount,
            active: true
        });
        _activeBuyOrders = orderCommitments;
        _activeBuyFullRefunds = fullRefundCommitments;

        uint256 beforeBalance = collateral.balanceOf(address(executionAdapter));
        if (!collateral.transfer(address(executionAdapter), totalDeposit)) revert TransferFailed();
        if (collateral.balanceOf(address(executionAdapter)) != beforeBalance + totalDeposit) revert TransferFailed();
        executionAdapter.routeBuy(totalDeposit, positionTokenId);
        emit BuyBatchRouted(orderSetHash, positionTokenId, totalDeposit);
    }

    /// @notice Finalize a routed hedge after its returned assets are present in this pool.
    /// @dev The proof privately maps each locked order to refund and position notes. Exact balance
    ///      checks make the transition zero-subsidy: liabilities can never exceed returned assets.
    function settleBuyBatch(
        bytes calldata proof,
        bytes32[2] calldata orderCommitments,
        bytes32[2] calldata refundCommitments,
        bytes32[2] calldata positionCommitments,
        uint256 totalSpent,
        uint256 totalShares
    ) external onlyOperator nonReentrant {
        BuyExecution memory execution = activeBuy;
        if (!execution.active) revert NoExecution();
        if (
            execution.orderSetHash
                != keccak256(
                    abi.encode(
                        execution.orderCount, execution.positionTokenId, orderCommitments, execution.totalDeposit
                    )
                )
        ) revert InvalidInput();
        _validateOrders(execution.orderCount, execution.positionAssetId, orderCommitments);
        if (totalSpent > execution.totalDeposit || totalSpent > liabilities[collateralAssetId]) revert InvalidInput();

        bytes32[] memory publicInputs = _batchInputs(
            execution.orderCount,
            execution.positionAssetId,
            orderCommitments,
            refundCommitments,
            positionCommitments,
            execution.totalDeposit,
            totalSpent,
            totalShares
        );
        if (!batchVerifier.verify(proof, publicInputs)) revert ProofInvalid();

        uint256 newCollateralLiability = liabilities[collateralAssetId] - totalSpent;
        uint256 newPositionLiability = liabilities[execution.positionAssetId] + totalShares;
        if (collateral.balanceOf(address(this)) < newCollateralLiability) revert InsufficientBacking();
        if (ctf.balanceOf(address(this), execution.positionTokenId) < newPositionLiability) {
            revert InsufficientBacking();
        }

        liabilities[collateralAssetId] = newCollateralLiability;
        liabilities[execution.positionAssetId] = newPositionLiability;
        for (uint256 i = 0; i < execution.orderCount; i++) {
            bytes32 order = orderCommitments[i];
            settledOrders[order] = true;
            delete lockedOrderAsset[order];
            if (refundCommitments[i] != bytes32(0)) _insert(refundCommitments[i]);
            if (positionCommitments[i] != bytes32(0)) _insert(positionCommitments[i]);
        }
        delete activeBuy;
        delete _activeBuyOrders;
        delete _activeBuyFullRefunds;
        emit BuyBatchSettled(execution.orderSetHash, totalSpent, totalShares, execution.totalDeposit - totalSpent);
    }

    /// @notice Recover a rejected or timed-out zero-fill execution after all collateral is returned.
    function cancelBuyBatch() external onlyOperator nonReentrant {
        BuyExecution memory execution = activeBuy;
        if (!execution.active) revert NoExecution();
        if (collateral.balanceOf(address(this)) < liabilities[collateralAssetId]) revert InsufficientBacking();
        for (uint256 i = 0; i < execution.orderCount; i++) {
            bytes32 order = _activeBuyOrders[i];
            bytes32 refund = _activeBuyFullRefunds[i];
            if (order == bytes32(0) || refund == bytes32(0)) revert InvalidInput();
            settledOrders[order] = true;
            delete lockedOrderAsset[order];
            _insert(refund);
        }
        delete activeBuy;
        delete _activeBuyOrders;
        delete _activeBuyFullRefunds;
        emit BuyBatchCancelled(execution.orderSetHash);
    }

    function noteCommitment(uint64 amount, bytes32 notePublicKey) public view returns (bytes32) {
        return noteCommitmentForAsset(collateralAssetId, amount, notePublicKey);
    }

    function noteCommitmentForAsset(bytes32 assetId, uint64 amount, bytes32 notePublicKey)
        public
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(bytes32(uint256(1)), assetId, uint256(amount), notePublicKey));
    }

    function positionAssetId(uint256 tokenId) public view returns (bytes32) {
        return keccak256(abi.encode(block.chainid, address(ctf), tokenId));
    }

    function _validateOrders(uint8 orderCount, bytes32 positionAsset, bytes32[2] calldata orders) private view {
        if (orders[0] == bytes32(0) || lockedOrderAsset[orders[0]] != positionAsset) revert InvalidInput();
        if (orderCount == 2) {
            if (orders[1] == bytes32(0) || orders[1] == orders[0] || lockedOrderAsset[orders[1]] != positionAsset) {
                revert InvalidInput();
            }
        } else if (orders[1] != bytes32(0)) {
            revert InvalidInput();
        }
    }

    function _batchInputs(
        uint8 orderCount,
        bytes32 positionAsset,
        bytes32[2] calldata orders,
        bytes32[2] calldata refunds,
        bytes32[2] memory positions,
        uint256 totalDeposit,
        uint256 totalSpent,
        uint256 totalShares
    ) private view returns (bytes32[] memory inputs) {
        return _batchInputsMemory(
            orderCount, positionAsset, orders, refunds, positions, totalDeposit, totalSpent, totalShares
        );
    }

    function _batchInputsMemory(
        uint8 orderCount,
        bytes32 positionAsset,
        bytes32[2] memory orders,
        bytes32[2] memory refunds,
        bytes32[2] memory positions,
        uint256 totalDeposit,
        uint256 totalSpent,
        uint256 totalShares
    ) private view returns (bytes32[] memory inputs) {
        if (totalDeposit > type(uint64).max || totalSpent > type(uint64).max || totalShares > type(uint64).max) {
            revert InvalidInput();
        }
        inputs = new bytes32[](20);
        inputs[0] = bytes32(uint256(orderCount));
        (inputs[1], inputs[2]) = _halves(collateralAssetId);
        (inputs[3], inputs[4]) = _halves(positionAsset);
        for (uint256 i = 0; i < 2; i++) {
            (inputs[5 + i], inputs[7 + i]) = _halves(orders[i]);
            (inputs[9 + i], inputs[11 + i]) = _halves(refunds[i]);
            (inputs[13 + i], inputs[15 + i]) = _halves(positions[i]);
        }
        inputs[17] = bytes32(totalDeposit);
        inputs[18] = bytes32(totalSpent);
        inputs[19] = bytes32(totalShares);
    }

    function _authorizeWithdrawal(
        bytes calldata proof,
        bytes32 root,
        bytes32 nullifier,
        bytes32 assetId,
        uint256 amount,
        address recipient
    ) private {
        if (!knownRoots[root]) revert InvalidRoot();
        if (spentNullifiers[nullifier]) revert NullifierSpent();
        if (nullifier == bytes32(0) || amount == 0 || amount > type(uint64).max || recipient == address(0)) {
            revert InvalidInput();
        }
        if (liabilities[assetId] < amount) revert InvalidInput();

        bytes32[] memory publicInputs = new bytes32[](9);
        (publicInputs[0], publicInputs[1]) = _halves(root);
        (publicInputs[2], publicInputs[3]) = _halves(nullifier);
        (publicInputs[4], publicInputs[5]) = _halves(assetId);
        publicInputs[6] = bytes32(amount);
        bytes32 withdrawalBinding =
            keccak256(abi.encode(bytes32(uint256(3)), root, nullifier, assetId, amount, recipient));
        (publicInputs[7], publicInputs[8]) = _halves(withdrawalBinding);
        if (!withdrawVerifier.verify(proof, publicInputs)) revert ProofInvalid();

        spentNullifiers[nullifier] = true;
        liabilities[assetId] -= amount;
    }

    function _insert(bytes32 leaf) private returns (uint256 leafIndex) {
        leafIndex = nextLeafIndex;
        if (leafIndex >= MAX_LEAVES) revert TreeFull();
        nextLeafIndex = leafIndex + 1;

        uint256 index = leafIndex;
        bytes32 current = leaf;
        for (uint256 level = 0; level < TREE_DEPTH; level++) {
            if ((index & 1) == 0) {
                filledSubtrees[level] = current;
                current = _hashPair(current, zeros[level]);
            } else {
                current = _hashPair(filledSubtrees[level], current);
            }
            index >>= 1;
        }
        currentRoot = current;
        knownRoots[current] = true;
        emit NoteInserted(leafIndex, leaf);
    }

    function _hashPair(bytes32 left, bytes32 right) private pure returns (bytes32) {
        return keccak256(abi.encodePacked(left, right));
    }

    function _halves(bytes32 value) private pure returns (bytes32 high, bytes32 low) {
        high = bytes32(uint256(value) >> 128);
        low = bytes32(uint256(value) & type(uint128).max);
    }

    function onERC1155Received(address, address, uint256, uint256, bytes calldata) external view returns (bytes4) {
        if (msg.sender != address(ctf)) revert InvalidInput();
        return this.onERC1155Received.selector;
    }
}
