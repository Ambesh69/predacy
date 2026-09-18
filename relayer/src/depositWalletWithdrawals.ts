import {
  WalletType,
  type Signer,
  type TransactionHandle,
} from "@polymarket/client";
import { prepareGaslessTransaction } from "@polymarket/client/actions";
import {
  createPublicClient,
  encodeFunctionData,
  http,
  parseAbi,
  type Address,
} from "viem";
import { polygon } from "viem/chains";
import type { DepositWalletClient } from "./depositWalletClient.js";

const ctfAbi = parseAbi([
  "function safeTransferFrom(address from, address to, uint256 id, uint256 amount, bytes data)",
  "function balanceOf(address account, uint256 id) view returns (uint256)",
]);

export type GaslessWorkflow = Awaited<ReturnType<typeof prepareGaslessTransaction>>;

export async function completeGaslessWorkflow(
  workflow: GaslessWorkflow,
  signer: Signer,
): Promise<TransactionHandle> {
  let step = await workflow.next();
  while (!step.done) {
    const request = step.value;
    if (request.kind === "requestAddress") {
      step = await workflow.next(await signer.getAddress());
    } else if (request.kind === "signGaslessMessage") {
      step = await workflow.next(await signer.signMessage(request.payload));
    } else if (request.kind === "signGaslessTypedData") {
      step = await workflow.next(await signer.signTypedData(request.payload));
    } else {
      throw new Error("Unsupported Deposit Wallet workflow request");
    }
  }
  return step.value;
}

/** Withdraws an exact CTF amount. A timeout must be reconciled, never resubmitted blindly. */
export async function withdrawPositionFromDepositWallet(
  client: DepositWalletClient,
  signer: Signer,
  rpcUrl: string,
  ctfAddress: Address,
  vaultAddress: Address,
  tokenId: bigint,
  amount: bigint,
): Promise<TransactionHandle> {
  if (client.account.walletType !== WalletType.DEPOSIT_WALLET) {
    throw new Error("Position withdrawal requires a Deposit Wallet");
  }
  if (amount <= 0n || tokenId <= 0n) throw new Error("Position withdrawal amount and token ID must be positive");

  const reader = createPublicClient({ chain: polygon, transport: http(rpcUrl) });
  if (await reader.getChainId() !== polygon.id) throw new Error("Position withdrawal RPC is not Polygon mainnet");
  const before = await reader.readContract({
    address: ctfAddress, abi: ctfAbi, functionName: "balanceOf", args: [vaultAddress, tokenId],
  });
  const data = encodeFunctionData({
    abi: ctfAbi,
    functionName: "safeTransferFrom",
    args: [client.account.wallet, vaultAddress, tokenId, amount, "0x"],
  });
  const workflow = await prepareGaslessTransaction(client, {
    calls: [{ to: ctfAddress, data }],
    metadata: `Return ${amount} shares to vault`,
  });
  const handle = await completeGaslessWorkflow(workflow, signer);
  await handle.wait();

  // Relayer confirmation and Polygon RPC visibility can lag each other.
  for (let attempt = 0; attempt < 30; attempt++) {
    const after = await reader.readContract({
      address: ctfAddress, abi: ctfAbi, functionName: "balanceOf", args: [vaultAddress, tokenId],
    });
    if (after >= before + amount) return handle;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error("Deposit Wallet withdrawal confirmation is uncertain; reconcile before retrying");
}
