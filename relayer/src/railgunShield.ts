/**
 * railgunShield.ts
 * ─────────────────
 * Builds batchExecuteWithSig calldata for the ProxyWallet to:
 *   1. Wrap ERC-1155 YES/NO tokens → WrappedCTFToken ERC-20
 *   2. Approve Railgun's RailgunSmartWallet to pull the ERC-20
 *   3. Call RailgunSmartWallet.shield() to shield into Railgun
 *
 * ## Railgun note commitment
 *   Alice's Railgun wallet generates:
 *     - `npk` (note public key, 32 bytes)  — the recipient key in Railgun's system
 *     - `encryptedBundle` (3×32 bytes)     — Poseidon-encrypted note data
 *     - `shieldKey` (32 bytes)             — ephemeral public key for ECDH
 *   These are provided by Alice as part of the `/claim-proof` request.
 *   The relayer never sees Alice's Railgun private key.
 *
 * ## Gas sponsorship
 *   The Builder Relayer calls ProxyWallet.batchExecuteWithSig().
 *   Alice pays no MATIC — only her ephemeral EOA key signature is needed.
 *
 * ## Usage (in index.ts / claim-proof endpoint)
 *   const payload = buildShieldBatch({
 *     wrappedToken:   "0x...",   // WrappedCTFToken address (YES or NO)
 *     amount:         1000n,      // token amount (same units as ERC-1155)
 *     npk:            "0x...",   // Alice's Railgun note public key
 *     encryptedBundle:["0x..", "0x..", "0x.."],
 *     shieldKey:      "0x...",
 *   });
 *   const sig = await ephemeralWallet.signMessage({ message: { raw: payload.digest } });
 *   await proxyWallet.batchExecuteWithSig(...payload.args, sig);
 */

import {
  type Hex,
  type Address,
  encodeFunctionData,
  keccak256,
  encodeAbiParameters,
  parseAbiParameters,
  concat,
  pad,
  toBytes,
  toHex,
} from "viem";

// ── Railgun mainnet address (Polygon) ────────────────────────────────────────

export const RAILGUN_SMART_WALLET: Address =
  "0x19B620929f97b7b990801496c3b361CA5dEf8C71";

// ── ABIs (inline, no OZ dependency) ─────────────────────────────────────────

const WRAPPED_CTF_ABI = [
  {
    name: "wrap",
    type: "function" as const,
    inputs: [{ name: "amount", type: "uint256" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    name: "approve",
    type: "function" as const,
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount",  type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "nonpayable",
  },
  {
    name: "setApprovalForAll",
    type: "function" as const,
    inputs: [
      { name: "operator", type: "address" },
      { name: "approved", type: "bool" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const;

const CTF_ABI = [
  {
    name: "setApprovalForAll",
    type: "function" as const,
    inputs: [
      { name: "operator", type: "address" },
      { name: "approved", type: "bool" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const;

// Railgun shield() ABI (structs expanded as tuples)
const RAILGUN_SHIELD_ABI = [
  {
    name: "shield",
    type: "function" as const,
    inputs: [
      {
        name: "_shieldRequests",
        type: "tuple[]",
        components: [
          { name: "npk",   type: "bytes32" },
          {
            name: "token",
            type: "tuple",
            components: [
              { name: "tokenType",    type: "uint8"   }, // 0 = ERC20
              { name: "tokenAddress", type: "address" },
              { name: "tokenSubID",   type: "uint256" }, // 0 for ERC20
            ],
          },
          { name: "value", type: "uint120" },
        ],
      },
      {
        name: "_shieldCiphertext",
        type: "tuple[]",
        components: [
          { name: "encryptedBundle", type: "bytes32[3]" },
          { name: "shieldKey",       type: "bytes32"    },
        ],
      },
    ],
    outputs: [],
    stateMutability: "payable",
  },
] as const;

// ProxyWallet batchExecuteWithSig ABI
const PROXY_WALLET_ABI = [
  {
    name: "batchExecuteWithSig",
    type: "function" as const,
    inputs: [
      { name: "targets",  type: "address[]" },
      { name: "values",   type: "uint256[]" },
      { name: "payloads", type: "bytes[]"   },
      { name: "sig",      type: "bytes"     },
    ],
    outputs: [{ name: "results", type: "bytes[]" }],
    stateMutability: "nonpayable",
  },
] as const;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ShieldParams {
  /** WrappedCTFToken address (wYES or wNO). Must be deployed by WrappedCTFFactory. */
  wrappedToken: Address;
  /** CTF (ERC-1155) contract address. */
  ctfAddress: Address;
  /** Amount of tokens to wrap and shield (same units as ERC-1155). */
  amount: bigint;
  /** Alice's Railgun note public key (bytes32). Provided by Alice's Railgun wallet. */
  npk: Hex;
  /** Railgun encrypted note bundle [3 × bytes32]. From Alice's Railgun wallet. */
  encryptedBundle: [Hex, Hex, Hex];
  /** Railgun shield key (ephemeral public key for ECDH, bytes32). From Alice's wallet. */
  shieldKey: Hex;
}

export interface BatchPayload {
  /** Ordered call targets for batchExecuteWithSig. */
  targets:  Address[];
  /** ETH values per call (all 0 for ERC-20/ERC-1155 ops). */
  values:   bigint[];
  /** Encoded calldata per call. */
  payloads: Hex[];
}

// ── Core function ─────────────────────────────────────────────────────────────

/**
 * Build the batch of calls that the ProxyWallet will execute to:
 *   1. setApprovalForAll(wrappedToken, true) on CTF (allows wrappedToken to pull ERC-1155)
 *   2. wrap(amount) on WrappedCTFToken (ERC-1155 → ERC-20)
 *   3. approve(RAILGUN_SMART_WALLET, amount) on WrappedCTFToken (allow Railgun to pull ERC-20)
 *   4. shield(shieldRequest, shieldCiphertext) on RailgunSmartWallet
 *
 * The result is passed to ProxyWallet.batchExecuteWithSig() with Alice's sig.
 */
export function buildShieldBatch(params: ShieldParams): BatchPayload {
  const {
    wrappedToken,
    ctfAddress,
    amount,
    npk,
    encryptedBundle,
    shieldKey,
  } = params;

  // 1. CTF.setApprovalForAll(wrappedToken, true)
  //    Allows WrappedCTFToken to pull ERC-1155 from the ProxyWallet
  const ctfApprovalCalldata = encodeFunctionData({
    abi:          CTF_ABI,
    functionName: "setApprovalForAll",
    args:         [wrappedToken, true],
  });

  // 2. WrappedCTFToken.wrap(amount)
  //    Pulls ERC-1155 from ProxyWallet, mints ERC-20 to ProxyWallet
  const wrapCalldata = encodeFunctionData({
    abi:          WRAPPED_CTF_ABI,
    functionName: "wrap",
    args:         [amount],
  });

  // 3. WrappedCTFToken.approve(RAILGUN_SMART_WALLET, amount)
  //    Allows Railgun to pull ERC-20 from ProxyWallet
  const approveCalldata = encodeFunctionData({
    abi:          WRAPPED_CTF_ABI,
    functionName: "approve",
    args:         [RAILGUN_SMART_WALLET, amount],
  });

  // 4. RailgunSmartWallet.shield([...], [...])
  //    Shields ERC-20 into Railgun — creates a private UTXO note for Alice
  const shieldRequest = {
    npk,
    token: {
      tokenType:    0 as const, // ERC20
      tokenAddress: wrappedToken,
      tokenSubID:   0n,
    },
    value: amount as unknown as bigint, // Railgun uses uint120 on-chain
  };

  const shieldCiphertext = {
    encryptedBundle,
    shieldKey,
  };

  const shieldCalldata = encodeFunctionData({
    abi:          RAILGUN_SHIELD_ABI,
    functionName: "shield",
    args:         [[shieldRequest], [shieldCiphertext]],
  });

  return {
    targets:  [ctfAddress, wrappedToken, wrappedToken, RAILGUN_SMART_WALLET],
    values:   [0n, 0n, 0n, 0n],
    payloads: [ctfApprovalCalldata, wrapCalldata, approveCalldata, shieldCalldata],
  };
}

// ── Digest builder (mirrors ProxyWallet._batchMetaTxDigest) ──────────────────

/**
 * Build the digest that Alice's ephemeral EOA must sign for batchExecuteWithSig.
 * Mirrors ProxyWallet._batchMetaTxDigest + _recoverEthSign exactly.
 *
 * @param nonce         Current ProxyWallet nonce.
 * @param chainId       Chain ID (137 for Polygon mainnet).
 * @param proxyWallet   ProxyWallet address.
 * @param batch         Batch payload from buildShieldBatch().
 * @returns             The eth_sign digest to sign with the ephemeral EOA key.
 */
export function buildBatchMetaTxDigest(
  nonce:       bigint,
  chainId:     number,
  proxyWallet: Address,
  batch:       BatchPayload,
): Hex {
  // Hash each payload element (mirrors _hashBytesArray)
  const payloadHashes = batch.payloads.map(p => keccak256(p));
  const payloadsHash  = keccak256(concat(payloadHashes.map(h => toBytes(h))));

  // Build inner digest
  const innerDigest = keccak256(encodeAbiParameters(
    parseAbiParameters("uint256, uint256, address, address[], uint256[], bytes32"),
    [nonce, BigInt(chainId), proxyWallet, batch.targets, batch.values, payloadsHash],
  ));

  // eth_sign prefix: "\x19Ethereum Signed Message:\n32" + innerDigest
  const prefixed = keccak256(concat([
    toBytes("\x19Ethereum Signed Message:\n32"),
    toBytes(innerDigest),
  ]));

  return prefixed;
}

// ── Convenience: full payload for submitShield ────────────────────────────────

export interface ShieldSubmitParams extends ShieldParams {
  nonce:       bigint;
  chainId:     number;
  proxyWallet: Address;
}

/**
 * Build the complete batchExecuteWithSig arguments and the digest to sign.
 * Caller signs the digest with the ephemeral EOA key, then submits to the chain.
 */
export function prepareShieldSubmit(params: ShieldSubmitParams): {
  batch:  BatchPayload;
  digest: Hex;
} {
  const batch  = buildShieldBatch(params);
  const digest = buildBatchMetaTxDigest(
    params.nonce,
    params.chainId,
    params.proxyWallet,
    batch,
  );
  return { batch, digest };
}
