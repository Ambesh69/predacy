import type { SignedOrder } from "@polymarket/client/actions";
import { postOrder } from "@polymarket/client/actions";
import { WalletType } from "@polymarket/client";
import { getAddress } from "viem";
import { awaitRoutedDepositWalletFunding, type DepositWalletClient, type RoutedFundingRequest } from "./depositWalletClient.js";
import type { V11OrderJournal } from "./v11OrderJournal.js";

export interface ClobOrderPoster {
  postOrder(order: SignedOrder): Promise<{
    ok: boolean;
    orderId?: string;
    status?: string;
    code?: string;
    message?: string;
  }>;
}

function explicitRequestRejection(error: unknown): {
  ok: false; status: number; code?: string; message: string;
} | null {
  if (!(error instanceof Error) || error.name !== "RequestRejectedError") return null;
  const status = (error as Error & { status?: unknown }).status;
  const code = (error as Error & { code?: unknown }).code;
  if (typeof status !== "number" || status < 400 || status >= 500 || status === 429) return null;
  return {
    ok: false,
    status,
    ...(typeof code === "string" && code ? { code } : {}),
    message: error.message,
  };
}

/** One network attempt only. A timeout or process crash requires reconciliation. */
export async function submitV11OrderOnce(
  journal: V11OrderJournal,
  client: ClobOrderPoster,
  batchId: string,
  legId: string,
  assertFunding: () => Promise<void>,
): Promise<string> {
  // Run immediately before claiming the one-shot submission. A failed gate
  // leaves the prepared order untouched and never sends a CLOB request.
  await assertFunding();
  const intent = await journal.claimForSubmission(batchId, legId);
  if (!intent) throw new Error("V11 order was already submitted or needs reconciliation; refusing a duplicate post");

  let response: Awaited<ReturnType<ClobOrderPoster["postOrder"]>>;
  try {
    response = await client.postOrder(intent.signedOrder);
  } catch (error) {
    const rejected = explicitRequestRejection(error);
    if (rejected) {
      await journal.recordRejected(batchId, legId, rejected);
      throw new Error(`CLOB rejected v11 order: ${rejected.code ?? rejected.message}`);
    }
    await journal.recordUncertain(batchId, legId, String(error));
    throw new Error("CLOB submission outcome is uncertain; reconcile before any further action", { cause: error });
  }

  if (!response.ok) {
    await journal.recordRejected(batchId, legId, response);
    throw new Error(`CLOB rejected v11 order: ${response.code ?? response.message ?? "unknown reason"}`);
  }
  if (!response.orderId) {
    await journal.recordUncertain(batchId, legId, "Accepted response had no order ID");
    throw new Error("CLOB acceptance lacks an order ID; reconcile before any further action");
  }
  await journal.recordAccepted(batchId, legId, response.orderId, response);
  return response.orderId;
}

/** The only v11 SDK post path: re-check maker identity and confirmed funding. */
export async function submitFundedV11OrderOnce(
  journal: V11OrderJournal,
  client: DepositWalletClient,
  batchId: string,
  legId: string,
  funding: RoutedFundingRequest,
): Promise<string> {
  const intent = await journal.get(batchId, legId);
  if (!intent) throw new Error("No prepared v11 CLOB order for this leg");
  const wallet = client.account.wallet;
  if (client.account.walletType !== WalletType.DEPOSIT_WALLET ||
      getAddress(intent.signedOrder.maker) !== getAddress(wallet) ||
      getAddress(intent.signedOrder.signer) !== getAddress(wallet) ||
      intent.signedOrder.signatureType !== 3) {
    throw new Error("Journaled order does not belong to the configured Deposit Wallet");
  }
  return submitV11OrderOnce(journal, { postOrder: postOrder(client) }, batchId, legId,
    () => awaitRoutedDepositWalletFunding(client, funding));
}
