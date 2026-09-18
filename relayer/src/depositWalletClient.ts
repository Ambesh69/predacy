import { createSecureClient, WalletType } from "@polymarket/client";
import { builderApiKey } from "@polymarket/client/node";
import { privateKey } from "@polymarket/client/viem";
import { createPublicClient, getAddress, http, type Address, type Hex } from "viem";
import { polygon } from "viem/chains";

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
