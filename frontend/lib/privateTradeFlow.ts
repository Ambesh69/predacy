import { encodeFunctionData, keccak256, type Address, type Hex } from "viem";
import { ERC20_ABI } from "./contracts";
import { getPrivateContracts, isPrivateTradingEnabled, SHIELDED_POOL_ABI } from "./privateContracts";
import { loadPrivateMerkleWitness, loadPrivateRecoveryEvents, loadPrivateTree } from "./privateMerkle";
import {
  loadPrivateNotes, loadPrivateOrders, savePrivateNotes, savePrivateOrders,
  type PrivateNoteRecord, type PrivateOrderRecord,
} from "./privateNotes";
import {
  privateNoteCommitment, privateNoteNullifier, privateOrderCommitment, privateOrderNullifier,
  provePrivateBuyOrder, provePrivateOrderCancellation, provePrivateWithdrawal,
} from "./privateProver";
import { submitPrivateOrder } from "./privateRelayer";
import { getPrivateAllocationReceipt } from "./privateRelayer";
import { publicClient } from "./publicClient";

function randomWord(): Hex {
  const value = crypto.getRandomValues(new Uint8Array(32));
  return `0x${Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("")}` as Hex;
}

interface RequestProvider {
  request(args: { method: string; params?: any[] }): Promise<any>;
}

async function send(provider: RequestProvider, from: Address, to: Address, data: Hex): Promise<Hex> {
  const hash = await provider.request({ method: "eth_sendTransaction", params: [{ from, to, data }] }) as Hex;
  const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 2, timeout: 180_000 });
  if (receipt.status !== "success") throw new Error("Private order transaction reverted");
  return hash;
}

export async function executePrivateBuy(args: {
  provider: RequestProvider;
  wallet: Address;
  vaultSignature: Hex;
  usdc: Address;
  depositWallet: Address;
  marketId: Hex;
  positionTokenId: bigint;
  priceTick: bigint;
  amount: bigint;
  limitPrice: bigint;
  side: "YES" | "NO";
  onStep?: (step: "depositing" | "proving" | "locking" | "queuing") => void;
}): Promise<{ order: PrivateOrderRecord; queueState: "queued" | "batched" }> {
  const deployment = getPrivateContracts();
  if (!deployment) throw new Error("Private trading is not configured");
  if (!isPrivateTradingEnabled()) throw new Error("Private trading is paused");
  if (args.amount <= 0n) throw new Error("Private order amount must be positive");
  if (args.limitPrice <= 0n || args.limitPrice >= 1_000_000n) throw new Error("Invalid private order limit");

  const [paused, collateralAsset, positionAsset] = await Promise.all([
    publicClient.readContract({ address: deployment.pool, abi: SHIELDED_POOL_ABI, functionName: "paused" }),
    publicClient.readContract({ address: deployment.pool, abi: SHIELDED_POOL_ABI, functionName: "collateralAssetId" }),
    publicClient.readContract({ address: deployment.pool, abi: SHIELDED_POOL_ABI,
      functionName: "positionAssetId", args: [args.positionTokenId] }),
  ]);
  if (paused) throw new Error("Private trading is paused");

  const noteSecret = randomWord();
  const notePublicKey = keccak256(noteSecret);
  const inputNote = privateNoteCommitment(collateralAsset, args.amount, notePublicKey);
  const refundSecret = randomWord();
  const refundPublicKey = keccak256(refundSecret);
  const positionSecret = randomWord();
  const positionPublicKey = keccak256(positionSecret);
  const orderSecret = randomWord();
  const receiptToken = randomWord();

  const notes = await loadPrivateNotes(args.wallet, args.vaultSignature);
  const note: PrivateNoteRecord = {
    commitment: inputNote, assetId: collateralAsset, amount: args.amount.toString(), publicKey: notePublicKey,
    secret: noteSecret, marketId: args.marketId, side: args.side, state: "pending", createdAt: Date.now(),
  };
  const order: PrivateOrderRecord = {
    orderCommitment: privateOrderCommitment({ positionAsset, deposit: args.amount, limitPrice: args.limitPrice,
      refundPublicKey, positionPublicKey, orderSecret }),
    receiptToken, inputNote, deposit: args.amount.toString(), limitPrice: args.limitPrice.toString(),
    marketId: args.marketId, positionTokenId: args.positionTokenId.toString(), collateralAsset, positionAsset,
    orderSecret, orderLeafIndex: "0", refundSecret, refundPublicKey, positionSecret, positionPublicKey,
    state: "funding", createdAt: Date.now(),
  };
  const persistOrder = async () => {
    const saved = await loadPrivateOrders(args.wallet, args.vaultSignature);
    await savePrivateOrders(args.wallet, args.vaultSignature,
      [order, ...saved.filter((item) => item.orderCommitment !== order.orderCommitment)]);
  };
  // Recovery secrets must be durable before either deposit or lock can be broadcast.
  await savePrivateNotes(args.wallet, args.vaultSignature, [note, ...notes]);
  await persistOrder();

  args.onStep?.("depositing");
  await send(args.provider, args.wallet, args.usdc, encodeFunctionData({
    abi: ERC20_ABI, functionName: "approve", args: [deployment.pool, args.amount],
  }));
  await send(args.provider, args.wallet, deployment.pool, encodeFunctionData({
    abi: SHIELDED_POOL_ABI, functionName: "deposit", args: [args.amount, notePublicKey],
  }));
  const merkle = await loadPrivateMerkleWitness(
    publicClient, deployment.pool, deployment.deploymentBlock, inputNote,
  );
  note.leafIndex = merkle.index.toString();
  note.state = "spendable";
  order.state = "funded";
  await savePrivateNotes(args.wallet, args.vaultSignature, [note, ...notes]);
  await persistOrder();

  args.onStep?.("proving");
  const authorization = await provePrivateBuyOrder({
    collateralAsset, positionAsset, deposit: args.amount, limitPrice: args.limitPrice,
    noteSecret, merkle, refundPublicKey, positionPublicKey, orderSecret,
  });
  if (authorization.orderCommitment !== order.orderCommitment) throw new Error("Private order proof differs from saved recovery data");
  order.state = "locking";
  await persistOrder();
  args.onStep?.("locking");
  await send(args.provider, args.wallet, deployment.pool, encodeFunctionData({
    abi: SHIELDED_POOL_ABI, functionName: "lockOrder",
    args: [authorization.proof, authorization.root, authorization.nullifier, authorization.orderCommitment],
  }));
  const orderMerkle = await loadPrivateMerkleWitness(
    publicClient, deployment.pool, deployment.deploymentBlock, authorization.orderCommitment,
  );
  note.state = "locked";
  await savePrivateNotes(args.wallet, args.vaultSignature, [note, ...notes]);

  order.orderLeafIndex = orderMerkle.index.toString();
  order.state = "queued";
  await persistOrder();

  args.onStep?.("queuing");
  const queued = await submitPrivateOrder({
    marketId: args.marketId,
    positionTokenId: args.positionTokenId.toString(),
    priceTick: args.priceTick.toString(),
    depositWallet: args.depositWallet,
    collateralAsset,
    positionAsset,
    orderCommitment: authorization.orderCommitment,
    receiptToken,
    order: {
      deposit: args.amount.toString(),
      limitPrice: args.limitPrice.toString(),
      orderSecret,
      orderLeafIndex: orderMerkle.index.toString(),
      refundPublicKey,
      positionPublicKey,
    },
  });
  order.state = queued.state;
  await persistOrder();
  return { order, queueState: queued.state };
}

export async function refreshPrivateAllocations(args: {
  wallet: Address;
  vaultSignature: Hex;
}): Promise<PrivateOrderRecord[]> {
  const deployment = getPrivateContracts();
  if (!deployment) throw new Error("Private trading is not configured");
  const orders = await loadPrivateOrders(args.wallet, args.vaultSignature);
  const notes = await loadPrivateNotes(args.wallet, args.vaultSignature);
  const leaves = await loadPrivateTree(publicClient, deployment.pool, deployment.deploymentBlock);
  const leafIndices = new Map(leaves.map((leaf, index) => [leaf.toLowerCase(), index]));
  const recovery = await loadPrivateRecoveryEvents(publicClient, deployment.pool, deployment.deploymentBlock);
  let changed = false;
  for (const order of orders) {
    if (["funding", "funded", "locking"].includes(order.state)) {
      const note = notes.find((item) => item.commitment === order.inputNote);
      const noteIndex = leafIndices.get(order.inputNote.toLowerCase());
      const orderIndex = leafIndices.get(order.orderCommitment.toLowerCase()) ?? -1;
      if (note && noteIndex !== undefined && note.state !== "spent") {
        note.state = orderIndex >= 0 ? "locked" : "spendable";
        note.leafIndex = noteIndex.toString();
        order.state = orderIndex >= 0 ? "locked" : "funded";
        if (orderIndex >= 0) order.orderLeafIndex = orderIndex.toString();
        changed = true;
      }
    }
    if (["funding", "funded", "locking"].includes(order.state)) continue;
    const orderNullifier = privateOrderNullifier(order.orderCommitment, order.orderSecret).toLowerCase() as Hex;
    const cancelledRefund = recovery.cancellations.get(orderNullifier);
    if (cancelledRefund) {
      const expected = privateNoteCommitment(order.collateralAsset, BigInt(order.deposit), order.refundPublicKey);
      if (cancelledRefund.toLowerCase() !== expected.toLowerCase()) throw new Error("On-chain cancellation refund mismatch");
      order.state = "cancelled";
      order.spent = "0"; order.shares = "0"; order.refund = order.deposit;
      changed = true;
    } else if (order.state === "queued" || order.state === "batched") {
      let receipt: Awaited<ReturnType<typeof getPrivateAllocationReceipt>>;
      try { receipt = await getPrivateAllocationReceipt(order.orderCommitment, order.receiptToken); }
      catch { continue; } // Confirmed on-chain exits remain recoverable during a relayer outage.
      if (receipt.state !== "settled" || receipt.spent === undefined || receipt.shares === undefined ||
          receipt.refund === undefined) continue;
      const spent = BigInt(receipt.spent); const shares = BigInt(receipt.shares); const refund = BigInt(receipt.refund);
      if (spent < 0n || shares < 0n || refund < 0n || spent + refund !== BigInt(order.deposit) ||
          (spent === 0n) !== (shares === 0n) || spent * 1_000_000n > shares * BigInt(order.limitPrice)) {
        throw new Error("Private allocation receipt violates the order's value or price limit");
      }
      order.state = "settled";
      order.spent = receipt.spent; order.shares = receipt.shares; order.refund = receipt.refund;
      changed = true;
    }
    if (order.state !== "settled" && order.state !== "cancelled") continue;

    // Rebuild missing outputs even when only the order write survived a browser interruption.
    const outputs: PrivateNoteRecord[] = [];
    const refund = BigInt(order.refund ?? "0");
    if (refund > 0n && !order.refundWithdrawn) {
      const commitment = privateNoteCommitment(order.collateralAsset, refund, order.refundPublicKey);
      const index = leafIndices.get(commitment.toLowerCase());
      if (index === undefined) throw new Error("Private refund note is not present on-chain");
      outputs.push({
        commitment, assetId: order.collateralAsset, amount: refund.toString(), publicKey: order.refundPublicKey,
        secret: order.refundSecret, leafIndex: index.toString(), marketId: order.marketId,
        state: "spendable", createdAt: Date.now(),
      });
    }
    const shares = BigInt(order.shares ?? "0");
    if (shares > 0n && !order.positionWithdrawn) {
      const commitment = privateNoteCommitment(order.positionAsset, shares, order.positionPublicKey);
      const index = leafIndices.get(commitment.toLowerCase());
      if (index === undefined) throw new Error("Private position note is not present on-chain");
      outputs.push({
        commitment, assetId: order.positionAsset, amount: shares.toString(), publicKey: order.positionPublicKey,
        secret: order.positionSecret, leafIndex: index.toString(), marketId: order.marketId,
        positionTokenId: order.positionTokenId,
        state: "spendable", createdAt: Date.now(),
      });
    }
    for (const output of outputs) {
      if (!notes.some((note) => note.commitment.toLowerCase() === output.commitment.toLowerCase())) {
        notes.unshift(output);
        changed = true;
      }
    }
  }
  for (const note of notes) {
    const nullifier = privateNoteNullifier(note.commitment, note.secret).toLowerCase() as Hex;
    const exit = recovery.withdrawals.get(nullifier);
    if (!exit) continue;
    if (exit.assetId.toLowerCase() !== note.assetId.toLowerCase() || exit.amount !== BigInt(note.amount)) {
      throw new Error("On-chain withdrawal does not match the saved note");
    }
    if (note.state !== "spent") { note.state = "spent"; changed = true; }
  }
  for (const order of orders) {
    const isSpent = (commitment: Hex) => notes.some((note) => note.state === "spent" &&
      note.commitment.toLowerCase() === commitment.toLowerCase());
    if (["funding", "funded", "locking"].includes(order.state) && isSpent(order.inputNote)) {
      order.state = "cancelled"; order.refund = order.deposit; order.spent = "0"; order.shares = "0";
      order.refundWithdrawn = true; changed = true;
    }
    if (BigInt(order.refund ?? "0") > 0n && !order.refundWithdrawn && isSpent(privateNoteCommitment(
      order.collateralAsset, BigInt(order.refund!), order.refundPublicKey))) {
      order.refundWithdrawn = true; changed = true;
    }
    if (BigInt(order.shares ?? "0") > 0n && !order.positionWithdrawn && isSpent(privateNoteCommitment(
      order.positionAsset, BigInt(order.shares!), order.positionPublicKey))) {
      order.positionWithdrawn = true; changed = true;
    }
  }
  if (changed) {
    await Promise.all([
      savePrivateOrders(args.wallet, args.vaultSignature, orders),
      savePrivateNotes(args.wallet, args.vaultSignature, notes),
    ]);
  }
  return orders;
}

export async function withdrawPrivateOrderOutput(args: {
  provider: RequestProvider;
  wallet: Address;
  vaultSignature: Hex;
  order: PrivateOrderRecord;
  output: "refund" | "position";
}): Promise<void> {
  const deployment = getPrivateContracts();
  if (!deployment) throw new Error("Private trading is not configured");
  const orders = await loadPrivateOrders(args.wallet, args.vaultSignature);
  const current = orders.find((order) => order.orderCommitment === args.order.orderCommitment);
  if (!current || !["settled", "cancelled", "funded", "locking"].includes(current.state)) throw new Error("Private order has no available output");
  const unspentDeposit = current.state === "funded" || current.state === "locking";
  if (args.output === "position" && current.state !== "settled") throw new Error("This order has no position output");
  const amount = BigInt(unspentDeposit ? current.deposit : args.output === "refund" ? current.refund ?? "0" : current.shares ?? "0");
  if (amount <= 0n) throw new Error("This private output has no withdrawable balance");
  if ((args.output === "refund" && current.refundWithdrawn) ||
      (args.output === "position" && current.positionWithdrawn)) throw new Error("Private output already withdrawn");
  const asset = args.output === "refund" ? current.collateralAsset : current.positionAsset;
  const publicKey = args.output === "refund" ? current.refundPublicKey : current.positionPublicKey;
  const commitment = unspentDeposit ? current.inputNote : privateNoteCommitment(asset, amount, publicKey);
  const notes = await loadPrivateNotes(args.wallet, args.vaultSignature);
  const note = notes.find((item) => item.commitment.toLowerCase() === commitment.toLowerCase());
  if (!note || note.state !== "spendable") throw new Error("Private output note is missing or already spent");
  const merkle = await loadPrivateMerkleWitness(
    publicClient, deployment.pool, deployment.deploymentBlock, commitment,
  );
  const withdrawal = await provePrivateWithdrawal({
    asset, amount, noteSecret: note.secret, merkle, recipient: args.wallet,
  });
  if (await publicClient.readContract({ address: deployment.pool, abi: SHIELDED_POOL_ABI,
    functionName: "spentNullifiers", args: [withdrawal.nullifier] })) {
    throw new Error("This note is already locked or withdrawn. Refresh the private vault.");
  }
  const data = args.output === "refund"
    ? encodeFunctionData({ abi: SHIELDED_POOL_ABI, functionName: "withdraw",
      args: [withdrawal.proof, withdrawal.root, withdrawal.nullifier, amount, args.wallet] })
    : encodeFunctionData({ abi: SHIELDED_POOL_ABI, functionName: "withdrawPosition",
      args: [withdrawal.proof, withdrawal.root, withdrawal.nullifier,
        BigInt(current.positionTokenId), amount, args.wallet] });
  await send(args.provider, args.wallet, deployment.pool, data);
  note.state = "spent";
  if (args.output === "refund") current.refundWithdrawn = true;
  else current.positionWithdrawn = true;
  if (unspentDeposit) { current.state = "cancelled"; current.refund = current.deposit; }
  await Promise.all([
    savePrivateNotes(args.wallet, args.vaultSignature, notes),
    savePrivateOrders(args.wallet, args.vaultSignature, orders),
  ]);
}

export async function cancelPrivateOrder(args: {
  provider: RequestProvider;
  wallet: Address;
  vaultSignature: Hex;
  order: PrivateOrderRecord;
}): Promise<void> {
  const deployment = getPrivateContracts();
  if (!deployment) throw new Error("Private trading is not configured");
  const orders = await loadPrivateOrders(args.wallet, args.vaultSignature);
  const current = orders.find((order) => order.orderCommitment === args.order.orderCommitment);
  if (!current || !["locked", "queued", "batched"].includes(current.state)) {
    throw new Error("Only an unrouted private order can be cancelled");
  }
  const orderMerkle = await loadPrivateMerkleWitness(
    publicClient, deployment.pool, deployment.deploymentBlock, current.orderCommitment,
  );
  const cancellation = await provePrivateOrderCancellation({
    collateralAsset: current.collateralAsset,
    positionAsset: current.positionAsset,
    deposit: BigInt(current.deposit),
    limitPrice: BigInt(current.limitPrice),
    orderSecret: current.orderSecret,
    refundPublicKey: current.refundPublicKey,
    positionPublicKey: current.positionPublicKey,
    merkle: orderMerkle,
  });
  if (cancellation.orderCommitment.toLowerCase() !== current.orderCommitment.toLowerCase()) {
    throw new Error("Private cancellation proof does not match the locked order");
  }
  await send(args.provider, args.wallet, deployment.pool, encodeFunctionData({
    abi: SHIELDED_POOL_ABI,
    functionName: "cancelOrder",
    args: [cancellation.proof, orderMerkle.root, cancellation.orderNullifier,
      cancellation.refundCommitment, BigInt(current.deposit)],
  }));
  const witness = await loadPrivateMerkleWitness(
    publicClient, deployment.pool, deployment.deploymentBlock, cancellation.refundCommitment,
  );
  const notes = await loadPrivateNotes(args.wallet, args.vaultSignature);
  if (!notes.some((note) => note.commitment.toLowerCase() === cancellation.refundCommitment.toLowerCase())) {
    notes.unshift({
      commitment: cancellation.refundCommitment,
      assetId: current.collateralAsset,
      amount: current.deposit,
      publicKey: current.refundPublicKey,
      secret: current.refundSecret,
      leafIndex: witness.index.toString(),
      marketId: current.marketId,
      state: "spendable",
      createdAt: Date.now(),
    });
  }
  current.state = "cancelled";
  current.refund = current.deposit;
  current.spent = "0";
  current.shares = "0";
  await Promise.all([
    savePrivateNotes(args.wallet, args.vaultSignature, notes),
    savePrivateOrders(args.wallet, args.vaultSignature, orders),
  ]);
}
