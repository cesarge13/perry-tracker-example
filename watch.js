import 'dotenv/config';
import { ethers } from 'ethers';

const { RPC_URL_WS, RPC_URL_HTTP, POOL_ADDRESS } = process.env;
if (!RPC_URL_HTTP || !POOL_ADDRESS) throw new Error('Falta RPC_URL_HTTP o POOL_ADDRESS');

const http = new ethers.JsonRpcProvider(RPC_URL_HTTP, { chainId: 56, name: 'bnb' });
let ws = null;
if (RPC_URL_WS?.startsWith('ws')) { try { ws = new ethers.WebSocketProvider(RPC_URL_WS); } catch {} }

const V3_ABI = [
  'event Swap(address indexed sender,address indexed recipient,int256 amount0,int256 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick)'
];
const V2_ABI = [
  'event Swap(address indexed sender,uint256 amount0In,uint256 amount1In,uint256 amount0Out,uint256 amount1Out,address indexed to)'
];
const IFACE_V3 = new ethers.Interface(V3_ABI);
const IFACE_V2 = new ethers.Interface(V2_ABI);

function tryDecode(log){
  try { IFACE_V3.decodeEventLog('Swap', log.data, log.topics); return 'V3'; } catch {}
  try { IFACE_V2.decodeEventLog('Swap', log.data, log.topics); return 'V2'; } catch {}
  return null;
}

if (ws) {
  try {
    const subId = await ws.send('eth_subscribe', ['logs', { address: [POOL_ADDRESS] }]);
    console.log('WSS suscrito (id=', subId, ')');
    ws._websocket?.on('message', (data)=>{
      try{
        const msg = JSON.parse(data.toString());
        const log = msg?.params?.result;
        if (msg.method === 'eth_subscription' && log?.address?.toLowerCase() === POOL_ADDRESS.toLowerCase()) {
          const mode = tryDecode(log);
          if (mode) console.log('LOG (sub)', mode, log.blockNumber, log.transactionHash);
        }
      }catch{}
    });
    ws.on('error', e=>console.error('WS error', e?.message||e));
  } catch (e) {
    console.log('WSS rechazado:', e?.message||e);
  }
}

let last = (await http.getBlockNumber()) - 10;
console.log(`HTTP polling activo desde bloque ${last}`);

async function poll(){
  try{
    const latest = await http.getBlockNumber();
    if (latest > last) {
      for (let start=last+1; start<=latest; start+=500){
        const end = Math.min(latest, start+499);
        let logs=[];
        try{ logs = await http.getLogs({address: POOL_ADDRESS, fromBlock:start, toBlock:end}); }
        catch(e){ console.warn('getLogs ventana', `[${start}-${end}]`, e?.message||e); continue; }
        const swaps = logs.filter(l => tryDecode(l));
        console.log(`Ventana [${start}-${end}] -> ${logs?.length||0} logs, ${swaps.length} swaps`);
        for (const l of swaps) console.log('LOG (poll)', l.blockNumber, l.transactionHash);
      }
      last = latest;
    }
  }catch(e){
    console.error('poll error', e?.message||e);
  }finally{
    setTimeout(poll, 3000);
  }
}
poll();