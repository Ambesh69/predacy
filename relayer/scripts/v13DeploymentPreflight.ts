import "dotenv/config";
import { createPublicClient, formatEther, getAddress, http, parseEther, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";
import {
  remainingV13DeploymentGas,
  v13DeploymentCostWei,
  type V13DeploymentState,
} from "../src/v13DeploymentBudget.js";

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
  const privateKey = (
    process.env.PRIVATE_KEY?.trim()
    || process.env.V13_RELAYER_PRIVATE_KEY?.trim()
    || required("RELAYER_PRIVATE_KEY")
  ) as Hex;
  const budget = parseEther(required("V13_DEPLOYMENT_BUDGET_POL"));
  const maxGasPrice = BigInt(required("V13_MAX_GAS_PRICE_WEI"));
  const account = privateKeyToAccount(privateKey);
  const client = createPublicClient({
    chain: polygon,
    transport: http(required("RPC_URL"), { timeout: 15_000 }),
  });
  if (await client.getChainId() !== polygon.id) throw new Error("RPC is not Polygon mainnet");

  const configured = {
    order: optionalAddress("V13_ORDER_VERIFIER"),
    route: optionalAddress("V13_ROUTE_VERIFIER"),
    settlement: optionalAddress("V13_SETTLEMENT_VERIFIER"),
    cancel: optionalAddress("V13_CANCEL_VERIFIER"),
  };
  const pool = optionalAddress("V13_POOL_ADDRESS");
  const adapter = optionalAddress("V13_ADAPTER_ADDRESS");
  if (!!pool !== !!adapter) throw new Error("V13_POOL_ADDRESS and V13_ADAPTER_ADDRESS must be set together");

  const hasCode = async (address: Address | undefined): Promise<boolean> => {
    if (!address) return false;
    const code = await client.getCode({ address });
    return !!code && code !== "0x";
  };
  const verifierChecks = await Promise.all(
    (Object.keys(configured) as Array<keyof typeof configured>)
      .map(async (name) => [name, await hasCode(configured[name])] as const),
  );
  const state: V13DeploymentState = {
    verifiers: Object.fromEntries(verifierChecks) as V13DeploymentState["verifiers"],
    poolAndAdapter: !!pool && await hasCode(pool) && await hasCode(adapter),
  };
  const [gasPrice, balance] = await Promise.all([
    client.getGasPrice(),
    client.getBalance({ address: account.address }),
  ]);
  const measuredGas = remainingV13DeploymentGas(state);
  const requiredBalance = v13DeploymentCostWei(measuredGas, gasPrice);
  const ready = gasPrice <= maxGasPrice && requiredBalance <= budget && requiredBalance <= balance;
  console.log(JSON.stringify({
    ready,
    deployer: account.address,
    state,
    measuredGas: measuredGas.toString(),
    gasPriceGwei: Number(gasPrice) / 1e9,
    maxGasPriceGwei: Number(maxGasPrice) / 1e9,
    estimatedPolWithTenPercentReserve: formatEther(requiredBalance),
    balancePol: formatEther(balance),
    authorizedBudgetPol: formatEther(budget),
  }, null, 2));
  if (gasPrice > maxGasPrice) throw new Error("Current gas price exceeds V13_MAX_GAS_PRICE_WEI");
  if (requiredBalance > budget) throw new Error("Estimated deployment exceeds V13_DEPLOYMENT_BUDGET_POL");
  if (requiredBalance > balance) throw new Error("Deployer balance is insufficient for the guarded deployment estimate");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "V13 deployment preflight failed");
  process.exitCode = 1;
});
