import "dotenv/config";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  formatEther,
  formatUnits,
  getAddress,
  http,
  parseAbi,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";

interface PilotFile {
  manifest: {
    batchId: string;
    marketId: Hex;
    commitment: Hex;
    side: "YES_BUY" | "NO_BUY";
    deposit: string;
    limitPrice: string;
    salt: Hex;
    tokenId: string;
    priceTick: string;
    depositWallet: Address;
  };
  transactions: Record<"approve" | "unpause" | "openBatch" | "commit" | "closeBatch" | "claim", {
    to: Address;
    data: Hex;
  }>;
}

const vaultAbi = parseAbi([
  "function tradingPaused() view returns (bool)",
  "function setTradingPaused(bool)",
  "function nextBatchId() view returns (uint256)",
  "function activeBatchId() view returns (uint256)",
  "function pusd() view returns (address)",
  "function ctf() view returns (address)",
  "function batches(uint256) view returns(bytes32,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint8)",
  "function orders(uint256,uint256) view returns(bytes32,uint8,uint256,address,bool)",
  "function openBatch(bytes32,uint256,uint256) returns (uint256)",
  "function closeBatch(uint256)",
]);
const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
]);
const ctfAbi = parseAbi(["function balanceOf(address,uint256) view returns(uint256)"]);

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function loadPilot(path: string): Promise<PilotFile> {
  const parsed = JSON.parse(await readFile(path, "utf8")) as PilotFile;
  if (!/^\d+$/.test(parsed.manifest.batchId) || !/^\d+$/.test(parsed.manifest.deposit) ||
      !/^0x[0-9a-fA-F]{64}$/.test(parsed.manifest.commitment) ||
      !/^0x[0-9a-fA-F]{64}$/.test(parsed.manifest.salt)) {
    throw new Error("Invalid pilot manifest");
  }
  return parsed;
}

function html(guardian: Address, token: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Predacy v11 Pilot</title><style>
:root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui,sans-serif;background:#071018;color:#eaf2f8}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px}
main{width:min(620px,100%);border:1px solid #29404f;background:#0c1821;padding:24px;border-radius:8px}
h1{font-size:22px;margin:0 0 8px}p{color:#9fb1bd;line-height:1.5;margin:0 0 20px}
.status{min-height:90px;padding:14px;background:#071018;border:1px solid #213744;border-radius:6px;white-space:pre-wrap;font:13px ui-monospace,monospace;margin:18px 0}
.actions{display:grid;grid-template-columns:1fr 1fr;gap:10px}button{min-height:44px;border:0;border-radius:6px;background:#28d7bd;color:#06110f;font-weight:750;cursor:pointer;padding:10px}
button.secondary{background:#203541;color:#eaf2f8}button.danger{background:#7f2730;color:white}button:disabled{opacity:.45;cursor:not-allowed}
.meta{display:grid;grid-template-columns:auto 1fr;gap:8px 12px;font-size:13px}.meta span:nth-child(odd){color:#78909e}.meta span:nth-child(even){overflow-wrap:anywhere}
@media(max-width:520px){.actions{grid-template-columns:1fr}}
</style></head><body><main><h1>Predacy mainnet pilot</h1>
<p>Guardian-controlled $1.35 USDC.e BUY NO pilot. Every state-changing wallet action still requires your confirmation.</p>
<div class="meta"><span>Guardian</span><span>${guardian}</span><span>Network</span><span>Polygon mainnet</span><span>Vault</span><span id="vault">Checking...</span></div>
<div id="status" class="status">Connect the funded guardian wallet.</div>
<div class="actions">
<button id="setup">1. Approve and unpause</button><button id="start" disabled>2. Start pilot</button>
<button id="finish" disabled>3. Pause and claim</button><button id="pause" class="danger">Emergency pause</button>
</div></main><script>
const TOKEN=${JSON.stringify(token)}, GUARDIAN=${JSON.stringify(guardian.toLowerCase())};
const statusEl=document.querySelector('#status'), setup=document.querySelector('#setup'), start=document.querySelector('#start'), finish=document.querySelector('#finish'), pause=document.querySelector('#pause');
const NL=String.fromCharCode(10);
let account, activeProvider;
const setStatus=(s)=>statusEl.textContent=s;
async function api(path,method='GET'){const r=await fetch(path,{method,headers:{'X-Pilot-Token':TOKEN}});const body=await r.json();if(!r.ok)throw new Error(body.error||('HTTP '+r.status));return body}
async function metamask(){if(activeProvider)return activeProvider;const announced=[];const onProvider=(event)=>{const detail=event.detail||{};const rdns=(detail.info?.rdns||'').toLowerCase();if(rdns.includes('metamask'))announced.push(detail.provider)};window.addEventListener('eip6963:announceProvider',onProvider);window.dispatchEvent(new Event('eip6963:requestProvider'));await new Promise(x=>setTimeout(x,350));window.removeEventListener('eip6963:announceProvider',onProvider);activeProvider=announced[0]||(window.ethereum?.providers||[]).find(p=>p.isMetaMask&&!p.isBraveWallet)||(window.ethereum?.isMetaMask&&!window.ethereum?.isBraveWallet?window.ethereum:null);if(!activeProvider)throw new Error('MetaMask was not detected. Open this URL in the browser where MetaMask is installed.');return activeProvider}
async function wallet(){const provider=await metamask();try{await provider.request({method:'wallet_switchEthereumChain',params:[{chainId:'0x89'}]})}catch(error){if(error?.code!==4902)throw error;await provider.request({method:'wallet_addEthereumChain',params:[{chainId:'0x89',chainName:'Polygon Mainnet',nativeCurrency:{name:'POL',symbol:'POL',decimals:18},rpcUrls:['https://polygon-rpc.com'],blockExplorerUrls:['https://polygonscan.com']} ]})}const accounts=await provider.request({method:'eth_requestAccounts'});account=accounts[0]?.toLowerCase();if(account!==GUARDIAN)throw new Error('Connect the funded guardian wallet '+GUARDIAN);return account}
async function receipt(hash){const provider=await metamask();for(;;){const r=await provider.request({method:'eth_getTransactionReceipt',params:[hash]});if(r){if(r.status!=='0x1')throw new Error('Transaction reverted: '+hash);return r}await new Promise(x=>setTimeout(x,1800))}}
async function send(tx,label){await wallet();const provider=await metamask();setStatus(label+NL+'Confirm the transaction in MetaMask.');const hash=await provider.request({method:'eth_sendTransaction',params:[{from:account,to:tx.to,data:tx.data,value:'0x0'}]});setStatus(label+NL+'Waiting for '+hash);await receipt(hash);return hash}
async function refresh(){const s=await api('/state');document.querySelector('#vault').textContent=s.vault;start.disabled=!(s.ready&&s.batchStatus==='NONE');finish.disabled=s.batchStatus!=='SETTLED';setStatus('USDC.e: '+s.guardianUsdce+NL+'Allowance: '+s.allowanceUsdce+NL+'Paused: '+s.paused+NL+'Batch: '+s.batchStatus+NL+'Runner: '+s.runner);return s}
setup.onclick=async()=>{try{const s=await api('/state');if(BigInt(s.allowanceMicro)<BigInt(s.depositMicro))await send(s.transactions.approve,'Approving exactly $1.35 USDC.e');const s2=await api('/state');if(s2.paused)await send(s2.transactions.unpause,'Unpausing the pilot vault');await refresh()}catch(e){setStatus(e.message)}};
start.onclick=async()=>{try{start.disabled=true;await wallet();setStatus('Rechecking the live book and opening batch 1...');const opened=await api('/open','POST');await send(opened.commit,'Batch is open. Confirm escrow now (30-second window).');setStatus('Escrow confirmed. Closing the batch and starting settlement...');await api('/close','POST');for(;;){const s=await refresh();if(s.runner==='settled'||s.runner==='failed'||s.batchStatus==='SETTLED')break;await new Promise(x=>setTimeout(x,3000))}}catch(e){setStatus(e.message);await refresh().catch(()=>{})}};
finish.onclick=async()=>{try{const s=await api('/state');if(!s.paused)await send(s.transactions.pause,'Pausing the pilot vault');await send(s.transactions.claim,'Claiming the settled pilot assets');await refresh();setStatus('Pilot claimed and vault paused. Complete.')}catch(e){setStatus(e.message)}};
pause.onclick=async()=>{try{const s=await api('/state');if(!s.paused)await send(s.transactions.pause,'Emergency pause');await refresh()}catch(e){setStatus(e.message)}};
refresh().catch(e=>setStatus(e.message));
</script></body></html>`;
}

async function main(): Promise<void> {
  const pilotPath = required("V11_PILOT_FILE");
  const pilot = await loadPilot(pilotPath);
  const rpcUrl = required("RPC_URL");
  const vault = getAddress(required("V11_VAULT_ADDRESS"));
  const guardian = getAddress(required("V11_GUARDIAN"));
  const usdce = getAddress("0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174");
  const relayer = privateKeyToAccount(required("V11_RELAYER_PRIVATE_KEY") as Hex);
  const reader = createPublicClient({ chain: polygon, transport: http(rpcUrl) });
  const writer = createWalletClient({ chain: polygon, transport: http(rpcUrl), account: relayer });
  const token = randomBytes(24).toString("hex");
  const batchId = BigInt(pilot.manifest.batchId);
  const deposit = BigInt(pilot.manifest.deposit);
  const yesTokenId = BigInt(required("V11_PILOT_YES_TOKEN_ID"));
  const noTokenId = BigInt(required("V11_PILOT_NO_TOKEN_ID"));
  let runner: ChildProcessWithoutNullStreams | undefined;
  let runnerState = "not_started";
  let runnerLog = "";

  async function state() {
    const [paused, next, active, balance, allowance, pol, batch, pusd, ctf] = await Promise.all([
      reader.readContract({ address: vault, abi: vaultAbi, functionName: "tradingPaused" }),
      reader.readContract({ address: vault, abi: vaultAbi, functionName: "nextBatchId" }),
      reader.readContract({ address: vault, abi: vaultAbi, functionName: "activeBatchId" }),
      reader.readContract({ address: usdce, abi: erc20Abi, functionName: "balanceOf", args: [guardian] }),
      reader.readContract({ address: usdce, abi: erc20Abi, functionName: "allowance", args: [guardian, vault] }),
      reader.getBalance({ address: guardian }),
      reader.readContract({ address: vault, abi: vaultAbi, functionName: "batches", args: [batchId] }),
      reader.readContract({ address: vault, abi: vaultAbi, functionName: "pusd" }),
      reader.readContract({ address: vault, abi: vaultAbi, functionName: "ctf" }),
    ]);
    const [walletPusd, walletYes, walletNo] = await Promise.all([
      reader.readContract({ address: pusd, abi: erc20Abi, functionName: "balanceOf", args: [pilot.manifest.depositWallet] }),
      reader.readContract({ address: ctf, abi: ctfAbi, functionName: "balanceOf", args: [pilot.manifest.depositWallet, yesTokenId] }),
      reader.readContract({ address: ctf, abi: ctfAbi, functionName: "balanceOf", args: [pilot.manifest.depositWallet, noTokenId] }),
    ]);
    const names = ["NONE", "OPEN", "CLOSED", "ROUTED", "SETTLED", "ABORTED"];
    const batchStatus = names[batch[12]] ?? `UNKNOWN_${batch[12]}`;
    return { paused, next, active, balance, allowance, pol, batch, batchStatus, walletPusd, walletYes, walletNo };
  }

  function reply(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  }

  async function openBatch(): Promise<Hex> {
    const current = await state();
    if (current.paused || current.next !== batchId ||
        current.batchStatus !== "NONE" || current.balance < deposit || current.allowance < deposit ||
        current.walletPusd !== 0n || current.walletYes !== 0n || current.walletNo !== 0n) {
      throw new Error("Pilot readiness changed; batch was not opened");
    }
    const book = await fetch(`https://clob.polymarket.com/book?token_id=${pilot.manifest.tokenId}`).then(async response => {
      if (!response.ok) throw new Error(`CLOB book returned ${response.status}`);
      return response.json() as Promise<{ asks?: Array<{ price: string; size: string }>; min_order_size: string }>;
    });
    const asks = (book.asks ?? []).map((ask) => ({ price: Number(ask.price), size: Number(ask.size) }))
      .filter((ask) => Number.isFinite(ask.price) && Number.isFinite(ask.size)).sort((a, b) => a.price - b.price);
    const best = asks[0];
    if (!best || best.price > 0.25 || Number(book.min_order_size) > Number(formatUnits(deposit, 6)) / best.price) {
      throw new Error("The selected CLOB ask no longer satisfies the pilot's bounded five-share order");
    }
    const hash = await writer.writeContract({
      address: vault,
      abi: vaultAbi,
      functionName: "openBatch",
      args: [pilot.manifest.marketId, yesTokenId, noTokenId],
    });
    const receipt = await reader.waitForTransactionReceipt({ hash, confirmations: 1, timeout: 60_000 });
    if (receipt.status !== "success") throw new Error("openBatch reverted");
    return hash;
  }

  async function closeAndRun(): Promise<Hex> {
    let current = await state();
    if (current.batchStatus !== "OPEN" || current.batch[5] !== 1n) {
      throw new Error("The pilot batch does not contain exactly one escrowed order");
    }
    const order = await reader.readContract({ address: vault, abi: vaultAbi, functionName: "orders", args: [batchId, 0n] });
    if (order[0].toLowerCase() !== pilot.manifest.commitment.toLowerCase() ||
        getAddress(order[3]) !== guardian || order[2] !== deposit) {
      throw new Error("Escrowed order differs from the prepared pilot");
    }
    for (;;) {
      const block = await reader.getBlock();
      if (block.timestamp >= current.batch[3] + 31n) break;
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      current = await state();
    }
    const hash = await writer.writeContract({ address: vault, abi: vaultAbi, functionName: "closeBatch", args: [batchId] });
    const receipt = await reader.waitForTransactionReceipt({ hash, confirmations: 5, timeout: 90_000 });
    if (receipt.status !== "success") throw new Error("closeBatch reverted");
    if (!runner) {
      runnerState = "running";
      runner = spawn("npm", ["run", "run:v11", "--", "--execute", pilot.manifest.batchId], {
        cwd: process.cwd(),
        env: { ...process.env, V11_ORDER_JSON: JSON.stringify(pilot.manifest) },
        stdio: "pipe",
      });
      const append = (chunk: Buffer) => {
        runnerLog = (runnerLog + chunk.toString("utf8")).slice(-4_000);
        process.stdout.write(chunk);
      };
      runner.stdout.on("data", append);
      runner.stderr.on("data", append);
      runner.on("exit", (code) => { runnerState = code === 0 ? "settled" : "failed"; });
    }
    return hash;
  }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/" && url.searchParams.get("t") === token) {
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "content-security-policy": "default-src 'self' 'unsafe-inline'; connect-src 'self'",
        });
        res.end(html(guardian, token));
        return;
      }
      if (req.headers["x-pilot-token"] !== token) {
        reply(res, 403, { error: "Forbidden" });
        return;
      }
      if (url.pathname === "/state" && req.method === "GET") {
        const current = await state();
        reply(res, 200, {
          vault,
          guardianUsdce: formatUnits(current.balance, 6),
          allowanceUsdce: formatUnits(current.allowance, 6),
          allowanceMicro: current.allowance.toString(),
          depositMicro: deposit.toString(),
          guardianPol: formatEther(current.pol),
          paused: current.paused,
          batchStatus: current.batchStatus,
          runner: runnerState,
          runnerLog: runnerState === "failed" ? runnerLog : undefined,
          ready: current.balance >= deposit && current.pol > 0n && current.allowance >= deposit && !current.paused,
          transactions: {
            approve: pilot.transactions.approve,
            unpause: pilot.transactions.unpause,
            pause: {
              to: vault,
              data: encodeFunctionData({ abi: vaultAbi, functionName: "setTradingPaused", args: [true] }),
            },
            claim: pilot.transactions.claim,
          },
        });
        return;
      }
      if (url.pathname === "/open" && req.method === "POST") {
        const hash = await openBatch();
        reply(res, 200, { hash, commit: pilot.transactions.commit });
        return;
      }
      if (url.pathname === "/close" && req.method === "POST") {
        const hash = await closeAndRun();
        reply(res, 200, { hash, runner: runnerState });
        return;
      }
      reply(res, 404, { error: "Not found" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Pilot controller failed";
      reply(res, 409, { error: message });
    }
  });
  server.listen(43117, "127.0.0.1", () => {
    console.log(`PREDACY_PILOT_URL=http://127.0.0.1:43117/?t=${token}`);
  });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "V11 pilot wallet server failed");
  process.exitCode = 1;
});
