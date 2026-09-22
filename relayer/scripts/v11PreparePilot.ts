import "dotenv/config";
import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import {
  createPublicClient,
  encodeAbiParameters,
  encodeFunctionData,
  formatUnits,
  getAddress,
  http,
  keccak256,
  parseAbi,
  type Address,
  type Hex,
} from "viem";
import { polygon } from "viem/chains";
import { proveV11Allocation } from "../src/v11AllocationProver.js";

const vaultAbi = parseAbi([
  "function tradingPaused() view returns (bool)",
  "function nextBatchId() view returns (uint256)",
  "function activeBatchId() view returns (uint256)",
  "function usdce() view returns (address)",
  "function allocationVerifier() view returns (address)",
  "function openBatch(bytes32,uint256,uint256) returns (uint256)",
  "function setTradingPaused(bool)",
  "function commitBuy(uint256,bytes32,uint8,uint256,bytes)",
  "function closeBatch(uint256)",
  "function claim(uint256,uint256)",
]);
const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
]);
const verifierAbi = parseAbi([
  "function verify(bytes,bytes32[]) view returns (bool)",
]);

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function uint(name: string): bigint {
  const value = required(name);
  if (!/^[1-9]\d*$/.test(value)) throw new Error(`${name} must be a positive integer`);
  return BigInt(value);
}

function bytes32(name: string): Hex {
  const value = required(name);
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error(`${name} must be bytes32`);
  return value as Hex;
}

async function main(): Promise<void> {
  const rpcUrl = required("RPC_URL");
  const vault = getAddress(required("V11_VAULT_ADDRESS"));
  const guardian = getAddress(required("V11_GUARDIAN"));
  const depositWallet = getAddress(required("V11_DEPOSIT_WALLET"));
  const marketId = bytes32("V11_PILOT_MARKET_ID");
  const yesTokenId = uint("V11_PILOT_YES_TOKEN_ID");
  const noTokenId = uint("V11_PILOT_NO_TOKEN_ID");
  const deposit = uint("V11_PILOT_DEPOSIT");
  const limitPrice = uint("V11_PILOT_LIMIT_PRICE");
  const priceTick = uint("V11_PILOT_PRICE_TICK");
  const output = required("V11_PILOT_OUTPUT");
  const sideName = required("V11_PILOT_SIDE");
  const side = sideName === "YES_BUY" ? 0 : sideName === "NO_BUY" ? 2 : -1;
  if (side < 0) throw new Error("The funded pilot supports YES_BUY or NO_BUY only");
  if (limitPrice >= 1_000_000n || priceTick >= 1_000_000n) {
    throw new Error("Invalid pilot price bounds");
  }

  const reader = createPublicClient({ chain: polygon, transport: http(rpcUrl) });
  if (await reader.getChainId() !== polygon.id) throw new Error("RPC is not Polygon mainnet");
  const [paused, nextBatchId, activeBatchId, usdce, verifier] = await Promise.all([
    reader.readContract({ address: vault, abi: vaultAbi, functionName: "tradingPaused" }),
    reader.readContract({ address: vault, abi: vaultAbi, functionName: "nextBatchId" }),
    reader.readContract({ address: vault, abi: vaultAbi, functionName: "activeBatchId" }),
    reader.readContract({ address: vault, abi: vaultAbi, functionName: "usdce" }),
    reader.readContract({ address: vault, abi: vaultAbi, functionName: "allocationVerifier" }),
  ]);
  if (!paused || nextBatchId <= 0n || activeBatchId !== 0n) {
    throw new Error("Pilot preparation requires a paused vault with no active batch");
  }
  const [balance, allowance] = await Promise.all([
    reader.readContract({ address: usdce, abi: erc20Abi, functionName: "balanceOf", args: [guardian] }),
    reader.readContract({ address: usdce, abi: erc20Abi, functionName: "allowance", args: [guardian, vault] }),
  ]);
  if (balance < deposit) throw new Error("Guardian does not hold enough USDC.e for the pilot");

  const salt = `0x${randomBytes(32).toString("hex")}` as Hex;
  const commitment = keccak256(encodeAbiParameters(
    [{ type: "bytes32" }, { type: "uint8" }, { type: "uint256" }, { type: "uint256" }, { type: "bytes32" }],
    [marketId, side, deposit, limitPrice, salt],
  ));
  const initial = await proveV11Allocation({
    marketId,
    commitment,
    side,
    deposit,
    limitPrice,
    salt,
    filledShares: 0n,
    usdcSettled: 0n,
    refund: deposit,
  });
  const proofValid = await reader.readContract({
    address: verifier,
    abi: verifierAbi,
    functionName: "verify",
    args: [initial.proof, initial.publicInputs],
  });
  if (!proofValid) throw new Error("Deployed verifier rejected the generated initial proof");

  const batchId = nextBatchId;
  const manifest = {
    batchId: batchId.toString(),
    marketId,
    commitment,
    side: sideName,
    deposit: deposit.toString(),
    limitPrice: limitPrice.toString(),
    salt,
    tokenId: (side === 0 ? yesTokenId : noTokenId).toString(),
    priceTick: priceTick.toString(),
    depositWallet,
  };
  const transactions = {
    approve: {
      to: usdce,
      data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [vault, deposit] }),
    },
    unpause: {
      to: vault,
      data: encodeFunctionData({ abi: vaultAbi, functionName: "setTradingPaused", args: [false] }),
    },
    openBatch: {
      to: vault,
      data: encodeFunctionData({ abi: vaultAbi, functionName: "openBatch", args: [marketId, yesTokenId, noTokenId] }),
    },
    commit: {
      to: vault,
      data: encodeFunctionData({
        abi: vaultAbi,
        functionName: "commitBuy",
        args: [batchId, commitment, side, deposit, initial.proof],
      }),
    },
    closeBatch: {
      to: vault,
      data: encodeFunctionData({ abi: vaultAbi, functionName: "closeBatch", args: [batchId] }),
    },
    claim: {
      to: vault,
      data: encodeFunctionData({ abi: vaultAbi, functionName: "claim", args: [batchId, 0n] }),
    },
  };
  await writeFile(output, JSON.stringify({ manifest, transactions }, null, 2), {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  console.log(JSON.stringify({
    prepared: true,
    batchId: batchId.toString(),
    commitment,
    proofBytes: (initial.proof.length - 2) / 2,
    verifier: getAddress(verifier),
    guardian,
    guardianUsdce: formatUnits(balance, 6),
    existingAllowanceUsdce: formatUnits(allowance, 6),
    output,
  }));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "V11 pilot preparation failed");
  process.exitCode = 1;
});
