export type ActionKind = "order" | "claim" | "sweep" | "transfer";

export type ProgressStage = "idle" | "submitting" | "confirming" | "settled" | "failed";

export interface ActionProgressState {
  open: boolean;
  kind: ActionKind;
  title: string;
  stage: ProgressStage;
  message: string;
  helper?: string;
  txHash?: `0x${string}` | string;
  startedAt: number | null;
  error?: string;
}

export const IDLE_ACTION_PROGRESS: ActionProgressState = {
  open: false,
  kind: "order",
  title: "",
  stage: "idle",
  message: "",
  startedAt: null,
};

export interface ActionTiming {
  kind: ActionKind;
  startedAt?: number;
  requestSentAt?: number;
  txHashAt?: number;
  settledAt?: number;
}

export function emitActionTiming(t: ActionTiming) {
  if (typeof window === "undefined") return;
  const payload = {
    ...t,
    requestMs: t.startedAt && t.requestSentAt ? t.requestSentAt - t.startedAt : undefined,
    confirmMs: t.txHashAt && t.settledAt ? t.settledAt - t.txHashAt : undefined,
    totalMs: t.startedAt && t.settledAt ? t.settledAt - t.startedAt : undefined,
  };
  // Lightweight local instrumentation for settlement latency investigation.
  (window as any).__predacyActionTimings = [
    ...(((window as any).__predacyActionTimings ?? []) as Array<Record<string, unknown>>),
    payload,
  ].slice(-150);
  console.info("[Predacy][timing]", payload);
}
