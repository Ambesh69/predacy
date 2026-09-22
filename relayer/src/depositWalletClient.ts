import { createSecureClient, WalletType } from "@polymarket/client";
import { builderApiKey } from "@polymarket/client/node";
import { privateKey } from "@polymarket/client/viem";
import { updateBalanceAllowance } from "@polymarket/client/actions";
import { createPublicClient, getAddress, http, type Address, type Hex } from "viem";
import { polygon } from "viem/chains";
import { awaitDepositWalletFunding } from "./depositWalletFundingGate.js";

export interface DepositWalletConfig {
  signerPrivateKey: Hex;
  builderKey: string;
  builderSecret: string;
  builderPassphrase: string;
  rpcUrl: string;
  expectedSigner: Address;
  expectedWallet: Address;
}

export type DepositWalletClient = Awaited<ReturnType<typeof createSecureClient>>;

const erc20BalanceAbi = [{
  name: "balanceOf", type: "function", stateMutability: "view",
  inputs: [{ name: "account", type: "address" }],
  outputs: [{ name: "balance", type: "uint256" }],
}] as const;
const ctfBalanceAbi = [{
  name: "balanceOf", type: "function", stateMutability: "view",
  inputs: [{ name: "account", type: "address" }, { name: "tokenId", type: "uint256" }],
  outputs: [{ name: "balance", type: "uint256" }],
}] as const;

export interface RoutedFundingRequest {
  rpcUrl: string;
  tokenAddress: Address;
  exchange: Address;
  asset: "COLLATERAL" | "CONDITIONAL";
  tokenId?: bigint;
  startingBalance: bigint;
  incomingAmount: bigint;
  orderAmount: bigint;
}

/** Call only after the vault routing transaction has a successful receipt. */
export async function awaitRoutedDepositWalletFunding(
  client: DepositWalletClient,
  request: RoutedFundingRequest,
): Promise<void> {
  if (client.account.walletType !== WalletType.DEPOSIT_WALLET) {
    throw new Error("CLOB funding requires a Deposit Wallet");
  }
  if (request.asset === "CONDITIONAL" ? !request.tokenId || request.tokenId <= 0n : request.tokenId !== undefined) {
    throw new Error("Invalid CLOB funding asset");
  }
  const reader = createPublicClient({ chain: polygon, transport: http(request.rpcUrl) });
  if (await reader.getChainId() !== polygon.id) throw new Error("Deposit Wallet funding RPC is not Polygon mainnet");
  await awaitDepositWalletFunding({
    wallet: client.account.wallet,
    exchange: request.exchange,
    startingBalance: request.startingBalance,
    incomingAmount: request.incomingAmount,
    orderAmount: request.orderAmount,
  }, {
    readOnChainBalance: async () => request.asset === "COLLATERAL"
      ? reader.readContract({ address: request.tokenAddress, abi: erc20BalanceAbi,
          functionName: "balanceOf", args: [client.account.wallet] })
      : reader.readContract({ address: request.tokenAddress, abi: ctfBalanceAbi,
          functionName: "balanceOf", args: [client.account.wallet, request.tokenId!] }),
    refreshClobBalance: () => updateBalanceAllowance(client, {
      assetType: request.asset as Parameters<typeof updateBalanceAllowance>[1]["assetType"],
      ...(request.asset === "CONDITIONAL" ? { assetId: request.tokenId!.toString() } : {}),
    }),
  });
}

export function assertDepositWalletIdentity(
  identity: { signer: string; wallet: string; walletType: WalletType },
  expectedSigner: Address,
  expectedWallet: Address,
): void {
  if (identity.walletType !== WalletType.DEPOSIT_WALLET) {
    throw new Error("Polymarket account is not a Deposit Wallet");
  }
  if (getAddress(identity.signer) !== getAddress(expectedSigner)) {
    throw new Error("Polymarket signer does not match configured operator");
  }
  if (getAddress(identity.wallet) !== getAddress(expectedWallet)) {
    throw new Error("Derived Deposit Wallet does not match configured wallet");
  }
}

/** This may deploy a new wallet. Call only during an explicit setup operation. */
export async function createOperatorDepositWallet(config: DepositWalletConfig): Promise<DepositWalletClient> {
  if (!config.builderKey || !config.builderSecret || !config.builderPassphrase || !config.rpcUrl) {
    throw new Error("Deposit Wallet builder credentials and Polygon RPC are required");
  }

  const client = await createSecureClient({
    signer: privateKey(config.signerPrivateKey, { transport: http(config.rpcUrl) }),
    apiKey: builderApiKey({
      key: config.builderKey,
      secret: config.builderSecret,
      passphrase: config.builderPassphrase,
    }),
  });

  assertDepositWalletIdentity(client.account, config.expectedSigner, config.expectedWallet);
  const publicClient = createPublicClient({ chain: polygon, transport: http(config.rpcUrl) });
  if (await publicClient.getChainId() !== polygon.id) throw new Error("Deposit Wallet RPC is not Polygon mainnet");
  const code = await publicClient.getCode({ address: config.expectedWallet });
  if (!code || code === "0x") throw new Error("Deposit Wallet deployment is not confirmed on Polygon");

  return client;
}
