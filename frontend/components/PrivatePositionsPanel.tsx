"use client";

import { useState } from "react";
import type { Address, Hex } from "viem";
import { loadPrivateOrders, type PrivateOrderRecord } from "@/lib/privateNotes";

function amount(value?: string): string {
  return value === undefined ? "-" : (Number(BigInt(value)) / 1_000_000).toFixed(2);
}

export default function PrivatePositionsPanel({
  wallet,
  marketId,
  unlock,
  withdraw,
  cancel,
}: {
  wallet: Address;
  marketId: string;
  unlock: () => Promise<Hex>;
  withdraw: (order: PrivateOrderRecord, output: "refund" | "position") => Promise<void>;
  cancel: (order: PrivateOrderRecord) => Promise<void>;
}) {
  const [orders, setOrders] = useState<PrivateOrderRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [withdrawing, setWithdrawing] = useState<string | null>(null);

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      const signature = await unlock();
      const { refreshPrivateAllocations } = await import("@/lib/privateTradeFlow");
      await refreshPrivateAllocations({ wallet, vaultSignature: signature });
      setOrders((await loadPrivateOrders(wallet, signature)).filter(
        (order) => order.marketId.toLowerCase() === marketId.toLowerCase(),
      ));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Private position refresh failed");
    } finally {
      setLoading(false);
    }
  };

  const handleWithdraw = async (order: PrivateOrderRecord, output: "refund" | "position") => {
    setWithdrawing(`${order.orderCommitment}:${output}`);
    setError(null);
    try {
      await withdraw(order, output);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Private withdrawal failed");
    } finally {
      setWithdrawing(null);
    }
  };

  const handleCancel = async (order: PrivateOrderRecord) => {
    setWithdrawing(`${order.orderCommitment}:cancel`);
    setError(null);
    try {
      await cancel(order);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Private cancellation failed");
    } finally {
      setWithdrawing(null);
    }
  };

  return (
    <div className="flex-1 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-[10px] text-muted tracking-widest uppercase">Private positions</p>
        <button
          type="button"
          onClick={refresh}
          disabled={loading}
          className="border border-border px-3 py-1.5 text-[10px] text-text uppercase tracking-widest hover:border-border-bright disabled:opacity-40"
        >
          {loading ? "Checking..." : "Unlock and refresh"}
        </button>
      </div>
      {error && <p className="text-danger text-xs">{error}</p>}
      {!loading && orders.length === 0 && !error && (
        <p className="text-muted text-xs py-8 text-center">Unlock the private vault to view this market.</p>
      )}
      {orders.map((order) => (
        <div key={order.orderCommitment} className="border border-border p-3 space-y-2">
          <div className="flex justify-between gap-3">
            <span className="text-xs text-text">{order.state === "settled" ? "Settled" : "Processing"}</span>
            <span className="text-[10px] text-muted uppercase tracking-widest">{order.state}</span>
          </div>
          <div className="grid grid-cols-3 gap-2 text-[10px]">
            <div><p className="text-muted">Spent</p><p className="text-text">${amount(order.spent)}</p></div>
            <div><p className="text-muted">Shares</p><p className="text-text">{amount(order.shares)}</p></div>
            <div><p className="text-muted">Refund</p><p className="text-text">${amount(order.refund)}</p></div>
          </div>
          {order.state === "settled" && (
            <div className="flex gap-2 pt-1">
              {BigInt(order.refund ?? "0") > 0n && !order.refundWithdrawn && (
                <button
                  type="button"
                  onClick={() => handleWithdraw(order, "refund")}
                  disabled={withdrawing !== null}
                  className="flex-1 border border-border px-2 py-1.5 text-[10px] text-text uppercase tracking-widest disabled:opacity-40"
                >
                  {withdrawing === `${order.orderCommitment}:refund` ? "Proving..." : "Withdraw refund"}
                </button>
              )}
              {BigInt(order.shares ?? "0") > 0n && !order.positionWithdrawn && (
                <button
                  type="button"
                  onClick={() => handleWithdraw(order, "position")}
                  disabled={withdrawing !== null}
                  className="flex-1 border border-border px-2 py-1.5 text-[10px] text-text uppercase tracking-widest disabled:opacity-40"
                >
                  {withdrawing === `${order.orderCommitment}:position` ? "Proving..." : "Withdraw shares"}
                </button>
              )}
            </div>
          )}
          {["locked", "queued"].includes(order.state) && (
            <button
              type="button"
              onClick={() => handleCancel(order)}
              disabled={withdrawing !== null}
              className="w-full border border-danger/40 px-2 py-1.5 text-[10px] text-danger uppercase tracking-widest disabled:opacity-40"
            >
              {withdrawing === `${order.orderCommitment}:cancel` ? "Proving refund..." : "Cancel and reveal amount"}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
