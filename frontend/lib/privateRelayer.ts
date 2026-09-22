import { keccak256, type Hex } from "viem";
import { getRelayerUrl } from "./relayerUrl";

export interface PrivateOrderSubmission {
  marketId: Hex;
  positionTokenId: string;
  priceTick: string;
  depositWallet: `0x${string}`;
  collateralAsset: Hex;
  positionAsset: Hex;
  orderCommitment: Hex;
  receiptToken: Hex;
  order: {
    deposit: string;
    limitPrice: string;
    orderSecret: Hex;
    orderLeafIndex: string;
    refundPublicKey: Hex;
    positionPublicKey: Hex;
  };
}

export interface PrivateAllocationReceipt {
  state: "pending" | "settled";
  spent?: string;
  shares?: string;
  refund?: string;
}

function assertSecret(value: Hex): void {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error("Private receipt token must be 32 bytes");
}

export async function submitPrivateOrder(submission: PrivateOrderSubmission): Promise<{
  state: "queued" | "batched";
  orderCommitment: Hex;
  batchId?: Hex;
}> {
  assertSecret(submission.receiptToken);
  const relayer = getRelayerUrl();
  if (!relayer) throw new Error("Private relayer is not configured");
  const { receiptToken, ...order } = submission;
  const response = await fetch(`${relayer}/v13/private-order`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...order, receiptTokenHash: keccak256(receiptToken) }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error ?? `Private relayer returned ${response.status}`);
  return result;
}

export async function getPrivateAllocationReceipt(
  orderCommitment: Hex,
  receiptToken: Hex,
): Promise<PrivateAllocationReceipt> {
  assertSecret(orderCommitment);
  assertSecret(receiptToken);
  const relayer = getRelayerUrl();
  if (!relayer) throw new Error("Private relayer is not configured");
  const response = await fetch(`${relayer}/v13/private-receipt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ orderCommitment, receiptToken }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error ?? `Private relayer returned ${response.status}`);
  return result;
}
