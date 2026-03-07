import { createPublicClient, http, formatUnits } from "viem";
import { polygon } from "viem/chains";

const client = createPublicClient({ chain: polygon, transport: http(process.env.POLYGON_MAINNET_RPC!) });
const RELAYER = "0x5502e893b5E1D0182f87Cb8564d34B85dd56138b" as const;
const USDC    = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174" as const;

const usdcAbi = [{
  name: "balanceOf", type: "function",
  inputs: [{ name: "", type: "address" }],
  outputs: [{ name: "", type: "uint256" }],
  stateMutability: "view",
}] as const;

const [matic, usdc] = await Promise.all([
  client.getBalance({ address: RELAYER }),
  client.readContract({ address: USDC, abi: usdcAbi, functionName: "balanceOf", args: [RELAYER] }),
]);

console.log("Relayer:", RELAYER);
console.log("MATIC:  ", formatUnits(matic, 18));
console.log("USDC:   ", formatUnits(usdc, 6));
