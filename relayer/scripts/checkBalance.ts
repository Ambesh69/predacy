import { createPublicClient, http, formatUnits } from "viem";
import { polygon } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

const client = createPublicClient({ chain: polygon, transport: http(process.env.POLYGON_MAINNET_RPC!) });
const account = privateKeyToAccount(process.env.RELAYER_PRIVATE_KEY! as `0x${string}`);

const USDC = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174" as const;
const usdcAbi = [{
  name: "balanceOf", type: "function",
  inputs: [{ name: "", type: "address" }],
  outputs: [{ name: "", type: "uint256" }],
  stateMutability: "view",
}] as const;

const [matic, usdc] = await Promise.all([
  client.getBalance({ address: account.address }),
  client.readContract({ address: USDC, abi: usdcAbi, functionName: "balanceOf", args: [account.address] }),
]);

console.log("Relayer:", account.address);
console.log("MATIC:  ", formatUnits(matic, 18));
console.log("USDC:   ", formatUnits(usdc, 6));
