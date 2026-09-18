// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./PolymarketCollateralBridge.sol";
import "./SettlementAccounting.sol";
import "./interfaces/IConditionalTokens.sol";

interface IVaultERC20 is IBridgeERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

interface IAllocationVerifier {
    function verify(bytes calldata proof, bytes32[] calldata publicInputs) external view returns (bool);
}

/// @notice Experimental serial batch vault. Not deployed; direct claims are public.
/// @dev A routed batch requires operator-controlled Deposit Wallet reconciliation.
contract BatchVaultV11 {
    enum Status { NONE, OPEN, CLOSED, ROUTED, SETTLED, ABORTED }

    struct Batch {
        bytes32 marketId;
        uint256 yesTokenId;
        uint256 noTokenId;
        uint256 openedAt;
        uint256 closedAt;
        uint256 orderCount;
        uint256 buyerEscrow;
        uint256 yesEscrow;
        uint256 noEscrow;
        uint256 routedUsdc;
        uint256 routedYes;
        uint256 routedNo;
        Status status;
    }

    struct Order {
        bytes32 commitment;
        SettlementAccounting.Side side;
        uint256 deposit;
        address owner;
        bool claimed;
    }

    uint256 public constant BATCH_WINDOW = 30;
    uint256 public constant RESCUE_DELAY = 7 days;
    uint256 public constant MAX_ORDERS = 4;

    IVaultERC20 public immutable usdce;
    IBridgeERC20 public immutable pusd;
    ICollateralOnramp public immutable onramp;
    ICollateralOfframp public immutable offramp;
    IConditionalTokens public immutable ctf;
    IAllocationVerifier public immutable allocationVerifier;
    address public immutable relayer;
    address public immutable guardian;
    address public immutable depositWallet;
    bool public tradingPaused = true;

    uint256 public nextBatchId = 1;
    uint256 public activeBatchId;
    uint256 public reservedUsdc;
    mapping(uint256 => uint256) public reservedTokens;
    mapping(uint256 => Batch) public batches;
    mapping(uint256 => mapping(uint256 => Order)) public orders;
    mapping(uint256 => mapping(bytes32 => bool)) public committed;
    mapping(uint256 => mapping(uint256 => SettlementAccounting.Allocation)) public allocations;
    uint256 private _entered = 1;

    event BatchOpened(uint256 indexed batchId, bytes32 indexed marketId);
    event OrderEscrowed(uint256 indexed batchId, uint256 indexed index, bytes32 indexed commitment);
    event BatchRouted(uint256 indexed batchId, uint256 usdceAmount, uint256 yesAmount, uint256 noAmount);
    event BatchSettled(uint256 indexed batchId, uint256 usdcLiability, uint256 yesLiability, uint256 noLiability);
    event BatchAborted(uint256 indexed batchId);
    event Claimed(uint256 indexed batchId, uint256 indexed index, address indexed owner, address recipient);
    event TradingPauseChanged(bool paused);

    error OnlyRelayer();
    error OnlyGuardian();
    error OnlyOperator();
    error TradingPaused();
    error InvalidStatus();
    error InvalidOrder();
    error InvalidAsset();
    error ProofInvalid();
    error InsufficientAssets();
    error TransferFailed();
    error TooEarly();
    error NotOwner();
    error AlreadyClaimed();
    error Reentrant();

    modifier onlyRelayer() {
        if (msg.sender != relayer) revert OnlyRelayer();
        _;
    }

    modifier onlyOperator() {
        if (msg.sender != relayer && msg.sender != guardian) revert OnlyOperator();
        _;
    }

    modifier whenTrading() {
        if (tradingPaused) revert TradingPaused();
        _;
    }

    modifier nonReentrant() {
        if (_entered != 1) revert Reentrant();
        _entered = 2;
        _;
        _entered = 1;
    }

    constructor(
        IVaultERC20 usdce_,
        IBridgeERC20 pusd_,
        ICollateralOnramp onramp_,
        ICollateralOfframp offramp_,
        IConditionalTokens ctf_,
        IAllocationVerifier verifier_,
        address relayer_,
        address guardian_,
        address depositWallet_
    ) {
        if (relayer_ == address(0) || guardian_ == address(0) || depositWallet_ == address(0) ||
            address(usdce_) == address(0) || address(pusd_) == address(0) ||
            address(onramp_) == address(0) || address(offramp_) == address(0) ||
            address(ctf_) == address(0) || address(verifier_) == address(0)) revert InvalidAsset();
        usdce = usdce_;
        pusd = pusd_;
        onramp = onramp_;
        offramp = offramp_;
        ctf = ctf_;
        allocationVerifier = verifier_;
        relayer = relayer_;
        guardian = guardian_;
        depositWallet = depositWallet_;
    }

    function setTradingPaused(bool paused) external {
        if (msg.sender != guardian) revert OnlyGuardian();
        tradingPaused = paused;
        emit TradingPauseChanged(paused);
    }

    function openBatch(bytes32 marketId, uint256 yesTokenId, uint256 noTokenId)
        external onlyRelayer whenTrading returns (uint256 batchId)
    {
        Status previous = batches[activeBatchId].status;
        if (previous != Status.NONE && previous != Status.SETTLED && previous != Status.ABORTED) {
            revert InvalidStatus();
        }
        if (marketId == bytes32(0) || yesTokenId == 0 || noTokenId == 0 || yesTokenId == noTokenId) {
            revert InvalidAsset();
        }
        batchId = nextBatchId++;
        activeBatchId = batchId;
        Batch storage batch = batches[batchId];
        batch.marketId = marketId;
        batch.yesTokenId = yesTokenId;
        batch.noTokenId = noTokenId;
        batch.openedAt = block.timestamp;
        batch.status = Status.OPEN;
        emit BatchOpened(batchId, marketId);
    }

    function commitBuy(
        uint256 batchId, bytes32 commitment, SettlementAccounting.Side side,
        uint256 deposit, bytes calldata initialProof
    ) external whenTrading nonReentrant {
        if (side != SettlementAccounting.Side.YES_BUY && side != SettlementAccounting.Side.NO_BUY) revert InvalidOrder();
        _commit(batchId, commitment, side, deposit, initialProof);
        uint256 beforeBalance = usdce.balanceOf(address(this));
        if (!usdce.transferFrom(msg.sender, address(this), deposit)) revert TransferFailed();
        if (usdce.balanceOf(address(this)) != beforeBalance + deposit) revert InvalidAsset();
        batches[batchId].buyerEscrow += deposit;
    }

    function commitSell(
        uint256 batchId, bytes32 commitment, SettlementAccounting.Side side,
        uint256 deposit, bytes calldata initialProof
    ) external whenTrading nonReentrant {
        if (side != SettlementAccounting.Side.YES_SELL && side != SettlementAccounting.Side.NO_SELL) revert InvalidOrder();
        _commit(batchId, commitment, side, deposit, initialProof);
        Batch storage batch = batches[batchId];
        uint256 tokenId = side == SettlementAccounting.Side.YES_SELL ? batch.yesTokenId : batch.noTokenId;
        uint256 beforeBalance = ctf.balanceOf(address(this), tokenId);
        ctf.safeTransferFrom(msg.sender, address(this), tokenId, deposit, "");
        if (ctf.balanceOf(address(this), tokenId) != beforeBalance + deposit) revert InvalidAsset();
        if (side == SettlementAccounting.Side.YES_SELL) batch.yesEscrow += deposit;
        else batch.noEscrow += deposit;
    }

    function closeBatch(uint256 batchId) external {
        Batch storage batch = batches[batchId];
        if (batch.status != Status.OPEN) revert InvalidStatus();
        if (block.timestamp < batch.openedAt + BATCH_WINDOW) revert TooEarly();
        batch.closedAt = block.timestamp;
        batch.status = Status.CLOSED;
    }

    function routeAssets(uint256 batchId, uint256 usdcAmount, uint256 yesAmount, uint256 noAmount)
        external onlyRelayer whenTrading nonReentrant
    {
        Batch storage batch = batches[batchId];
        if (batch.status != Status.CLOSED) revert InvalidStatus();
        if (usdcAmount > batch.buyerEscrow || yesAmount > batch.yesEscrow || noAmount > batch.noEscrow) {
            revert InsufficientAssets();
        }
        SettlementAccounting.Assets memory available = _available(batch);
        if (available.usdc < batch.buyerEscrow || available.yes < batch.yesEscrow ||
            available.no < batch.noEscrow) revert InsufficientAssets();
        batch.routedUsdc = usdcAmount;
        batch.routedYes = yesAmount;
        batch.routedNo = noAmount;
        batch.status = Status.ROUTED;

        if (usdcAmount > 0) {
            PolymarketCollateralBridge.wrapToDepositWallet(usdce, pusd, onramp, depositWallet, usdcAmount);
        }
        if (yesAmount > 0) _routeToken(batch.yesTokenId, yesAmount);
        if (noAmount > 0) _routeToken(batch.noTokenId, noAmount);
        emit BatchRouted(batchId, usdcAmount, yesAmount, noAmount);
    }

    function finalize(
        uint256 batchId,
        SettlementAccounting.Allocation[] calldata proposed,
        bytes[] calldata proofs,
        uint256 returnedPusd
    ) external onlyOperator nonReentrant {
        Batch storage batch = batches[batchId];
        if (batch.status != Status.ROUTED) revert InvalidStatus();
        if (proposed.length != batch.orderCount || proofs.length != proposed.length) revert InvalidOrder();
        if (pusd.balanceOf(address(this)) != returnedPusd) revert InvalidAsset();
        if (returnedPusd > 0) {
            PolymarketCollateralBridge.unwrapToVault(usdce, pusd, offramp, returnedPusd);
        }

        SettlementAccounting.Allocation[] memory checked = new SettlementAccounting.Allocation[](proposed.length);
        for (uint256 i = 0; i < proposed.length; i++) {
            Order storage order = orders[batchId][i];
            SettlementAccounting.Allocation memory allocation = proposed[i];
            if (allocation.side != order.side || allocation.deposit != order.deposit ||
                allocation.limitPrice != 0) revert InvalidOrder();
            _verify(batch.marketId, order.commitment, allocation, proofs[i]);
            checked[i] = allocation;
            allocations[batchId][i] = allocation;
        }

        SettlementAccounting.Assets memory actual = _available(batch);
        SettlementAccounting.Execution memory execution = _netExecution(batch, actual);
        SettlementAccounting.Assets memory claims = SettlementAccounting.validateProven(checked, 0, 0, execution);
        if (claims.usdc != actual.usdc || claims.yes != actual.yes || claims.no != actual.no) {
            revert InsufficientAssets();
        }

        reservedUsdc += actual.usdc;
        reservedTokens[batch.yesTokenId] += actual.yes;
        reservedTokens[batch.noTokenId] += actual.no;
        batch.status = Status.SETTLED;
        emit BatchSettled(batchId, actual.usdc, actual.yes, actual.no);
    }

    function abortUnrouted(uint256 batchId) external nonReentrant {
        Batch storage batch = batches[batchId];
        if (batch.status != Status.OPEN && batch.status != Status.CLOSED) revert InvalidStatus();
        if (block.timestamp < batch.openedAt + BATCH_WINDOW + RESCUE_DELAY) revert TooEarly();
        batch.status = Status.ABORTED;
        reservedUsdc += batch.buyerEscrow;
        reservedTokens[batch.yesTokenId] += batch.yesEscrow;
        reservedTokens[batch.noTokenId] += batch.noEscrow;
        emit BatchAborted(batchId);
    }

    function claim(uint256 batchId, uint256 index) external nonReentrant {
        _claim(batchId, index, msg.sender);
    }

    function claimTo(uint256 batchId, uint256 index, address recipient) external nonReentrant {
        if (recipient == address(0)) revert InvalidAsset();
        _claim(batchId, index, recipient);
    }

    function _claim(uint256 batchId, uint256 index, address recipient) private {
        Batch storage batch = batches[batchId];
        if (batch.status != Status.SETTLED && batch.status != Status.ABORTED) revert InvalidStatus();
        if (index >= batch.orderCount) revert InvalidOrder();
        Order storage order = orders[batchId][index];
        if (msg.sender != order.owner) revert NotOwner();
        if (order.claimed) revert AlreadyClaimed();
        order.claimed = true;

        SettlementAccounting.Allocation memory allocation = allocations[batchId][index];
        if (batch.status == Status.ABORTED) {
            allocation = SettlementAccounting.Allocation(order.side, order.deposit, 0, 0, 0, order.deposit);
        }
        if (order.side == SettlementAccounting.Side.YES_BUY || order.side == SettlementAccounting.Side.NO_BUY) {
            reservedUsdc -= allocation.refund;
            if (allocation.refund > 0 && !usdce.transfer(recipient, allocation.refund)) revert TransferFailed();
            uint256 tokenId = order.side == SettlementAccounting.Side.YES_BUY ? batch.yesTokenId : batch.noTokenId;
            _sendToken(tokenId, recipient, allocation.filledShares);
        } else {
            reservedUsdc -= allocation.usdcPayout;
            if (allocation.usdcPayout > 0 && !usdce.transfer(recipient, allocation.usdcPayout)) revert TransferFailed();
            uint256 tokenId = order.side == SettlementAccounting.Side.YES_SELL ? batch.yesTokenId : batch.noTokenId;
            _sendToken(tokenId, recipient, allocation.refund);
        }
        emit Claimed(batchId, index, order.owner, recipient);
    }

    function _commit(
        uint256 batchId, bytes32 commitment, SettlementAccounting.Side side,
        uint256 deposit, bytes calldata initialProof
    ) private {
        Batch storage batch = batches[batchId];
        if (batch.status != Status.OPEN || block.timestamp >= batch.openedAt + BATCH_WINDOW) revert InvalidStatus();
        if (batch.orderCount >= MAX_ORDERS || deposit == 0 || deposit > type(uint64).max ||
            commitment == bytes32(0) || committed[batchId][commitment]) revert InvalidOrder();

        SettlementAccounting.Allocation memory initial = SettlementAccounting.Allocation(
            side, deposit, 0, 0, 0, deposit
        );
        _verify(batch.marketId, commitment, initial, initialProof);
        committed[batchId][commitment] = true;
        uint256 index = batch.orderCount++;
        orders[batchId][index] = Order(commitment, side, deposit, msg.sender, false);
        emit OrderEscrowed(batchId, index, commitment);
    }

    function _verify(
        bytes32 marketId, bytes32 commitment,
        SettlementAccounting.Allocation memory allocation, bytes calldata proof
    ) private view {
        bytes32[] memory inputs = new bytes32[](9);
        inputs[0] = bytes32(uint256(marketId) >> 128);
        inputs[1] = bytes32(uint256(marketId) & type(uint128).max);
        inputs[2] = bytes32(uint256(commitment) >> 128);
        inputs[3] = bytes32(uint256(commitment) & type(uint128).max);
        inputs[4] = bytes32(uint256(uint8(allocation.side)));
        inputs[5] = bytes32(allocation.deposit);
        inputs[6] = bytes32(allocation.filledShares);
        inputs[7] = bytes32(allocation.usdcPayout);
        inputs[8] = bytes32(allocation.refund);
        if (!allocationVerifier.verify(proof, inputs)) revert ProofInvalid();
    }

    function _available(Batch storage batch) private view returns (SettlementAccounting.Assets memory available) {
        uint256 usdcBalance = usdce.balanceOf(address(this));
        uint256 yesBalance = ctf.balanceOf(address(this), batch.yesTokenId);
        uint256 noBalance = ctf.balanceOf(address(this), batch.noTokenId);
        if (usdcBalance < reservedUsdc || yesBalance < reservedTokens[batch.yesTokenId] ||
            noBalance < reservedTokens[batch.noTokenId]) revert InsufficientAssets();
        available.usdc = usdcBalance - reservedUsdc;
        available.yes = yesBalance - reservedTokens[batch.yesTokenId];
        available.no = noBalance - reservedTokens[batch.noTokenId];
    }

    function _netExecution(Batch storage batch, SettlementAccounting.Assets memory actual)
        private view returns (SettlementAccounting.Execution memory execution)
    {
        if (actual.usdc < batch.buyerEscrow) execution.usdcSpent = batch.buyerEscrow - actual.usdc;
        else execution.usdcReceived = actual.usdc - batch.buyerEscrow;
        if (actual.yes < batch.yesEscrow) execution.yesSold = batch.yesEscrow - actual.yes;
        else execution.yesBought = actual.yes - batch.yesEscrow;
        if (actual.no < batch.noEscrow) execution.noSold = batch.noEscrow - actual.no;
        else execution.noBought = actual.no - batch.noEscrow;
    }

    function _sendToken(uint256 tokenId, address to, uint256 amount) private {
        if (amount == 0) return;
        reservedTokens[tokenId] -= amount;
        ctf.safeTransferFrom(address(this), to, tokenId, amount, "");
    }

    function _routeToken(uint256 tokenId, uint256 amount) private {
        uint256 beforeBalance = ctf.balanceOf(depositWallet, tokenId);
        ctf.safeTransferFrom(address(this), depositWallet, tokenId, amount, "");
        if (ctf.balanceOf(depositWallet, tokenId) != beforeBalance + amount) revert InvalidAsset();
    }

    function onERC1155Received(address operator, address from, uint256, uint256, bytes calldata)
        external view returns (bytes4)
    {
        if (msg.sender != address(ctf) ||
            (operator != address(this) && from != depositWallet)) revert InvalidAsset();
        return this.onERC1155Received.selector;
    }
}
