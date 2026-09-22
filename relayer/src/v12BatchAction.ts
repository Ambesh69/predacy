import type { V12BatchAction, V12BatchJournal } from "./v12BatchJournal.js";

export interface V12BatchTransaction {
  send(): Promise<`0x${string}`>;
  confirm(txHash: `0x${string}`): Promise<void>;
}

export async function executeV12BatchAction(
  journal: V12BatchJournal,
  batchId: string,
  action: V12BatchAction,
  payload: Record<string, string>,
  transaction: V12BatchTransaction,
): Promise<`0x${string}`> {
  const intent = await journal.prepare(batchId, action, payload);
  if (intent.state === "confirmed") {
    if (!intent.txHash) throw new Error("Confirmed v12 action is missing a transaction hash");
    return intent.txHash as `0x${string}`;
  }
  if (intent.state === "uncertain" || intent.state === "submitting") {
    throw new Error(`V12 ${action} is ${intent.state}; reconcile before proceeding`);
  }
  let txHash = intent.txHash as `0x${string}` | null;
  if (intent.state === "prepared") {
    const claimed = await journal.claim(batchId, action);
    if (!claimed) throw new Error(`Another worker claimed v12 ${action}; reconcile before proceeding`);
    try {
      txHash = await transaction.send();
      await journal.recordBroadcast(batchId, action, txHash);
    } catch (error) {
      await journal.recordUncertain(batchId, action, String(error));
      throw new Error(`V12 ${action} submission is uncertain; reconcile before proceeding`, { cause: error });
    }
  }
  if (!txHash) throw new Error(`V12 ${action} has no transaction hash`);
  try {
    await transaction.confirm(txHash);
  } catch (error) {
    throw new Error(`V12 ${action} confirmation is pending; check the recorded hash`, { cause: error });
  }
  await journal.recordConfirmed(batchId, action);
  return txHash;
}
