// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title WrappedCTFToken
/// @notice ERC-20 wrapper for a Gnosis ConditionalTokens (ERC-1155) position.
///
/// ## Why this exists
///   Railgun only supports ERC-20 tokens. Polymarket YES/NO tokens are ERC-1155.
///   This wrapper lets users:
///     1. Receive YES/NO (ERC-1155) from BatchVault claim into their ProxyWallet.
///     2. Call `wrap(amount)` → get WrappedYES/NO (ERC-20).
///     3. `shield(wrappedYES, amount)` into Railgun → Alice privately withdraws.
///
/// ## Wrap / Unwrap
///   1:1 ratio. No fees. The ERC-1155 is held in this contract as collateral.
///   `wrap`   → pull ERC-1155 from caller, mint ERC-20 to caller.
///   `unwrap` → burn ERC-20 from caller, return ERC-1155 to caller.
///
/// ## ERC-20 compliance
///   Full EIP-20 implementation (no external dependencies — mirrors BatchVault pattern).
///   Includes EIP-2612 permit() for gasless approvals.

contract WrappedCTFToken {

    // ── ERC-20 State ──────────────────────────────────────────────────────────

    string  public name;
    string  public symbol;
    uint8   public constant decimals = 6; // match USDC / CTF convention

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    // ── EIP-2612 Permit ───────────────────────────────────────────────────────

    bytes32 public immutable DOMAIN_SEPARATOR;
    bytes32 public constant  PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");
    mapping(address => uint256) public nonces;

    // ── Wrapper State ─────────────────────────────────────────────────────────

    /// @notice The CTF (ERC-1155) contract whose tokens are wrapped.
    address public immutable ctf;

    /// @notice The ERC-1155 token ID (positionId) wrapped by this contract.
    uint256 public immutable positionId;

    // ── Events ────────────────────────────────────────────────────────────────

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event Wrapped(address indexed account, uint256 amount);
    event Unwrapped(address indexed account, uint256 amount);

    // ── Errors ────────────────────────────────────────────────────────────────

    error InsufficientBalance();
    error InsufficientAllowance();
    error PermitExpired();
    error InvalidPermitSignature();

    // ── Constructor ───────────────────────────────────────────────────────────

    /// @param _ctf        CTF ERC-1155 contract address.
    /// @param _positionId ERC-1155 position ID to wrap (keccak256 of collateral + collectionId).
    /// @param _name       Human-readable name, e.g. "Wrapped YES: Chelsea EPL".
    /// @param _symbol     Ticker, e.g. "wYES" or "wNO".
    constructor(address _ctf, uint256 _positionId, string memory _name, string memory _symbol) {
        ctf        = _ctf;
        positionId = _positionId;
        name       = _name;
        symbol     = _symbol;

        DOMAIN_SEPARATOR = keccak256(abi.encode(
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256(bytes(_name)),
            keccak256("1"),
            block.chainid,
            address(this)
        ));
    }

    // ═════════════════════════════════════════════════════════════════════════
    // Wrap / Unwrap
    // ═════════════════════════════════════════════════════════════════════════

    /// @notice Wrap ERC-1155 tokens into ERC-20.
    ///         Caller must have approved this contract via CTF.setApprovalForAll.
    /// @param amount Number of tokens to wrap (1:1).
    function wrap(uint256 amount) external {
        _wrap(msg.sender, msg.sender, amount);
    }

    /// @notice Wrap ERC-1155 from `from` and mint ERC-20 to `recipient`.
    ///         Useful when ProxyWallet wraps and sends to a Railgun shield address.
    /// @param from      Address that holds the ERC-1155 (must have approved this contract).
    /// @param recipient Address that receives the ERC-20.
    /// @param amount    Number of tokens to wrap.
    function wrapFor(address from, address recipient, uint256 amount) external {
        _wrap(from, recipient, amount);
    }

    /// @notice Unwrap ERC-20 back into ERC-1155.
    /// @param amount Number of tokens to unwrap.
    function unwrap(uint256 amount) external {
        _unwrap(msg.sender, msg.sender, amount);
    }

    /// @notice Unwrap ERC-20 from `from` and return ERC-1155 to `recipient`.
    ///         Uses allowance. Useful for Railgun shield flows where a contract unwraps
    ///         on behalf of Alice.
    /// @param from      Address that holds the ERC-20 (must have approved this contract).
    /// @param recipient Address that receives the ERC-1155.
    /// @param amount    Number of tokens to unwrap.
    function unwrapFor(address from, address recipient, uint256 amount) external {
        if (allowance[from][msg.sender] < amount) revert InsufficientAllowance();
        allowance[from][msg.sender] -= amount;
        _unwrap(from, recipient, amount);
    }

    // ═════════════════════════════════════════════════════════════════════════
    // ERC-20
    // ═════════════════════════════════════════════════════════════════════════

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            if (allowed < amount) revert InsufficientAllowance();
            allowance[from][msg.sender] = allowed - amount;
        }
        _transfer(from, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    // ═════════════════════════════════════════════════════════════════════════
    // EIP-2612 Permit (gasless approvals — lets relayer call transferFrom without
    // Alice needing MATIC for the approve tx)
    // ═════════════════════════════════════════════════════════════════════════

    function permit(
        address owner,
        address spender,
        uint256 value,
        uint256 deadline,
        uint8   v,
        bytes32 r,
        bytes32 s
    ) external {
        if (block.timestamp > deadline) revert PermitExpired();

        bytes32 structHash = keccak256(abi.encode(
            PERMIT_TYPEHASH,
            owner,
            spender,
            value,
            nonces[owner]++,
            deadline
        ));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
        address recovered = ecrecover(digest, v, r, s);
        if (recovered == address(0) || recovered != owner) revert InvalidPermitSignature();

        allowance[owner][spender] = value;
        emit Approval(owner, spender, value);
    }

    // ═════════════════════════════════════════════════════════════════════════
    // ERC-1155 Receiver (must accept tokens sent by CTF.safeTransferFrom)
    // ═════════════════════════════════════════════════════════════════════════

    function onERC1155Received(address, address, uint256, uint256, bytes calldata)
        external pure returns (bytes4)
    {
        return 0xf23a6e61;
    }

    function onERC1155BatchReceived(
        address, address, uint256[] calldata, uint256[] calldata, bytes calldata
    ) external pure returns (bytes4) {
        return 0xbc197c81;
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == 0x4e2312e0   // ERC1155Receiver
            || interfaceId == 0x01ffc9a7;  // ERC165
    }

    // ═════════════════════════════════════════════════════════════════════════
    // Internal
    // ═════════════════════════════════════════════════════════════════════════

    function _wrap(address from, address recipient, uint256 amount) internal {
        // Pull ERC-1155 from `from` into this contract
        _ctfTransferFrom(from, address(this), amount);
        // Mint ERC-20 to `recipient`
        _mint(recipient, amount);
        emit Wrapped(recipient, amount);
    }

    function _unwrap(address from, address recipient, uint256 amount) internal {
        // Burn ERC-20 from `from`
        _burn(from, amount);
        // Return ERC-1155 to `recipient`
        _ctfTransferFrom(address(this), recipient, amount);
        emit Unwrapped(from, amount);
    }

    function _transfer(address from, address to, uint256 amount) internal {
        if (balanceOf[from] < amount) revert InsufficientBalance();
        balanceOf[from] -= amount;
        balanceOf[to]   += amount;
        emit Transfer(from, to, amount);
    }

    function _mint(address to, uint256 amount) internal {
        totalSupply     += amount;
        balanceOf[to]   += amount;
        emit Transfer(address(0), to, amount);
    }

    function _burn(address from, uint256 amount) internal {
        if (balanceOf[from] < amount) revert InsufficientBalance();
        balanceOf[from] -= amount;
        totalSupply     -= amount;
        emit Transfer(from, address(0), amount);
    }

    /// @dev ERC-1155 safeTransferFrom via low-level call to avoid importing interfaces.
    function _ctfTransferFrom(address from, address to, uint256 amount) internal {
        (bool ok, bytes memory ret) = ctf.call(
            abi.encodeWithSignature(
                "safeTransferFrom(address,address,uint256,uint256,bytes)",
                from, to, positionId, amount, bytes("")
            )
        );
        require(ok, string(ret));
    }
}
