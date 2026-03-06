/**
 * Active chain configuration — driven by NEXT_PUBLIC_CHAIN_ID.
 *
 * Polygon Amoy testnet (default): NEXT_PUBLIC_CHAIN_ID=80002
 * Polygon mainnet:                NEXT_PUBLIC_CHAIN_ID=137
 *
 * Set in .env.local or in Vercel / Railway dashboard.
 */
import { polygon, polygonAmoy } from "viem/chains";

const envChainId = parseInt(process.env.NEXT_PUBLIC_CHAIN_ID ?? "80002");

export const ACTIVE_CHAIN    = envChainId === polygon.id ? polygon : polygonAmoy;
export const IS_MAINNET      = envChainId === polygon.id;

/** Chain ID as 0x-prefixed hex string (for EIP-1559 / MetaMask wallet_switchEthereumChain) */
export const ACTIVE_CHAIN_ID_HEX = `0x${envChainId.toString(16)}` as const;

/** Human-readable name for error messages */
export const ACTIVE_CHAIN_NAME = IS_MAINNET ? "Polygon" : "Polygon Amoy";

/** EIP-1559 gas params — Polygon Amoy requires min 25 gwei priority fee */
export const CHAIN_GAS = IS_MAINNET
  ? {
      maxPriorityFeePerGas:  100_000_000_000n, // 100 gwei
      maxFeePerGas:         2_000_000_000_000n, // 2000 gwei — mainnet base fee can spike to 700+ gwei
    } as const
  : {
      maxPriorityFeePerGas: 30_000_000_000n, // 30 gwei  (> 25 gwei Amoy floor)
      maxFeePerGas:         35_000_000_000n, // 35 gwei
    } as const;
