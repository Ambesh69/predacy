import "dotenv/config";
import { createPublicClient, getAddress, http, parseAbi, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";
import { createOperatorDepositWallet } from "../src/depositWalletClient.js";
import { PostgresV11OrderJournal } from "../src/v11OrderJournal.js";
import { parseV11OrderManifest } from "../src/v11OrderManifest.js";

const vaultAbi = parseAbi([
  "function batches(uint256) view returns(bytes32,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint8)",
  "function pusd() view returns(address)",
  "function ctf() view returns(address)",
]);
const erc20Abi = parseAbi(["function balanceOf(address) view returns(uint256)"]);
const ctfAbi = parseAbi(["function balanceOf(address,uint256) view returns(uint256)"]);

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function main(): Promise<void> {
  if (process.argv.length !== 4 || process.argv[2] !== "--execute" || !/^\d+$/.test(process.argv[3])) {
    throw new Error("Usage: npm run reconcile:v11 -- --execute <batch-id>");
  }
  const batchId = process.argv[3];
  const order = parseV11OrderManifest(required("V11_ORDER_JSON"), batchId);
  const signerKey = required("V11_SIGNER_PRIVATE_KEY") as Hex;
  const rpcUrl = required("RPC_URL");
  const client = await createOperatorDepositWallet({
    signerPrivateKey: signerKey,
    builderKey: required("POLYMARKET_BUILDER_KEY"),
    builderSecret: required("POLYMARKET_BUILDER_SECRET"),
    builderPassphrase: required("POLYMARKET_BUILDER_PASSPHRASE"),
    rpcUrl,
    expectedSigner: privateKeyToAccount(signerKey).address,
    expectedWallet: getAddress(required("V11_DEPOSIT_WALLET")),
  });
  const journal = await PostgresV11OrderJournal.connect(required("V11_DATABASE_URL"));
  try {
    const intent = await journal.get(batchId, "0");
    if (!intent || intent.state !== "uncertain" ||
        !/no orders found to match with FAK order/i.test(intent.error ?? "") ||
        intent.signedOrder.maker.toLowerCase() !== order.depositWallet.toLowerCase() ||
        intent.signedOrder.tokenId.toString() !== order.tokenId.toString()) {
      throw new Error("Order intent is not the expected terminal no-match FAK rejection");
    }

    for await (const page of client.listOpenOrders()) {
      if (page.items.length) throw new Error("Deposit Wallet still has an open order");
    }
    for await (const page of client.listAccountTrades({ market: order.marketId })) {
      if (page.items.length) throw new Error("Deposit Wallet has a market trade; manual reconciliation required");
    }

    const reader = createPublicClient({ chain: polygon, transport: http(rpcUrl) });
    const vault = getAddress(required("V11_VAULT_ADDRESS"));
    const batch = await reader.readContract({ address: vault, abi: vaultAbi,
      functionName: "batches", args: [BigInt(batchId)] });
    if (batch[12] !== 3 || batch[0].toLowerCase() !== order.marketId.toLowerCase()) {
      throw new Error("Batch is not the expected routed batch");
    }
    const [pusd, ctf] = await Promise.all([
      reader.readContract({ address: vault, abi: vaultAbi, functionName: "pusd" }),
      reader.readContract({ address: vault, abi: vaultAbi, functionName: "ctf" }),
    ]);
    const [collateral, yes, no] = await Promise.all([
      reader.readContract({ address: pusd, abi: erc20Abi, functionName: "balanceOf", args: [order.depositWallet] }),
      reader.readContract({ address: ctf, abi: ctfAbi, functionName: "balanceOf", args: [order.depositWallet, batch[1]] }),
      reader.readContract({ address: ctf, abi: ctfAbi, functionName: "balanceOf", args: [order.depositWallet, batch[2]] }),
    ]);
    if (collateral !== order.deposit || yes !== 0n || no !== 0n) {
      throw new Error("Deposit Wallet balances do not prove a zero-fill rejection");
    }
    await journal.recordReconciledRejection(batchId, "0", {
      kind: "terminal_fak_no_match",
      openOrders: 0,
      marketTrades: 0,
      collateral: collateral.toString(),
      yes: "0",
      no: "0",
    });
    console.log(JSON.stringify({ batchId, state: "rejected", reconciled: true }));
  } finally {
    await journal.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "V11 reconciliation failed");
  process.exitCode = 1;
});
