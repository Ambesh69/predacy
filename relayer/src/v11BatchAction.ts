import type { V11BatchAction, V11BatchJournal } from "./v11BatchJournal.js";

export interface V11BatchTransaction {
  send(): Promise<`0x${string}`>;
  confirm(txHash: `0x${string}`): Promise<void>;
}

/** A restarted worker may verify a recorded hash, but never sends the action twice. */
export async function executeV11BatchAction(
  journal: V11BatchJournal,
  batchId: string,
  action: V11BatchAction,
  payload: Record<string, string>,
  transaction: V11BatchTransaction,
): Promise<`0x${string}`> {
  const intent = await journal.prepare(batchId, action, payload);
  if (intent.state === "confirmed") {
    if (!intent.txHash) throw new Error("Confirmed v11 action is missing a transaction hash");
    return intent.txHash as `0x${string}`;
  }
  if (intent.state === "uncertain" || intent.state === "submitting") {
    throw new Error(`V11 ${action} is ${intent.state}; reconcile before proceeding`);
  }
  let txHash = intent.txHash as `0x${string}` | null;
  if (intent.state === "prepared") {
    const claimed = await journal.claim(batchId, action);
    if (!claimed) throw new Error(`Another worker claimed v11 ${action}; reconcile before proceeding`);
    try {
      txHash = await transaction.send();
      await journal.recordBroadcast(batchId, action, txHash);
    } catch (error) {
      await journal.recordUncertain(batchId, action, String(error));
      throw new Error(`V11 ${action} submission is uncertain; reconcile before proceeding`, { cause: error });
    }
  }
  if (!txHash) throw new Error(`V11 ${action} has no transaction hash`);
  try {
    await transaction.confirm(txHash);
  } catch (error) {
    // Retain the hash so a restart can check the same transaction, not send again.
    throw new Error(`V11 ${action} confirmation is pending; check the recorded hash`, { cause: error });
  }
  await journal.recordConfirmed(batchId, action);
  return txHash;
}
