import "dotenv/config";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { createPublicClient, createWalletClient, encodeAbiParameters, encodeFunctionData, getAddress,
  http, keccak256, parseAbi, toHex, zeroHash, type Abi, type Address, type Hex } from "viem";
import { polygon } from "viem/chains";
import { V13MerkleTree } from "../src/v13MerkleTree.js";
import { proveV13Cancel, proveV13OrderLock, proveV13Route, proveV13Settlement, v13NoteCommitment,
  v13OrderCommitment, type V13BatchWitness, type V13PrivateOrder } from "../src/v13Proofs.js";
import { proveForkWithdrawal } from "./lib/v13ForkWithdrawal.js";

const require = createRequire(import.meta.url);
const poolAbi = require("../../contracts/out/ShieldedPoolV2.sol/ShieldedPoolV2.json").abi as Abi;
const adapterAbi = require("../../contracts/out/ShieldedPolymarketAdapter.sol/ShieldedPolymarketAdapter.json").abi as Abi;
const erc20 = parseAbi(["function approve(address,uint256) returns(bool)",
  "function transfer(address,uint256) returns(bool)", "function balanceOf(address) view returns(uint256)"]);
const ctfAbi = parseAbi([
  "function prepareCondition(address,bytes32,uint256)",
  "function getConditionId(address,bytes32,uint256) pure returns(bytes32)",
  "function getCollectionId(bytes32,bytes32,uint256) view returns(bytes32)",
  "function getPositionId(address,bytes32) pure returns(uint256)",
  "function splitPosition(address,bytes32,bytes32,uint256[],uint256)",
  "function safeTransferFrom(address,address,uint256,uint256,bytes)",
  "function balanceOf(address,uint256) view returns(uint256)",
]);
const pool = getAddress(process.env.V13_POOL_ADDRESS ?? "0x66AA268ab8183AdE8081879D030f54Ab6D2b0A1b");
const word = (text: string) => keccak256(toHex(`v13 fork-only fixture:${text}`));
const actors = [1, 2, 3].map((n) => getAddress(toHex(0x10000n + BigInt(n), { size: 20 })));

async function availablePort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  assert(address && typeof address !== "string");
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function main() {
  if (!process.env.RPC_URL) throw new Error("RPC_URL is required for read-only fork state");
  const upstream = createPublicClient({ chain: polygon, transport: http(process.env.RPC_URL) });
  assert.equal(await upstream.getChainId(), 137, "Fork source must be Polygon");
  const forkBlock = await upstream.getBlockNumber();
  const port = await availablePort();
  // No private keys, production database credentials, or RPC URL go into Anvil's argv/environment.
  const node = spawn("anvil", ["--host", "127.0.0.1", "--port", String(port), "--chain-id", "137", "--quiet"],
    { env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR }, stdio: "ignore" });
  let startupError: Error | undefined;
  node.on("error", (error) => { startupError = error; });
  const localUrl = `http://127.0.0.1:${port}`;
  const transport = http(localUrl, { retryCount: 0, timeout: 90_000 });
  const reader = createPublicClient({ chain: polygon, transport, cacheTime: 0 });
  const wallet = createWalletClient({ chain: polygon, transport });
  const rpc = (method: string, params: unknown[] = []) => reader.request({ method, params } as never) as Promise<any>;
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (startupError) throw startupError;
      if (node.exitCode !== null) throw new Error("Local Anvil stopped during startup");
      try { ready = String(await rpc("web3_clientVersion")).toLowerCase().includes("anvil"); } catch {}
      if (ready) break;
      await delay(100);
    }
    assert(ready, "Only a locally spawned Anvil node may receive rehearsal transactions");
    await rpc("anvil_reset", [{ forking: { jsonRpcUrl: process.env.RPC_URL, blockNumber: Number(forkBlock) } }]);
    assert.equal(await reader.getChainId(), 137);
    const read = (address: Address, abi: Abi, functionName: string, args: unknown[] = []) =>
      reader.readContract({ address, abi, functionName, args }) as Promise<any>;
    const send = async (account: Address, address: Address, abi: Abi, functionName: string, args: unknown[] = []) => {
      const hash = await wallet.sendTransaction({ account, to: address,
        data: encodeFunctionData({ abi, functionName, args }), gas: 15_000_000n });
      const receipt = await reader.waitForTransactionReceipt({ hash });
      assert.equal(receipt.status, "success", `Fork transaction ${functionName} reverted`);
      return receipt;
    };
    const [guardian, relayer, collateral, ctf, adapter, collateralAsset] = await Promise.all(
      ["guardian", "relayer", "collateral", "ctf", "executionAdapter", "collateralAssetId"]
        .map((name) => read(pool, poolAbi, name))) as [Address, Address, Address, Address, Address, Hex];
    const [depositWallet, pusd, onramp] = await Promise.all(
      ["depositWallet", "pusd", "onramp"].map((name) => read(adapter, adapterAbi, name))) as [Address, Address, Address];
    assert.equal(await read(pool, poolAbi, "paused"), true, "Use a paused deployment for this fork exercise");
    assert.equal((await read(pool, poolAbi, "activeBuy"))[4], false);
    assert.equal(await read(pool, poolAbi, "liabilities", [collateralAsset]), 0n, "Do not rehearse over existing collateral liabilities");
    assert.equal(await read(pusd, erc20, "balanceOf", [depositWallet]), 0n, "Deposit Wallet must start isolated");
    for (const account of [...actors, guardian, relayer, depositWallet]) {
      await rpc("anvil_impersonateAccount", [account]);
      await rpc("anvil_setBalance", [account, toHex(1_000n * 10n ** 18n)]);
    }
    async function fundSyntheticCollateral(account: Address, amount: bigint) {
      // Equivalent to Foundry deal(): modify only this account's balance in the local fork.
      for (let slot = 0n; slot < 30n; slot++) {
        const key = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [account, slot]));
        const prior = await reader.getStorageAt({ address: collateral, slot: key }) ?? zeroHash;
        await rpc("anvil_setStorageAt", [collateral, key, toHex(amount, { size: 32 })]);
        if (await read(collateral, erc20, "balanceOf", [account]) === amount) return;
        await rpc("anvil_setStorageAt", [collateral, key, prior]);
      }
      throw new Error("Could not locate collateral balance storage on local fork");
    }
    for (const account of actors) await fundSyntheticCollateral(account, 2_000_000n);
    const maker = actors[2];
    const question = word("synthetic-condition");
    await send(maker, ctf, ctfAbi, "prepareCondition", [maker, question, 2n]);
    const condition = await read(ctf, ctfAbi, "getConditionId", [maker, question, 2n]);
    const collection = await read(ctf, ctfAbi, "getCollectionId", [zeroHash, condition, 2n]);
    const token = await read(ctf, ctfAbi, "getPositionId", [pusd, collection]) as bigint;
    const positionAsset = await read(pool, poolAbi, "positionAssetId", [token]) as Hex;
    await send(maker, collateral, erc20, "approve", [onramp, 1_000_000n]);
    await send(maker, onramp, parseAbi(["function wrap(address,address,uint256)"]), "wrap", [collateral, maker, 1_000_000n]);
    await send(maker, pusd, erc20, "approve", [ctf, 1_000_000n]);
    await send(maker, ctf, ctfAbi, "splitPosition", [pusd, zeroHash, condition, [1n, 2n], 1_000_000n]);
    assert.equal(await read(ctf, ctfAbi, "balanceOf", [maker, token]), 1_000_000n);
    await send(guardian, pool, poolAbi, "setPaused", [false]);

    const tree = new V13MerkleTree();
    assert.equal(await read(pool, poolAbi, "nextLeafIndex"), 0n, "This fixture requires an unused deployed pool");
    let leafIndex = 0;
    const append = (commitment: Hex) => { const index = leafIndex++; tree.append(index, commitment); return index; };
    const notes: Array<{ account: Address; deposit: bigint; secret: Hex; refundSecret: Hex; positionSecret: Hex;
      order: Omit<V13PrivateOrder, "merkle">; index: number }> = [];
    for (let i = 0; i < 2; i++) {
      const account = actors[i]; const deposit = i === 0 ? 600_000n : 400_000n;
      const secret = word(`deposit-${i}`); const refundSecret = word(`refund-${i}`); const positionSecret = word(`position-${i}`);
      await send(account, collateral, erc20, "approve", [pool, deposit]);
      await send(account, pool, poolAbi, "deposit", [deposit, keccak256(secret)]);
      const commitment = v13NoteCommitment(collateralAsset, deposit, keccak256(secret));
      const index = append(commitment);
      const order = { positionAsset, deposit, limitPrice: 600_000n, refundPublicKey: keccak256(refundSecret),
        positionPublicKey: keccak256(positionSecret), orderSecret: word(`order-${i}`) };
      const proof = await proveV13OrderLock({ ...order, collateralAsset, noteSecret: secret,
        merkle: tree.witness(index, commitment) });
      await send(account, pool, poolAbi, "lockOrder", [proof.proof, tree.witness(index, commitment).root,
        proof.noteNullifier, proof.orderCommitment]);
      notes.push({ account, deposit, secret, refundSecret, positionSecret, order, index: append(proof.orderCommitment) });
    }
    const witness: V13BatchWitness = { collateralAsset, positionAsset,
      orders: notes.map((note) => ({ ...note.order, merkle: tree.witness(note.index, v13OrderCommitment(note.order)) })) as V13BatchWitness["orders"] };
    const route = await proveV13Route(witness);
    const routed = async () => {
      await send(relayer, pool, poolAbi, "startBuyBatch", [route.proof, route.root, token,
        route.nullifiers, route.fullRefunds, route.totalDeposit, route.binding]);
      assert.equal(await read(pusd, erc20, "balanceOf", [depositWallet]), 1_000_000n);
    };
    const readySnapshot = await rpc("evm_snapshot");
    await routed();
    const fills = [{ spent: 330_000n, shares: 600_000n }, { spent: 220_000n, shares: 400_000n }] as const;
    const settlement = await proveV13Settlement(witness, [...fills]);
    const settlementArgs = [settlement.proof, settlement.refundCommitments, settlement.positionCommitments,
      settlement.totalSpent, settlement.totalShares];
    const premature = await wallet.sendTransaction({ account: relayer, to: pool,
      data: encodeFunctionData({ abi: poolAbi, functionName: "settleBuyBatch", args: settlementArgs }), gas: 15_000_000n });
    assert.equal((await reader.waitForTransactionReceipt({ hash: premature })).status, "reverted", "Unbacked settlement must fail");
    // CLOB execution is intentionally simulated. All token/bridge/verifier contracts remain real.
    await send(depositWallet, pusd, erc20, "transfer", [maker, 550_000n]);
    await send(maker, ctf, ctfAbi, "safeTransferFrom", [maker, depositWallet, token, 1_000_000n, "0x"]);
    await send(depositWallet, pusd, erc20, "transfer", [adapter, 450_000n]);
    await send(relayer, adapter, adapterAbi, "returnPusd", [450_000n]);
    await send(depositWallet, ctf, ctfAbi, "safeTransferFrom", [depositWallet, pool, token, 1_000_000n, "0x"]);
    await send(relayer, pool, poolAbi, "settleBuyBatch", settlementArgs);
    const settledTree = new V13MerkleTree();
    for (let i = 0; i < 2; i++) {
      settledTree.append(i * 2, v13NoteCommitment(collateralAsset, notes[i].deposit, keccak256(notes[i].secret)));
      settledTree.append(i * 2 + 1, v13OrderCommitment(notes[i].order));
    }
    for (let i = 0; i < 2; i++) {
      settledTree.append(4 + i * 2, settlement.refundCommitments[i]);
      settledTree.append(5 + i * 2, settlement.positionCommitments[i]);
    }
    await send(guardian, pool, poolAbi, "setPaused", [true]);
    for (let i = 0; i < 2; i++) {
      const note = notes[i];
      for (const position of [false, true]) {
        const amount = position ? fills[i].shares : note.deposit - fills[i].spent;
        const asset = position ? positionAsset : collateralAsset;
        const secret = position ? note.positionSecret : note.refundSecret;
        const commitment = v13NoteCommitment(asset, amount, keccak256(secret));
        const proof = await proveForkWithdrawal(asset, amount, secret,
          settledTree.witness(4 + i * 2 + (position ? 1 : 0), commitment), note.account);
        const args = [proof.proof, proof.root, proof.nullifier, ...(position ? [token] : []), amount, note.account];
        await send(note.account, pool, poolAbi, position ? "withdrawPosition" : "withdraw", args);
        const replay = await wallet.sendTransaction({ account: note.account, to: pool,
          data: encodeFunctionData({ abi: poolAbi, functionName: position ? "withdrawPosition" : "withdraw", args }), gas: 15_000_000n });
        assert.equal((await reader.waitForTransactionReceipt({ hash: replay })).status, "reverted");
      }
      assert.equal(await read(collateral, erc20, "balanceOf", [note.account]), 2_000_000n - fills[i].spent);
      assert.equal(await read(ctf, ctfAbi, "balanceOf", [note.account, token]), fills[i].shares);
    }
    for (const asset of [collateralAsset, positionAsset]) assert.equal(await read(pool, poolAbi, "liabilities", [asset]), 0n);
    assert.equal(await read(pusd, erc20, "balanceOf", [depositWallet]), 0n);
    assert.equal(await read(ctf, ctfAbi, "balanceOf", [depositWallet, token]), 0n);
    console.log(JSON.stringify({ partialFill: "pass", exactPrivateAllocations: "pass", pausedWithdrawals: "pass", replayRejected: "pass" }));

    assert.equal(await rpc("evm_revert", [readySnapshot]), true);
    const cancelSnapshot = await rpc("evm_snapshot");
    await routed();
    await send(depositWallet, pusd, erc20, "transfer", [adapter, 1_000_000n]);
    await send(relayer, adapter, adapterAbi, "returnPusd", [1_000_000n]);
    await send(guardian, pool, poolAbi, "setPaused", [true]);
    await send(guardian, pool, poolAbi, "cancelBuyBatch");
    const refundTree = new V13MerkleTree();
    for (let i = 0; i < 2; i++) {
      refundTree.append(i * 2, v13NoteCommitment(collateralAsset, notes[i].deposit, keccak256(notes[i].secret)));
      refundTree.append(i * 2 + 1, v13OrderCommitment(notes[i].order));
    }
    for (let i = 0; i < 2; i++) refundTree.append(4 + i, route.fullRefunds[i]);
    for (let i = 0; i < 2; i++) {
      const exit = await proveForkWithdrawal(collateralAsset, notes[i].deposit, notes[i].refundSecret,
        refundTree.witness(4 + i, route.fullRefunds[i]), actors[i]);
      await send(actors[i], pool, poolAbi, "withdraw", [exit.proof, exit.root, exit.nullifier, notes[i].deposit, actors[i]]);
      assert.equal(await read(collateral, erc20, "balanceOf", [actors[i]]), 2_000_000n);
    }
    assert.equal(await read(pool, poolAbi, "liabilities", [collateralAsset]), 0n);
    assert.equal(await read(pusd, erc20, "balanceOf", [depositWallet]), 0n);
    console.log(JSON.stringify({ zeroFillReturnAndRefund: "pass", outstandingLiability: "0" }));

    assert.equal(await rpc("evm_revert", [cancelSnapshot]), true);
    // Unrouted cancellations use the actual cancellation verifier, while paused.
    await send(guardian, pool, poolAbi, "setPaused", [true]);
    for (let i = 0; i < 2; i++) {
      const cancellation = await proveV13Cancel(collateralAsset, witness.orders[i]);
      await send(actors[i], pool, poolAbi, "cancelOrder", [cancellation.proof, witness.orders[i].merkle.root,
        cancellation.orderNullifier, cancellation.refundCommitment, notes[i].deposit]);
      const index = append(cancellation.refundCommitment);
      const cancelledExit = await proveForkWithdrawal(collateralAsset, notes[i].deposit, notes[i].refundSecret,
        tree.witness(index, cancellation.refundCommitment), actors[i]);
      await send(actors[i], pool, poolAbi, "withdraw", [cancelledExit.proof, cancelledExit.root, cancelledExit.nullifier,
        notes[i].deposit, actors[i]]);
      assert.equal(await read(collateral, erc20, "balanceOf", [actors[i]]), 2_000_000n);
    }
    assert.equal(await read(pool, poolAbi, "liabilities", [collateralAsset]), 0n);
    console.log(JSON.stringify({ v13PolygonFork: "pass", forkBlock: forkBlock.toString(), pool,
      realContractsAndProofs: true, clob: "simulated", syntheticFunding: true,
      unroutedCancellationAndExit: "pass", mainnetTransactions: 0 }));
  } finally {
    if (node.exitCode === null) {
      node.kill("SIGTERM");
      await new Promise<void>((resolve) => { node.once("exit", () => resolve()); setTimeout(() => { node.kill("SIGKILL"); resolve(); }, 5000).unref(); });
    }
  }
}

main().catch((error) => { console.error(error?.shortMessage ?? error.message ?? "Fork rehearsal failed"); process.exitCode = 1; });
