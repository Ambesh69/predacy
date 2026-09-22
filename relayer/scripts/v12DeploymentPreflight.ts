import "dotenv/config";
import {
  createPublicClient,
  formatEther,
  getAddress,
  http,
  keccak256,
  parseEther,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";
import {
  addDeploymentSafetyMargin,
  remainingV12DeploymentGas,
  V12_TRANSCRIPT_LIBRARY,
  V12_TRANSCRIPT_LIBRARY_CODE_HASH,
  type V12DeploymentState,
} from "../src/v12DeploymentBudget.js";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function optionalAddress(name: string): Address | undefined {
  const value = process.env[name]?.trim();
  return value ? getAddress(value) : undefined;
}

async function main(): Promise<void> {
  const rpcUrl = required("RPC_URL");
  const privateKey = (
    process.env.PRIVATE_KEY?.trim()
    || process.env.V12_RELAYER_PRIVATE_KEY?.trim()
    || required("RELAYER_PRIVATE_KEY")
  ) as Hex;
  const budget = parseEther(required("V12_DEPLOYMENT_BUDGET_POL"));
  const maxGasPrice = BigInt(process.env.V12_MAX_GAS_PRICE_WEI?.trim() || "5000000000");
  const account = privateKeyToAccount(privateKey);
  const client = createPublicClient({ chain: polygon, transport: http(rpcUrl, { timeout: 15_000 }) });
  if (await client.getChainId() !== polygon.id) throw new Error("RPC is not Polygon mainnet");

  const verifierAddresses = {
    withdraw: optionalAddress("V12_WITHDRAW_VERIFIER"),
    transfer: optionalAddress("V12_TRANSFER_VERIFIER"),
    order: optionalAddress("V12_ORDER_VERIFIER"),
    buyBatch: optionalAddress("V12_BUY_BATCH_VERIFIER"),
  };
  const pool = optionalAddress("V12_POOL_ADDRESS");
  const adapter = optionalAddress("V12_ADAPTER_ADDRESS");
  if (!!pool !== !!adapter) throw new Error("V12_POOL_ADDRESS and V12_ADAPTER_ADDRESS must be set together");

  const hasCode = async (address: Address | undefined): Promise<boolean> => {
    if (!address) return false;
    const code = await client.getCode({ address });
    return !!code && code !== "0x";
  };
  const verifierNames = ["withdraw", "transfer", "order", "buyBatch"] as const;
  const verifierChecks = await Promise.all(
    verifierNames.map(async (name) => [name, await hasCode(verifierAddresses[name])] as const),
  );
  const transcriptLibraryCode = await client.getCode({ address: V12_TRANSCRIPT_LIBRARY });
  const transcriptLibrary = !!transcriptLibraryCode && transcriptLibraryCode !== "0x";
  if (transcriptLibrary && keccak256(transcriptLibraryCode) !== V12_TRANSCRIPT_LIBRARY_CODE_HASH) {
    throw new Error("Deployed v12 transcript library bytecode does not match the audited build");
  }
  const state: V12DeploymentState = {
    transcriptLibrary,
    verifiers: Object.fromEntries(verifierChecks) as V12DeploymentState["verifiers"],
    poolAndAdapter: !!pool && await hasCode(pool) && await hasCode(adapter),
  };

  const [gasPrice, balance] = await Promise.all([
    client.getGasPrice(),
    client.getBalance({ address: account.address }),
  ]);
  const measuredGas = remainingV12DeploymentGas(state);
  const guardedGas = addDeploymentSafetyMargin(measuredGas);
  const requiredBalance = guardedGas * gasPrice;
  const result = {
    ready: gasPrice <= maxGasPrice && requiredBalance <= budget && requiredBalance <= balance,
    deployer: account.address,
    state,
    measuredGas: measuredGas.toString(),
    guardedGas: guardedGas.toString(),
    gasPriceGwei: Number(gasPrice) / 1e9,
    maxGasPriceGwei: Number(maxGasPrice) / 1e9,
    estimatedPol: formatEther(measuredGas * gasPrice),
    guardedPol: formatEther(requiredBalance),
    balancePol: formatEther(balance),
    authorizedBudgetPol: formatEther(budget),
  };
  console.log(JSON.stringify(result, null, 2));
  if (gasPrice > maxGasPrice) throw new Error("Current gas price exceeds V12_MAX_GAS_PRICE_WEI");
  if (requiredBalance > budget) throw new Error("Estimated deployment exceeds V12_DEPLOYMENT_BUDGET_POL");
  if (requiredBalance > balance) throw new Error("Deployer balance is insufficient for the guarded deployment estimate");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "V12 deployment preflight failed");
  process.exitCode = 1;
});
