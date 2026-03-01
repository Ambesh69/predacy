// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title MockUSDC
/// @notice Minimal ERC-20 with 6 decimals, public faucet, and EIP-3009
///         transferWithAuthorization for Polygon Amoy testing.
///
///         EIP-3009 lets users sign an off-chain USDC transfer authorization
///         that a relayer (or smart contract) can submit on their behalf.
///         This eliminates the need for a separate approve() transaction.
contract MockUSDC {
    string public constant name     = "USD Coin (Test)";
    string public constant symbol   = "USDC";
    uint8  public constant decimals = 6;

    uint256 public totalSupply;

    mapping(address => uint256)                     public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    // ── EIP-3009 state ────────────────────────────────────────────────────────

    /// @notice Tracks used authorization nonces to prevent replay attacks.
    ///         authorizationState[authorizer][nonce] = true if nonce was used.
    mapping(address => mapping(bytes32 => bool)) public authorizationState;

    // ── EIP-712 constants ─────────────────────────────────────────────────────

    bytes32 public immutable DOMAIN_SEPARATOR;

    bytes32 private constant EIP712_DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );

    bytes32 private constant TRANSFER_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );

    // ── Events ────────────────────────────────────────────────────────────────

    event Transfer(address indexed from, address indexed to, uint256 amount);
    event Approval(address indexed owner, address indexed spender, uint256 amount);
    event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce);

    // ── Errors ────────────────────────────────────────────────────────────────

    error AuthorizationNotYetValid();
    error AuthorizationExpired();
    error AuthorizationAlreadyUsed();
    error InvalidAuthorization();

    // ── Constructor ───────────────────────────────────────────────────────────

    constructor() {
        DOMAIN_SEPARATOR = keccak256(abi.encode(
            EIP712_DOMAIN_TYPEHASH,
            keccak256(bytes(name)),   // "USD Coin (Test)"
            keccak256(bytes("1")),    // version
            block.chainid,
            address(this)
        ));
    }

    // ── Faucet ────────────────────────────────────────────────────────────────

    /// @notice Mint test USDC to any address — public faucet for testnet.
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    // ── ERC-20 ────────────────────────────────────────────────────────────────

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        return _transfer(msg.sender, to, amount);
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            require(allowed >= amount, "MockUSDC: insufficient allowance");
            allowance[from][msg.sender] = allowed - amount;
        }
        return _transfer(from, to, amount);
    }

    // ── EIP-3009: transferWithAuthorization ───────────────────────────────────

    /// @notice Execute a USDC transfer using a signed off-chain authorization.
    ///
    ///         The caller (relayer or contract) submits the authorization on
    ///         behalf of `from`. No approve() needed — just an off-chain signature.
    ///
    /// @param from        Address authorizing the transfer (funds debited here)
    /// @param to          Recipient address
    /// @param value       Amount of USDC to transfer (6 decimals)
    /// @param validAfter  Unix timestamp: authorization only valid AFTER this time (set 0 for immediate)
    /// @param validBefore Unix timestamp: authorization expires BEFORE this time
    /// @param nonce       Random 32-byte nonce chosen by the signer (prevents replay)
    /// @param v, r, s     ECDSA signature components from signTypedData
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
    ) external {
        if (block.timestamp <= validAfter)   revert AuthorizationNotYetValid();
        if (block.timestamp >= validBefore)  revert AuthorizationExpired();
        if (authorizationState[from][nonce]) revert AuthorizationAlreadyUsed();

        bytes32 structHash = keccak256(abi.encode(
            TRANSFER_WITH_AUTHORIZATION_TYPEHASH,
            from, to, value, validAfter, validBefore, nonce
        ));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));

        // Normalise v: some wallets return 0/1, ecrecover requires 27/28
        uint8 vAdj = v < 27 ? v + 27 : v;
        if (vAdj != 27 && vAdj != 28) revert InvalidAuthorization();
        address signer = ecrecover(digest, vAdj, r, s);
        if (signer == address(0) || signer != from) revert InvalidAuthorization();

        authorizationState[from][nonce] = true;
        emit AuthorizationUsed(from, nonce);
        _transfer(from, to, value);
    }

    // ── Internals ─────────────────────────────────────────────────────────────

    function _mint(address to, uint256 amount) internal {
        totalSupply   += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function _transfer(address from, address to, uint256 amount) internal returns (bool) {
        require(balanceOf[from] >= amount, "MockUSDC: insufficient balance");
        balanceOf[from] -= amount;
        balanceOf[to]   += amount;
        emit Transfer(from, to, amount);
        return true;
    }
}
