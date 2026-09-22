import type { V13BatchAction, V13BatchJournal } from "./v13BatchJournal.js";

export interface V13Transaction { send(): Promise<`0x${string}`>; confirm(hash: `0x${string}`): Promise<void> }

export async function executeV13Action(journal: V13BatchJournal, batchId: string, action: V13BatchAction,
  payload: Record<string, string>, transaction: V13Transaction): Promise<`0x${string}`> {
  const intent = await journal.prepare(batchId, action, payload);
  if (intent.state === "confirmed") {
    if (!intent.txHash) throw new Error("Confirmed v13 action has no transaction hash");
    return intent.txHash as `0x${string}`;
  }
  if (intent.state === "uncertain" || intent.state === "submitting") {
    throw new Error(`V13 ${action} is ${intent.state}; reconcile before proceeding`);
  }
  let hash = intent.txHash as `0x${string}` | null;
  if (intent.state === "prepared") {
    if (!await journal.claim(batchId, action)) throw new Error(`Another worker claimed v13 ${action}`);
    try {
      hash = await transaction.send();
      await journal.recordBroadcast(batchId, action, hash);
    } catch (error) {
      await journal.recordUncertain(batchId, action, String(error));
      throw new Error(`V13 ${action} submission is uncertain; reconcile before proceeding`, { cause: error });
    }
  }
  if (!hash) throw new Error(`V13 ${action} has no transaction hash`);
  await transaction.confirm(hash);
  await journal.recordConfirmed(batchId, action);
  return hash;
}
