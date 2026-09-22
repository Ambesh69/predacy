// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IShieldedPoolV2ERC20 {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

interface IShieldedPoolV2Verifier {
    function verify(bytes calldata proof, bytes32[] calldata publicInputs) external view returns (bool);
}

interface IShieldedPoolV2CTF {
    function balanceOf(address account, uint256 tokenId) external view returns (uint256);
    function safeTransferFrom(address from, address to, uint256 tokenId, uint256 amount, bytes calldata data) external;
}

interface IShieldedPoolV2ExecutionAdapter {
    function routeBuy(uint256 collateralAmount, uint256 positionTokenId) external;
}

/// @notice V13 shielded pool with unlinkable generic order notes.
/// @dev Individual order details are hidden and a routed order is identified only by a
///      secret-derived nullifier. The aggregate position token and aggregate amount are public
///      because the Polymarket hedge itself is public.
contract ShieldedPoolV2 {
    uint256 public constant TREE_DEPTH = 20;
    uint256 public constant MAX_LEAVES = 1 << TREE_DEPTH;
    uint256 public constant BATCH_SIZE = 2;

    IShieldedPoolV2ERC20 public immutable collateral;
    IShieldedPoolV2CTF public immutable ctf;
    IShieldedPoolV2Verifier public immutable withdrawVerifier;
    IShieldedPoolV2Verifier public immutable transferVerifier;
    IShieldedPoolV2Verifier public immutable orderVerifier;
    IShieldedPoolV2Verifier public immutable routeVerifier;
    IShieldedPoolV2Verifier public immutable settlementVerifier;
    IShieldedPoolV2Verifier public immutable cancelVerifier;
    IShieldedPoolV2ExecutionAdapter public immutable executionAdapter;
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
    mapping(bytes32 => bool) public spentOrderNullifiers;
    mapping(bytes32 => uint256) public liabilities;

    struct BuyExecution {
        bytes32 batchBinding;
        bytes32 positionAssetId;
        uint256 positionTokenId;
        uint256 totalDeposit;
        bool active;
    }

    BuyExecution public activeBuy;
    bytes32[2] private _activeOrderNullifiers;
    bytes32[2] private _activeFullRefunds;
    uint256 private _activeCollateralSurplus;
    uint256 private _activePositionSurplus;

    event NoteDeposited(uint256 indexed leafIndex, bytes32 indexed commitment, bytes32 indexed assetId, uint256 amount);
    event NoteInserted(uint256 indexed leafIndex, bytes32 indexed commitment);
    event NoteWithdrawn(bytes32 indexed nullifier, bytes32 indexed assetId, address indexed recipient, uint256 amount);
    event NotesTransferred(bytes32 indexed nullifier, bytes32 indexed firstCommitment, bytes32 secondCommitment);
    event OrderNoteLocked(bytes32 indexed orderCommitment, bytes32 indexed collateralNullifier);
    event OrderNoteCancelled(bytes32 indexed orderNullifier, bytes32 indexed refundCommitment);
    event BuyBatchRouted(bytes32 indexed batchBinding, uint256 indexed positionTokenId, uint256 totalDeposit);
    event BuyBatchSettled(bytes32 indexed batchBinding, uint256 totalSpent, uint256 totalShares, uint256 totalRefund);
    event BuyBatchCancelled(bytes32 indexed batchBinding);
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
        IShieldedPoolV2ERC20 collateral_,
        IShieldedPoolV2CTF ctf_,
        IShieldedPoolV2Verifier withdrawVerifier_,
        IShieldedPoolV2Verifier transferVerifier_,
        IShieldedPoolV2Verifier orderVerifier_,
        IShieldedPoolV2Verifier routeVerifier_,
        IShieldedPoolV2Verifier settlementVerifier_,
        IShieldedPoolV2Verifier cancelVerifier_,
        IShieldedPoolV2ExecutionAdapter executionAdapter_,
        address relayer_,
        address guardian_
    ) {
        if (
            address(collateral_) == address(0) || address(ctf_) == address(0)
                || address(withdrawVerifier_) == address(0) || address(transferVerifier_) == address(0)
                || address(orderVerifier_) == address(0) || address(routeVerifier_) == address(0)
                || address(settlementVerifier_) == address(0) || address(cancelVerifier_) == address(0)
                || address(executionAdapter_) == address(0) || relayer_ == address(0) || guardian_ == address(0)
        ) revert InvalidInput();

        collateral = collateral_;
        ctf = ctf_;
        withdrawVerifier = withdrawVerifier_;
        transferVerifier = transferVerifier_;
        orderVerifier = orderVerifier_;
        routeVerifier = routeVerifier_;
        settlementVerifier = settlementVerifier_;
        cancelVerifier = cancelVerifier_;
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

    /// @dev Exits deliberately remain available while intake is paused.
    function withdraw(bytes calldata proof, bytes32 root, bytes32 nullifier, uint256 amount, address recipient)
        external
        nonReentrant
    {
        _authorizeWithdrawal(proof, root, nullifier, collateralAssetId, amount, recipient);
        if (!collateral.transfer(recipient, amount)) revert TransferFailed();
        emit NoteWithdrawn(nullifier, collateralAssetId, recipient, amount);
    }

    function withdrawPosition(
        bytes calldata proof,
        bytes32 root,
        bytes32 nullifier,
        uint256 tokenId,
        uint256 amount,
        address recipient
    ) external nonReentrant {
        if (tokenId == 0) revert InvalidInput();
        bytes32 assetId = positionAssetId(tokenId);
        _authorizeWithdrawal(proof, root, nullifier, assetId, amount, recipient);
        ctf.safeTransferFrom(address(this), recipient, tokenId, amount, "");
        emit NoteWithdrawn(nullifier, assetId, recipient, amount);
    }

    function transferNotes(
        bytes calldata proof,
        bytes32 root,
        bytes32 nullifier,
        bytes32 firstCommitment,
        bytes32 secondCommitment
    ) external nonReentrant {
        if (!knownRoots[root]) revert InvalidRoot();
        if (spentNullifiers[nullifier]) revert NullifierSpent();
        if (nullifier == bytes32(0) || firstCommitment == bytes32(0)) revert InvalidInput();
        bytes32[] memory inputs = new bytes32[](8);
        (inputs[0], inputs[1]) = _halves(root);
        (inputs[2], inputs[3]) = _halves(nullifier);
        (inputs[4], inputs[5]) = _halves(firstCommitment);
        (inputs[6], inputs[7]) = _halves(secondCommitment);
        if (!transferVerifier.verify(proof, inputs)) revert ProofInvalid();
        spentNullifiers[nullifier] = true;
        _insert(firstCommitment);
        if (secondCommitment != bytes32(0)) _insert(secondCommitment);
        emit NotesTransferred(nullifier, firstCommitment, secondCommitment);
    }

    /// @notice Convert a collateral note into a generic order note.
    /// @dev No market, side, amount, limit, or position token is accepted by this function.
    function lockOrder(
        bytes calldata proof,
        bytes32 root,
        bytes32 collateralNullifier,
        bytes32 orderCommitment
    ) external whenActive nonReentrant {
        if (!knownRoots[root]) revert InvalidRoot();
        if (spentNullifiers[collateralNullifier]) revert NullifierSpent();
        if (collateralNullifier == bytes32(0) || orderCommitment == bytes32(0)) revert InvalidInput();
        bytes32[] memory inputs = new bytes32[](8);
        (inputs[0], inputs[1]) = _halves(root);
        (inputs[2], inputs[3]) = _halves(collateralNullifier);
        (inputs[4], inputs[5]) = _halves(collateralAssetId);
        (inputs[6], inputs[7]) = _halves(orderCommitment);
        if (!orderVerifier.verify(proof, inputs)) revert ProofInvalid();
        spentNullifiers[collateralNullifier] = true;
        _insert(orderCommitment);
        emit OrderNoteLocked(orderCommitment, collateralNullifier);
    }

    /// @notice Privately cancel an unrouted order note into its full collateral refund.
    function cancelOrder(
        bytes calldata proof,
        bytes32 root,
        bytes32 orderNullifier,
        bytes32 refundCommitment,
        uint256 totalDeposit
    ) external nonReentrant {
        if (!knownRoots[root]) revert InvalidRoot();
        if (spentOrderNullifiers[orderNullifier]) revert NullifierSpent();
        if (
            orderNullifier == bytes32(0) || refundCommitment == bytes32(0) || totalDeposit == 0
                || totalDeposit > type(uint64).max
        ) revert InvalidInput();
        bytes32[] memory inputs = new bytes32[](9);
        (inputs[0], inputs[1]) = _halves(root);
        (inputs[2], inputs[3]) = _halves(orderNullifier);
        (inputs[4], inputs[5]) = _halves(collateralAssetId);
        (inputs[6], inputs[7]) = _halves(refundCommitment);
        inputs[8] = bytes32(totalDeposit);
        if (!cancelVerifier.verify(proof, inputs)) revert ProofInvalid();
        spentOrderNullifiers[orderNullifier] = true;
        _insert(refundCommitment);
        emit OrderNoteCancelled(orderNullifier, refundCommitment);
    }

    function startBuyBatch(
        bytes calldata proof,
        bytes32 root,
        uint256 positionTokenId,
        bytes32[2] calldata orderNullifiers,
        bytes32[2] calldata fullRefundCommitments,
        uint256 totalDeposit,
        bytes32 batchBinding
    ) external onlyRelayer whenActive nonReentrant {
        if (activeBuy.active) revert ExecutionActive();
        if (!knownRoots[root]) revert InvalidRoot();
        if (
            positionTokenId == 0 || totalDeposit == 0 || totalDeposit > type(uint64).max
                || batchBinding == bytes32(0)
        ) revert InvalidInput();
        if (
            orderNullifiers[0] == bytes32(0) || orderNullifiers[1] == bytes32(0)
                || orderNullifiers[0] == orderNullifiers[1] || fullRefundCommitments[0] == bytes32(0)
                || fullRefundCommitments[1] == bytes32(0)
        ) revert InvalidInput();
        if (spentOrderNullifiers[orderNullifiers[0]] || spentOrderNullifiers[orderNullifiers[1]]) {
            revert NullifierSpent();
        }

        bytes32 positionAsset = positionAssetId(positionTokenId);
        bytes32[] memory inputs = _routeInputs(
            root, positionAsset, orderNullifiers, fullRefundCommitments, totalDeposit, batchBinding
        );
        if (!routeVerifier.verify(proof, inputs)) revert ProofInvalid();
        if (liabilities[collateralAssetId] < totalDeposit) revert InvalidInput();

        uint256 collateralBalance = collateral.balanceOf(address(this));
        uint256 positionBalance = ctf.balanceOf(address(this), positionTokenId);
        if (
            collateralBalance < liabilities[collateralAssetId]
                || positionBalance < liabilities[positionAsset]
        ) revert InsufficientBacking();

        spentOrderNullifiers[orderNullifiers[0]] = true;
        spentOrderNullifiers[orderNullifiers[1]] = true;
        activeBuy = BuyExecution(batchBinding, positionAsset, positionTokenId, totalDeposit, true);
        _activeOrderNullifiers = orderNullifiers;
        _activeFullRefunds = fullRefundCommitments;
        _activeCollateralSurplus = collateralBalance - liabilities[collateralAssetId];
        _activePositionSurplus = positionBalance - liabilities[positionAsset];

        uint256 beforeBalance = collateral.balanceOf(address(executionAdapter));
        if (!collateral.transfer(address(executionAdapter), totalDeposit)) revert TransferFailed();
        if (collateral.balanceOf(address(executionAdapter)) != beforeBalance + totalDeposit) revert TransferFailed();
        executionAdapter.routeBuy(totalDeposit, positionTokenId);
        emit BuyBatchRouted(batchBinding, positionTokenId, totalDeposit);
    }

    function settleBuyBatch(
        bytes calldata proof,
        bytes32[2] calldata refundCommitments,
        bytes32[2] calldata positionCommitments,
        uint256 totalSpent,
        uint256 totalShares
    ) external onlyOperator nonReentrant {
        BuyExecution memory execution = activeBuy;
        if (!execution.active) revert NoExecution();
        if (
            totalSpent > execution.totalDeposit || totalSpent > liabilities[collateralAssetId]
                || totalSpent > type(uint64).max || totalShares > type(uint64).max
        ) revert InvalidInput();
        bytes32[] memory inputs = _settlementInputs(
            execution.batchBinding,
            execution.positionAssetId,
            refundCommitments,
            positionCommitments,
            execution.totalDeposit,
            totalSpent,
            totalShares
        );
        if (!settlementVerifier.verify(proof, inputs)) revert ProofInvalid();

        uint256 newCollateralLiability = liabilities[collateralAssetId] - totalSpent;
        uint256 newPositionLiability = liabilities[execution.positionAssetId] + totalShares;
        if (collateral.balanceOf(address(this)) < newCollateralLiability + _activeCollateralSurplus) {
            revert InsufficientBacking();
        }
        if (
            ctf.balanceOf(address(this), execution.positionTokenId)
                < newPositionLiability + _activePositionSurplus
        ) {
            revert InsufficientBacking();
        }
        liabilities[collateralAssetId] = newCollateralLiability;
        liabilities[execution.positionAssetId] = newPositionLiability;
        for (uint256 i = 0; i < BATCH_SIZE; i++) {
            if (refundCommitments[i] != bytes32(0)) _insert(refundCommitments[i]);
            if (positionCommitments[i] != bytes32(0)) _insert(positionCommitments[i]);
        }
        _clearExecution();
        emit BuyBatchSettled(execution.batchBinding, totalSpent, totalShares, execution.totalDeposit - totalSpent);
    }

    /// @notice Recover a rejected or timed-out zero-fill batch after all collateral returns.
    function cancelBuyBatch() external onlyOperator nonReentrant {
        BuyExecution memory execution = activeBuy;
        if (!execution.active) revert NoExecution();
        if (collateral.balanceOf(address(this)) < liabilities[collateralAssetId] + _activeCollateralSurplus) {
            revert InsufficientBacking();
        }
        for (uint256 i = 0; i < BATCH_SIZE; i++) {
            if (_activeFullRefunds[i] == bytes32(0)) revert InvalidInput();
            _insert(_activeFullRefunds[i]);
        }
        _clearExecution();
        emit BuyBatchCancelled(execution.batchBinding);
    }

    function activeOrderNullifiers() external view returns (bytes32[2] memory) {
        return _activeOrderNullifiers;
    }

    function activeFullRefunds() external view returns (bytes32[2] memory) {
        return _activeFullRefunds;
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

    function _routeInputs(
        bytes32 root,
        bytes32 positionAsset,
        bytes32[2] calldata nullifiers,
        bytes32[2] calldata refunds,
        uint256 totalDeposit,
        bytes32 binding
    ) private view returns (bytes32[] memory inputs) {
        inputs = new bytes32[](17);
        (inputs[0], inputs[1]) = _halves(root);
        (inputs[2], inputs[3]) = _halves(collateralAssetId);
        (inputs[4], inputs[5]) = _halves(positionAsset);
        for (uint256 i = 0; i < BATCH_SIZE; i++) {
            (inputs[6 + i], inputs[8 + i]) = _halves(nullifiers[i]);
            (inputs[10 + i], inputs[12 + i]) = _halves(refunds[i]);
        }
        inputs[14] = bytes32(totalDeposit);
        (inputs[15], inputs[16]) = _halves(binding);
    }

    function _settlementInputs(
        bytes32 binding,
        bytes32 positionAsset,
        bytes32[2] calldata refunds,
        bytes32[2] calldata positions,
        uint256 totalDeposit,
        uint256 totalSpent,
        uint256 totalShares
    ) private view returns (bytes32[] memory inputs) {
        inputs = new bytes32[](17);
        (inputs[0], inputs[1]) = _halves(binding);
        (inputs[2], inputs[3]) = _halves(collateralAssetId);
        (inputs[4], inputs[5]) = _halves(positionAsset);
        for (uint256 i = 0; i < BATCH_SIZE; i++) {
            (inputs[6 + i], inputs[8 + i]) = _halves(refunds[i]);
            (inputs[10 + i], inputs[12 + i]) = _halves(positions[i]);
        }
        inputs[14] = bytes32(totalDeposit);
        inputs[15] = bytes32(totalSpent);
        inputs[16] = bytes32(totalShares);
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
        bytes32[] memory inputs = new bytes32[](9);
        (inputs[0], inputs[1]) = _halves(root);
        (inputs[2], inputs[3]) = _halves(nullifier);
        (inputs[4], inputs[5]) = _halves(assetId);
        inputs[6] = bytes32(amount);
        bytes32 binding = keccak256(abi.encode(bytes32(uint256(3)), root, nullifier, assetId, amount, recipient));
        (inputs[7], inputs[8]) = _halves(binding);
        if (!withdrawVerifier.verify(proof, inputs)) revert ProofInvalid();
        spentNullifiers[nullifier] = true;
        liabilities[assetId] -= amount;
    }

    function _clearExecution() private {
        delete activeBuy;
        delete _activeOrderNullifiers;
        delete _activeFullRefunds;
        delete _activeCollateralSurplus;
        delete _activePositionSurplus;
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
