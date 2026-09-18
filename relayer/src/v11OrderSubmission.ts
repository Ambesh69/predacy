import type { SignedOrder } from "@polymarket/client/actions";
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

/** One network attempt only. A timeout or process crash requires reconciliation. */
export async function submitV11OrderOnce(
  journal: V11OrderJournal,
  client: ClobOrderPoster,
  batchId: string,
  legId: string,
): Promise<string> {
  const intent = await journal.claimForSubmission(batchId, legId);
  if (!intent) throw new Error("V11 order was already submitted or needs reconciliation; refusing a duplicate post");

  let response: Awaited<ReturnType<ClobOrderPoster["postOrder"]>>;
  try {
    response = await client.postOrder(intent.signedOrder);
  } catch (error) {
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
