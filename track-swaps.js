import 'dotenv/config';
import { ethers } from 'ethers';
import fs from 'fs';

const {
  RPC_URL_HTTP,
  RPC_URL_WS,
  POOL_ADDRESS,
  TARGET_TOKEN,                // opcional
  LARGE_TRADE_USD = '1000',
} = process.env;

if (!RPC_URL_HTTP || !POOL_ADDRESS) {
  throw new Error('Faltan variables en .env (RPC_URL_HTTP / POOL_ADDRESS)');
}

// Providers
const http = new ethers.JsonRpcProvider(RPC_URL_HTTP, { chainId: 56, name: 'bnb' });
let ws = null;
if (RPC_URL_WS?.startsWith('ws')) {
  try { ws = new ethers.WebSocketProvider(RPC_URL_WS); } catch {}
}

// ABIs
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
const ERC20 = [
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
];

const IFACE_V3 = new ethers.Interface(V3_ABI);
const IFACE_V2 = new ethers.Interface(V2_ABI);
const coder = ethers.AbiCoder.defaultAbiCoder();

// Estado dinámico del par
let token0, token1;          // direcciones
let sym0 = 'T0', sym1 = 'T1';
let dec0 = 18, dec1 = 18;
let focus = 0;               // 0 -> token0 es el “objetivo”, 1 -> token1
let WBNB_USD = 550;          // solo para estimación rápida

// Helpers
async function getSymbol(addr) {
  try {
    const c = new ethers.Contract(addr, ERC20, http);
    const s = await c.symbol();
    return typeof s === 'string' && s.length ? s : addr.slice(0,6);
  } catch {
    return addr.slice(0,6);
  }
}
async function getDecimals(addr, fallback=18) {
  try {
    const c = new ethers.Contract(addr, ERC20, http);
    const d = await c.decimals();
    return Number(d);
  } catch {
    return fallback;
  }
}
async function updateBNB() {
  try {
    const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=binancecoin&vs_currencies=usd');
    const j = await r.json();
    WBNB_USD = j?.binancecoin?.usd || WBNB_USD;
  } catch {}
}

// Decoders
function tryDecodeV3Interface(log){ try {
  const ev = IFACE_V3.decodeEventLog('Swap', log.data, log.topics);
  return { mode:'V3', sender:ev.sender, recipient:ev.recipient, amount0:ev.amount0, amount1:ev.amount1, isV3:true };
} catch { return null; } }

function tryDecodeV2Interface(log){ try {
  const ev = IFACE_V2.decodeEventLog('Swap', log.data, log.topics);
  return { mode:'V2', sender:ev.sender, recipient:ev.to, amount0In:ev.amount0In, amount1In:ev.amount1In, amount0Out:ev.amount0Out, amount1Out:ev.amount1Out, isV3:false };
} catch { return null; } }

function tryDecodeV3Manual(log){ try {
  if (!log?.topics || log.topics.length < 3) return null;
  const [a0,a1] = coder.decode(['int256','int256','uint160','uint128','int24'], log.data);
  const sender = ethers.getAddress('0x' + log.topics[1].slice(26));
  const recipient = ethers.getAddress('0x' + log.topics[2].slice(26));
  return { mode:'V3*', sender, recipient, amount0:a0, amount1:a1, isV3:true };
} catch { return null; } }

// Normalización a “BUY/SELL del token foco”
function normalize(logDecoded){
  if (!logDecoded) return null;

  if (logDecoded.isV3) {
    const { amount0, amount1, sender, recipient, mode } = logDecoded;
    // V3: amountX es el delta del POOL (positivo => pool recibe tokenX)
    const a0 = Number(ethers.formatUnits(amount0, dec0));
    const a1 = Number(ethers.formatUnits(amount1, dec1));

    // Token foco y token contrario
    const symF = (focus === 0) ? sym0 : sym1;
    const symO = (focus === 0) ? sym1 : sym0;
    const amtF = (focus === 0) ? Math.abs(a0) : Math.abs(a1);
    const amtO = (focus === 0) ? Math.abs(a1) : Math.abs(a0);

    // Regla: si el pool RECIBE el foco (amountF > 0) => usuario vende foco => SELL
    // si el pool ENTREGA el foco (amountF < 0) => usuario compra foco => BUY
    const poolDeltaFocus = (focus === 0) ? a0 : a1;
    const side = (poolDeltaFocus < 0) ? `BUY_${symF}` : `SELL_${symF}`;

    return { side, amtFocus: amtF, amtOther: amtO, symF, symO, sender, recipient, mode };
  } else {
    // V2: in/out explícitos; net > 0 => pool entrega token => BUY de ese token
    const { sender, recipient, amount0In, amount1In, amount0Out, amount1Out, mode } = logDecoded;

    const net0 = BigInt(amount0Out) - BigInt(amount0In); // >0 => pool entrega token0
    const net1 = BigInt(amount1Out) - BigInt(amount1In); // >0 => pool entrega token1

    const symF = (focus === 0) ? sym0 : sym1;
    const symO = (focus === 0) ? sym1 : sym0;

    const netF = (focus === 0) ? net0 : net1;
    const netO = (focus === 0) ? net1 : net0;

    const side = (netF > 0n) ? `BUY_${symF}` : `SELL_${symF}`;
    const amtF = Number(ethers.formatUnits(netF >= 0n ? netF : -netF, (focus === 0) ? dec0 : dec1));
    const amtO = Number(ethers.formatUnits(netO >= 0n ? netO : -netO, (focus === 0) ? dec1 : dec0));

    return { side, amtFocus: amtF, amtOther: amtO, symF, symO, sender, recipient, mode };
  }
}

// CSV setup (cabecera dinámica)
const CSV = 'swaps.csv';
function ensureCsvHeader() {
  const header = `ts,tx,side,amount${sym0},amount${sym1},usd,sender,recipient\n`;
  if (!fs.existsSync(CSV)) {
    fs.writeFileSync(CSV, header);
    return;
  }
  // Si cambian símbolos (otro pool), reescribe header manteniendo datos
  const content = fs.readFileSync(CSV, 'utf8');
  const lines = content.split('\n');
  if (!lines[0]?.startsWith('ts,tx,side,amount')) {
    fs.writeFileSync(CSV, header + lines.slice(1).join('\n'));
  }
}

// Procesar un log
function handleLog(log) {
  try {
    const d = tryDecodeV3Interface(log) || tryDecodeV2Interface(log) || tryDecodeV3Manual(log);
    const n = normalize(d);
    if (!n) return;

    // Para USD aproximado, si uno de los tokens es WBNB usamos ese monto
    let bnbAmt = 0;
    if ([token0, token1].map(s => s.toLowerCase()).includes('0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c')) {
      // si token1 es WBNB y focus es token0 => “other” es WBNB (y viceversa)
      if (token0.toLowerCase() === '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c') {
        // token0 es WBNB
        bnbAmt = (focus === 0) ? n.amtFocus : n.amtOther;
      } else {
        // token1 es WBNB
        bnbAmt = (focus === 1) ? n.amtFocus : n.amtOther;
      }
    }
    const usd = (WBNB_USD || 0) * (bnbAmt || 0);
    const ts = Math.floor(Date.now() / 1000);

    // escribir CSV (colocando en orden amountToken0, amountToken1)
    const amt0 = (focus === 0) ? n.amtFocus : n.amtOther;
    const amt1 = (focus === 0) ? n.amtOther : n.amtFocus;

    fs.appendFileSync(
      CSV,
      `${ts},${log.transactionHash},${n.side},${amt0.toFixed(6)},${amt1.toFixed(6)},${usd.toFixed(2)},${n.sender},${n.recipient}\n`
    );

    console.log(
      `${n.side} [${n.mode}] | ${sym0}=${amt0.toFixed(6)} | ${sym1}=${amt1.toFixed(6)} | ~$${usd.toFixed(0)} | tx=${log.transactionHash}`
    );

    if (usd >= Number(LARGE_TRADE_USD)) {
      console.log(`>>> ALARMA: ~$${usd.toFixed(0)} (${n.side})`);
    }
  } catch (e) {
    console.error('Decode error:', e?.message || e);
  }
}

(async () => {
  // Detectar token0/token1, símbolos y decimales
  let t0, t1;
  try {
    const poolV3 = new ethers.Contract(POOL_ADDRESS, V3_ABI, http);
    [t0, t1] = await Promise.all([poolV3.token0(), poolV3.token1()]);
  } catch {
    const poolV2 = new ethers.Contract(POOL_ADDRESS, V2_ABI, http);
    [t0, t1] = await Promise.all([poolV2.token0(), poolV2.token1()]);
  }
  token0 = ethers.getAddress(t0);
  token1 = ethers.getAddress(t1);

  // símbolos y decimales
  [sym0, sym1] = await Promise.all([getSymbol(token0), getSymbol(token1)]);
  [dec0, dec1] = await Promise.all([getDecimals(token0), getDecimals(token1)]);

  // foco (TARGET_TOKEN opcional)
  if (TARGET_TOKEN) {
    const tt = TARGET_TOKEN.toLowerCase();
    if (tt === token0.toLowerCase()) focus = 0;
    else if (tt === token1.toLowerCase()) focus = 1;
    else console.log('⚠️ TARGET_TOKEN no coincide con token0/token1; uso token0 por defecto.');
  } else {
    focus = 0; // por defecto
  }

  console.log(`Pool: ${token0} (${sym0}) / ${token1} (${sym1}) | foco=${focus===0?sym0:sym1}`);
  ensureCsvHeader();

  await updateBNB();
  setInterval(updateBNB, 60_000);

  // Suscripción WSS (address-only) + filtro local
  if (ws) {
    try {
      const subId = await ws.send('eth_subscribe', ['logs', { address: [POOL_ADDRESS] }]);
      console.log('WSS suscrito (id=', subId, ')');
      ws._websocket?.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          const log = msg?.params?.result;
          if (msg.method === 'eth_subscription' &&
              log?.address?.toLowerCase() === POOL_ADDRESS.toLowerCase()) {
            handleLog(log);
          }
        } catch {}
      });
      ws.on('error', (e) => console.error('WS error', e?.message || e));
    } catch (e) {
      console.log('WSS eth_subscribe rechazado -> sigo con HTTP polling.', e?.message || e);
    }
  }

  // Polling HTTP continuo (address-only)
  let last = (await http.getBlockNumber()) - 800;
  console.log(`Escuchando swaps | HTTP polling desde bloque ${last}`);

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
            console.warn('getLogs error', `[${start}-${end}]`, rpcErr?.message || rpcErr);
            continue;
          }
          for (const log of logs) handleLog(log);
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