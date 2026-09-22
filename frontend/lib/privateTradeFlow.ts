import { encodeFunctionData, keccak256, type Address, type Hex } from "viem";
import { ERC20_ABI } from "./contracts";
import { getPrivateContracts, SHIELDED_POOL_ABI } from "./privateContracts";
import { loadPrivateMerkleWitness } from "./privateMerkle";
import {
  loadPrivateNotes, loadPrivateOrders, savePrivateNotes, savePrivateOrders,
  type PrivateNoteRecord, type PrivateOrderRecord,
} from "./privateNotes";
import {
  privateNoteCommitment, provePrivateBuyOrder, provePrivateOrderCancellation, provePrivateWithdrawal,
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
  if (args.amount <= 0n) throw new Error("Private order amount must be positive");

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
  const orderSalt = randomWord();
  const receiptToken = randomWord();

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
  const notes = await loadPrivateNotes(args.wallet, args.vaultSignature);
  const note: PrivateNoteRecord = {
    commitment: inputNote, assetId: collateralAsset, amount: args.amount.toString(), publicKey: notePublicKey,
    secret: noteSecret, leafIndex: merkle.index.toString(), marketId: args.marketId, side: args.side,
    state: "spendable", createdAt: Date.now(),
  };
  await savePrivateNotes(args.wallet, args.vaultSignature, [note, ...notes]);

  args.onStep?.("proving");
  const authorization = await provePrivateBuyOrder({
    collateralAsset, positionAsset, deposit: args.amount, limitPrice: args.limitPrice,
    noteSecret, merkle, refundPublicKey, positionPublicKey, orderSalt,
  });
  args.onStep?.("locking");
  await send(args.provider, args.wallet, deployment.pool, encodeFunctionData({
    abi: SHIELDED_POOL_ABI, functionName: "lockBuyOrder",
    args: [authorization.proof, authorization.root, authorization.nullifier,
      args.positionTokenId, authorization.orderCommitment],
  }));
  note.state = "locked";
  await savePrivateNotes(args.wallet, args.vaultSignature, [note, ...notes]);

  const order: PrivateOrderRecord = {
    orderCommitment: authorization.orderCommitment,
    receiptToken,
    inputNote,
    deposit: args.amount.toString(),
    limitPrice: args.limitPrice.toString(),
    marketId: args.marketId,
    positionTokenId: args.positionTokenId.toString(),
    collateralAsset,
    positionAsset,
    orderSalt,
    refundSecret,
    refundPublicKey,
    positionSecret,
    positionPublicKey,
    state: "locked",
    createdAt: Date.now(),
  };
  await savePrivateOrders(args.wallet, args.vaultSignature, [
    order, ...(await loadPrivateOrders(args.wallet, args.vaultSignature)),
  ]);

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
      inputNote,
      deposit: args.amount.toString(),
      limitPrice: args.limitPrice.toString(),
      salt: orderSalt,
      refundPublicKey,
      positionPublicKey,
    },
  });
  order.state = queued.state;
  const saved = await loadPrivateOrders(args.wallet, args.vaultSignature);
  await savePrivateOrders(args.wallet, args.vaultSignature,
    saved.map((item) => item.orderCommitment === order.orderCommitment ? order : item));
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
  let changed = false;
  for (const order of orders) {
    if (order.state === "settled" || order.state === "cancelled" || order.state === "locked") continue;
    const receipt = await getPrivateAllocationReceipt(order.orderCommitment, order.receiptToken);
    if (receipt.state !== "settled" || receipt.spent === undefined || receipt.shares === undefined ||
        receipt.refund === undefined) continue;
    order.state = "settled";
    order.spent = receipt.spent;
    order.shares = receipt.shares;
    order.refund = receipt.refund;
    changed = true;

    const outputs: PrivateNoteRecord[] = [];
    const refund = BigInt(receipt.refund);
    if (refund > 0n) {
      const commitment = privateNoteCommitment(order.collateralAsset, refund, order.refundPublicKey);
      const witness = await loadPrivateMerkleWitness(
        publicClient, deployment.pool, deployment.deploymentBlock, commitment,
      );
      outputs.push({
        commitment, assetId: order.collateralAsset, amount: refund.toString(), publicKey: order.refundPublicKey,
        secret: order.refundSecret, leafIndex: witness.index.toString(), marketId: order.marketId,
        state: "spendable", createdAt: Date.now(),
      });
    }
    const shares = BigInt(receipt.shares);
    if (shares > 0n) {
      const commitment = privateNoteCommitment(order.positionAsset, shares, order.positionPublicKey);
      const witness = await loadPrivateMerkleWitness(
        publicClient, deployment.pool, deployment.deploymentBlock, commitment,
      );
      outputs.push({
        commitment, assetId: order.positionAsset, amount: shares.toString(), publicKey: order.positionPublicKey,
        secret: order.positionSecret, leafIndex: witness.index.toString(), marketId: order.marketId,
        positionTokenId: order.positionTokenId,
        state: "spendable", createdAt: Date.now(),
      });
    }
    for (const output of outputs) {
      if (!notes.some((note) => note.commitment.toLowerCase() === output.commitment.toLowerCase())) notes.unshift(output);
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
  if (!current || current.state !== "settled") throw new Error("Private order is not settled");
  const amount = BigInt(args.output === "refund" ? current.refund ?? "0" : current.shares ?? "0");
  if (amount <= 0n) throw new Error("This private output has no withdrawable balance");
  if ((args.output === "refund" && current.refundWithdrawn) ||
      (args.output === "position" && current.positionWithdrawn)) throw new Error("Private output already withdrawn");
  const asset = args.output === "refund" ? current.collateralAsset : current.positionAsset;
  const publicKey = args.output === "refund" ? current.refundPublicKey : current.positionPublicKey;
  const commitment = privateNoteCommitment(asset, amount, publicKey);
  const notes = await loadPrivateNotes(args.wallet, args.vaultSignature);
  const note = notes.find((item) => item.commitment.toLowerCase() === commitment.toLowerCase());
  if (!note || note.state !== "spendable") throw new Error("Private output note is missing or already spent");
  const merkle = await loadPrivateMerkleWitness(
    publicClient, deployment.pool, deployment.deploymentBlock, commitment,
  );
  const withdrawal = await provePrivateWithdrawal({
    asset, amount, noteSecret: note.secret, merkle, recipient: args.wallet,
  });
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
  if (!current || !["locked", "queued"].includes(current.state)) {
    throw new Error("Only an unbatched private order can be cancelled");
  }
  const cancellation = await provePrivateOrderCancellation({
    collateralAsset: current.collateralAsset,
    positionAsset: current.positionAsset,
    inputNote: current.inputNote,
    deposit: BigInt(current.deposit),
    limitPrice: BigInt(current.limitPrice),
    orderSalt: current.orderSalt,
    refundPublicKey: current.refundPublicKey,
    positionPublicKey: current.positionPublicKey,
  });
  if (cancellation.orderCommitment.toLowerCase() !== current.orderCommitment.toLowerCase()) {
    throw new Error("Private cancellation proof does not match the locked order");
  }
  await send(args.provider, args.wallet, deployment.pool, encodeFunctionData({
    abi: SHIELDED_POOL_ABI,
    functionName: "cancelLockedBuyOrder",
    args: [cancellation.proof, BigInt(current.positionTokenId), current.orderCommitment,
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
