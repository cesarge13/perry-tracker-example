import 'dotenv/config';
import { ethers } from 'ethers';
import fs from 'fs';

const {
  RPC_URL_WS,
  RPC_URL_HTTP,
  POOL_ADDRESS,
  PERRY,
  WBNB,
  LARGE_TRADE_USD = '5000',
} = process.env;

if (!RPC_URL_HTTP || !POOL_ADDRESS || !PERRY || !WBNB) {
  throw new Error('Faltan variables en .env (RPC_URL_HTTP / POOL_ADDRESS / PERRY / WBNB)');
}

// Providers
const http = new ethers.JsonRpcProvider(RPC_URL_HTTP, { chainId: 56, name: 'bnb' });
let ws = null;
if (RPC_URL_WS?.startsWith('ws')) {
  try { ws = new ethers.WebSocketProvider(RPC_URL_WS); } catch {}
}

// ABIs base
const V3_ABI = [
  'event Swap(address indexed sender,address indexed recipient,int256 amount0,int256 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
];
const V2_ABI = [
  'event Swap(address indexed sender,uint256 amount0In,uint256 amount1In,uint256 amount0Out,uint256 amount1Out,address indexed to)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
];
const ERC20_ABI = ['function decimals() view returns (uint8)'];

const IFACE_V3 = new ethers.Interface(V3_ABI);
const IFACE_V2 = new ethers.Interface(V2_ABI);
const coder = ethers.AbiCoder.defaultAbiCoder();

// CSV
const CSV = 'swaps.csv';
if (!fs.existsSync(CSV)) {
  fs.writeFileSync(CSV, 'ts,tx,side,amountPERRY,amountWBNB,usd,sender,recipient\n');
}

// Estado
let P0 = false; // ¿PERRY es token0?
let decP = 18, decB = 18;
let WBNB_USD = 550;

async function updateBNB() {
  try {
    const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=binancecoin&vs_currencies=usd');
    const j = await r.json();
    WBNB_USD = j?.binancecoin?.usd || WBNB_USD;
  } catch {}
}

function writeCsv(row) { fs.appendFileSync(CSV, row + '\n'); }

// ---------- Decodificadores ----------

// V3 “oficial” (topic estándar)
function tryDecodeV3Interface(log) {
  try {
    const ev = IFACE_V3.decodeEventLog('Swap', log.data, log.topics);
    return {
      mode: 'V3',
      sender: ev.sender,
      recipient: ev.recipient,
      amount0: ev.amount0,
      amount1: ev.amount1,
      isV3Layout: true,
    };
  } catch { return null; }
}

// V2 “oficial”
function tryDecodeV2Interface(log) {
  try {
    const ev = IFACE_V2.decodeEventLog('Swap', log.data, log.topics);
    return {
      mode: 'V2',
      sender: ev.sender,
      recipient: ev.to,
      amount0In: ev.amount0In, amount1In: ev.amount1In,
      amount0Out: ev.amount0Out, amount1Out: ev.amount1Out,
      isV3Layout: false,
    };
  } catch { return null; }
}

// Fallback manual V3: ignora topic[0] y decodifica data como
// [int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick]
// sender/recipient vienen en topics[1] y topics[2]
function tryDecodeV3Manual(log) {
  try {
    // topics deben tener sender/recipient indexados (3 topics)
    if (!log?.topics || log.topics.length < 3) return null;

    // data debe tener 5 words (≈ 32 * 5 bytes)
    const dataHex = log.data;
    // decode lanzará si el layout no coincide
    const [a0, a1, , , ] = coder.decode(
      ['int256', 'int256', 'uint160', 'uint128', 'int24'],
      dataHex
    );

    const sender = ethers.getAddress('0x' + log.topics[1].slice(26));
    const recipient = ethers.getAddress('0x' + log.topics[2].slice(26));

    return {
      mode: 'V3*',            // * = manual
      sender, recipient,
      amount0: a0,
      amount1: a1,
      isV3Layout: true,
    };
  } catch {
    return null;
  }
}

// Normaliza a { side, amtP, amtB, sender, recipient, mode }
function normalize(decoded) {
  if (!decoded) return null;

  if (decoded.isV3Layout) {
    const { amount0, amount1, sender, recipient, mode } = decoded;
    let side, amtP, amtB;
    if (P0) {
      const a0 = Number(ethers.formatUnits(amount0, decP)); // PERRY
      const a1 = Number(ethers.formatUnits(amount1, decB)); // WBNB
      side = a0 < 0 ? 'BUY_PERRY' : 'SELL_PERRY';
      amtP = Math.abs(a0);
      amtB = Math.abs(a1);
    } else {
      const a1 = Number(ethers.formatUnits(amount1, decP)); // PERRY
      const a0 = Number(ethers.formatUnits(amount0, decB)); // WBNB
      side = a1 < 0 ? 'BUY_PERRY' : 'SELL_PERRY';
      amtP = Math.abs(a1);
      amtB = Math.abs(a0);
    }
    return { side, amtP, amtB, sender, recipient, mode };
  } else {
    // V2
    const { sender, recipient, amount0In, amount1In, amount0Out, amount1Out, mode } = decoded;
    let side, amtP, amtB;
    if (P0) {
      const netP = (BigInt(amount0Out) - BigInt(amount0In));
      const netB = (BigInt(amount1Out) - BigInt(amount1In));
      side = netP > 0n ? 'BUY_PERRY' : 'SELL_PERRY';
      amtP = Number(ethers.formatUnits(netP >= 0n ? netP : -netP, decP));
      amtB = Number(ethers.formatUnits(netB >= 0n ? netB : -netB, decB));
    } else {
      const netP = (BigInt(amount1Out) - BigInt(amount1In));
      const netB = (BigInt(amount0Out) - BigInt(amount0In));
      side = netP > 0n ? 'BUY_PERRY' : 'SELL_PERRY';
      amtP = Number(ethers.formatUnits(netP >= 0n ? netP : -netP, decP));
      amtB = Number(ethers.formatUnits(netB >= 0n ? netB : -netB, decB));
    }
    return { side, amtP, amtB, sender, recipient, mode };
  }
}

// Procesa un log cualquiera del pool
function handleLog(log) {
  try {
    const dV3 = tryDecodeV3Interface(log);
    const dV2 = dV3 ? null : tryDecodeV2Interface(log);
    const dM  = (dV3 || dV2) ? null : tryDecodeV3Manual(log);

    const norm = normalize(dV3 || dV2 || dM);
    if (!norm) return; // no era swap

    const { side, amtP, amtB, sender, recipient, mode } = norm;
    const usd = (WBNB_USD || 0) * amtB;
    const ts = Math.floor(Date.now() / 1000);

    writeCsv(`${ts},${log.transactionHash},${side},${amtP.toFixed(6)},${amtB.toFixed(6)},${usd.toFixed(2)},${sender},${recipient}`);
    console.log(`${side} [${mode}] | PERRY=${amtP.toFixed(2)} | BNB=${amtB.toFixed(4)} | ~$${usd.toFixed(0)} | tx=${log.transactionHash}`);

    if (usd >= Number(LARGE_TRADE_USD)) {
      console.log(`>>> ALARMA: ~$${usd.toFixed(0)} (${side})`);
    }
  } catch (e) {
    console.error('Decode error:', e);
  }
}

(async () => {
  // token0/token1 y decimales
  const poolHttpV3 = new ethers.Contract(POOL_ADDRESS, V3_ABI, http);
  const poolHttpV2 = new ethers.Contract(POOL_ADDRESS, V2_ABI, http);

  let t0, t1;
  try { [t0, t1] = await Promise.all([poolHttpV3.token0(), poolHttpV3.token1()]); }
  catch { [t0, t1] = await Promise.all([poolHttpV2.token0(), poolHttpV2.token1()]); }

  P0 = t0.toLowerCase() === PERRY.toLowerCase();

  const ercP = new ethers.Contract(PERRY, ERC20_ABI, http);
  const ercB = new ethers.Contract(WBNB,  ERC20_ABI, http);
  const [dP, dB] = await Promise.all([ercP.decimals(), ercB.decimals()]);
  decP = Number(dP); decB = Number(dB);

  await updateBNB();
  setInterval(updateBNB, 60_000);

  // WSS (opcional)
  if (ws) {
    try {
      const subId = await ws.send('eth_subscribe', ['logs', { address: [POOL_ADDRESS] }]);
      console.log('WSS suscrito (id=', subId, ')');
      ws._websocket?.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          const log = msg?.params?.result;
          if (msg.method === 'eth_subscription' && log?.address?.toLowerCase() === POOL_ADDRESS.toLowerCase()) {
            handleLog(log);
          }
        } catch {}
      });
      ws.on('error', (e) => console.error('WS error', e?.message || e));
    } catch (e) {
      console.log('WSS eth_subscribe rechazado -> sigo con HTTP polling.', e?.message || e);
    }
  }

  // HTTP polling (address-only)
  let last = (await http.getBlockNumber()) - 1000;
  console.log(`Escuchando swaps | WSS=${!!ws} | HTTP polling desde ${last}`);

  while (true) {
    try {
      const latest = await http.getBlockNumber();
      if (latest > last) {
        for (let start = last + 1; start <= latest; start += 500) {
          const end = Math.min(latest, start + 499);
          let logs = [];
          try {
            logs = await http.getLogs({ address: POOL_ADDRESS, fromBlock: start, toBlock: end });
          } catch (rpcErr) {
            console.warn('getLogs error ventana', `[${start}-${end}]`, rpcErr?.message || rpcErr);
            continue;
          }

          if (logs?.length) console.log(`Ventana [${start}-${end}] -> ${logs.length} logs`);
          for (const log of logs || []) handleLog(log);
        }
        last = latest;
      }
      await new Promise(r => setTimeout(r, 3000));
    } catch (e) {
      console.error('Polling error:', e?.message || e);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
})().catch(console.error);