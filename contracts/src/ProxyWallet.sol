// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title ProxyWallet
/// @notice Deterministic smart-contract wallet for private Predacy participation.
///
/// ## Privacy flow
///   Alice → Railgun (shield USDC)
///      → ephemeral EOA (unlinkable from Alice)
///      → ProxyWallet (CREATE2 via ProxyWalletFactory, deterministic address)
///      → commitOrderFor on BatchVault (proxy = signer, amount locked in commit)
///      → [batch settles] YES/NO tokens arrive at proxy via ZK claim
///      → wrap ERC-1155 → WrappedYES/NO ERC-20
///      → shield WrappedYES/NO into Railgun
///      → Alice privately withdraws
///
/// ## Gas sponsorship
///   The Builder Relayer is the `msg.sender` for all external-facing calls.
///   The owner (ephemeral EOA) signs payloads offline; the relayer submits them.
///   This means Alice never needs MATIC.
///
/// ## EIP-1271 (CLOB maker)
///   Polymarket CTFExchange supports POLY_1271 (signatureType=3): maker is a
///   contract, signer field = maker, on-chain isValidSignature() confirms the order.
///   The owner (ephemeral EOA) signs the EIP-712 CLOB order hash; this wallet
///   validates it so the proxy wallet can act as a CLOB maker directly, using its
///   own USDC (from Alice) — zero relayer intermediary.

contract ProxyWallet {

    // ── Constants ─────────────────────────────────────────────────────────────

    bytes4 private constant EIP1271_MAGIC    = 0x1626ba7e;
    bytes4 private constant EIP1271_INVALID  = 0xffffffff;

    // Ethereum Signed Message prefix for meta-tx digest
    bytes32 private constant ETH_SIGN_PREFIX =
        keccak256("\x19Ethereum Signed Message:\n32");

    // ── State ─────────────────────────────────────────────────────────────────

    /// @notice Ephemeral EOA that owns this wallet (Alice's burner key).
    address public immutable owner;

    /// @notice Factory that deployed this wallet.
    address public immutable factory;

    /// @notice Meta-transaction nonce — prevents replay.
    uint256 public nonce;

    // ── Events ────────────────────────────────────────────────────────────────

    event Executed(address indexed to, uint256 value, bytes data, bool success);

    // ── Errors ────────────────────────────────────────────────────────────────

    error OnlyOwner();
    error InvalidSignature();
    error CallFailed(bytes reason);

    // ── Constructor ───────────────────────────────────────────────────────────

    /// @dev Called by ProxyWalletFactory. `owner` is the ephemeral EOA.
    constructor(address _owner) {
        owner   = _owner;
        factory = msg.sender;
    }

    // ═════════════════════════════════════════════════════════════════════════
    // EIP-1271 — CLOB Maker Signature Validation
    // ═════════════════════════════════════════════════════════════════════════

    /// @notice EIP-1271: validate an EIP-712 CLOB order hash.
    /// @dev Polymarket CTFExchange calls this when signatureType = 3 (POLY_1271)
    ///      and maker = signer = address(this).
    ///      The relayer EOA signs the order hash with the `owner` key; this wallet
    ///      confirms the signature is from `owner`, authorising the CLOB trade.
    function isValidSignature(bytes32 hash, bytes calldata signature)
        external view returns (bytes4)
    {
        address recovered = _recover(hash, signature);
        return recovered == owner ? EIP1271_MAGIC : EIP1271_INVALID;
    }

    // ═════════════════════════════════════════════════════════════════════════
    // Meta-Transaction Execution (Builder Relayer pays gas)
    // ═════════════════════════════════════════════════════════════════════════

    /// @notice Execute a call signed by `owner`. Relayer submits; pays MATIC.
    /// @dev Owner signs: keccak256(abi.encode(nonce, chainId, address(this), to, value, data))
    ///      hashed as an eth_sign message (not EIP-712, for simplicity).
    ///      Nonce increments on every successful call to prevent replay.
    /// @param to       Target address.
    /// @param value    ETH value (usually 0 for ERC-20 / ERC-1155 interactions).
    /// @param data     Encoded calldata.
    /// @param sig      65-byte ECDSA signature from owner over the digest.
    function executeWithSig(
        address to,
        uint256 value,
        bytes calldata data,
        bytes calldata sig
    ) external returns (bytes memory result) {
        // Build digest
        bytes32 digest = _metaTxDigest(nonce, to, value, data);
        address recovered = _recoverEthSign(digest, sig);
        if (recovered != owner) revert InvalidSignature();

        nonce++;

        bool ok;
        (ok, result) = to.call{value: value}(data);
        if (!ok) revert CallFailed(result);

        emit Executed(to, value, data, true);
    }

    /// @notice Batch execute multiple calls in one meta-tx (gas efficient).
    /// @dev Owner signs a digest covering ALL calls + single nonce.
    /// @param targets  Array of call targets.
    /// @param values   Array of ETH values (parallel to targets).
    /// @param payloads Array of calldata (parallel to targets).
    /// @param sig      65-byte ECDSA signature from owner over the batch digest.
    function batchExecuteWithSig(
        address[] calldata targets,
        uint256[] calldata values,
        bytes[]   calldata payloads,
        bytes     calldata sig
    ) external returns (bytes[] memory results) {
        require(
            targets.length == values.length && values.length == payloads.length,
            "ProxyWallet: length mismatch"
        );

        // Batch digest covers all calls + nonce
        bytes32 digest = _batchMetaTxDigest(nonce, targets, values, payloads);
        address recovered = _recoverEthSign(digest, sig);
        if (recovered != owner) revert InvalidSignature();

        nonce++;

        results = new bytes[](targets.length);
        for (uint256 i = 0; i < targets.length; i++) {
            bool ok;
            (ok, results[i]) = targets[i].call{value: values[i]}(payloads[i]);
            if (!ok) revert CallFailed(results[i]);
            emit Executed(targets[i], values[i], payloads[i], true);
        }
    }

    /// @notice Direct execution — only callable by owner (no meta-tx needed if
    ///         owner pays gas, e.g. during local testing).
    function execute(address to, uint256 value, bytes calldata data)
        external returns (bytes memory result)
    {
        if (msg.sender != owner) revert OnlyOwner();
        bool ok;
        (ok, result) = to.call{value: value}(data);
        if (!ok) revert CallFailed(result);
        emit Executed(to, value, data, true);
    }

    // ═════════════════════════════════════════════════════════════════════════
    // ERC-1155 Receiver (accept YES/NO tokens from BatchVault)
    // ═════════════════════════════════════════════════════════════════════════

    function onERC1155Received(address, address, uint256, uint256, bytes calldata)
        external pure returns (bytes4)
    {
        // bytes4(keccak256("onERC1155Received(address,address,uint256,uint256,bytes)"))
        return 0xf23a6e61;
    }

    function onERC1155BatchReceived(
        address, address, uint256[] calldata, uint256[] calldata, bytes calldata
    ) external pure returns (bytes4) {
        // bytes4(keccak256("onERC1155BatchReceived(address,address,uint256[],uint256[],bytes)"))
        return 0xbc197c81;
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == 0x4e2312e0  // ERC1155Receiver
            || interfaceId == 0x01ffc9a7; // ERC165
    }

    // ═════════════════════════════════════════════════════════════════════════
    // Receive ETH
    // ═════════════════════════════════════════════════════════════════════════

    receive() external payable {}

    // ═════════════════════════════════════════════════════════════════════════
    // Internal — ECDSA helpers (no OZ dependency, mirrors BatchVault pattern)
    // ═════════════════════════════════════════════════════════════════════════

    /// @dev Recover signer from a raw 32-byte hash + 65-byte sig (no prefix).
    ///      Used for EIP-1271 CLOB order validation (CTFExchange pre-hashes).
    function _recover(bytes32 hash, bytes calldata sig) internal pure returns (address) {
        if (sig.length != 65) return address(0);
        bytes32 r;
        bytes32 s;
        uint8   v;
        assembly {
            r := calldataload(sig.offset)
            s := calldataload(add(sig.offset, 32))
            v := byte(0, calldataload(add(sig.offset, 64)))
        }
        if (v < 27) v += 27;
        if (v != 27 && v != 28) return address(0);
        return ecrecover(hash, v, r, s);
    }

    /// @dev Recover signer from an eth_sign-prefixed digest.
    ///      Used for meta-tx validation (owner signs with eth_sign, not eth_signTypedData).
    function _recoverEthSign(bytes32 digest, bytes calldata sig) internal pure returns (address) {
        bytes32 prefixed = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", digest));
        return _recover(prefixed, sig);
    }

    /// @dev Build meta-tx digest for a single call.
    function _metaTxDigest(
        uint256 _nonce,
        address to,
        uint256 value,
        bytes calldata data
    ) internal view returns (bytes32) {
        return keccak256(abi.encode(
            _nonce,
            block.chainid,
            address(this),
            to,
            value,
            keccak256(data)
        ));
    }

    /// @dev Build meta-tx digest for a batch of calls.
    function _batchMetaTxDigest(
        uint256 _nonce,
        address[] calldata targets,
        uint256[] calldata values,
        bytes[]   calldata payloads
    ) internal view returns (bytes32) {
        return keccak256(abi.encode(
            _nonce,
            block.chainid,
            address(this),
            targets,
            values,
            _hashBytesArray(payloads)
        ));
    }

    /// @dev Hash a bytes[] array by hashing each element then hashing the results.
    function _hashBytesArray(bytes[] calldata arr) internal pure returns (bytes32) {
        bytes32[] memory hashes = new bytes32[](arr.length);
        for (uint256 i = 0; i < arr.length; i++) {
            hashes[i] = keccak256(arr[i]);
        }
        return keccak256(abi.encodePacked(hashes));
    }
}
