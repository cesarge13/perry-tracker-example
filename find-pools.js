import 'dotenv/config';
import { ethers } from 'ethers';

const { RPC_URL, PERRY, WBNB } = process.env;
if (!RPC_URL || !PERRY || !WBNB) throw new Error('Faltan RPC_URL / PERRY / WBNB');

const provider = new ethers.JsonRpcProvider(RPC_URL);

// Firmas de evento
const v3Abi = ['event Swap(address indexed sender,address indexed recipient,int256 amount0,int256 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick)'];
const v2Abi = ['event Swap(address indexed sender,uint256 amount0In,uint256 amount1In,uint256 amount0Out,uint256 amount1Out,address indexed to)'];
const v3 = new ethers.Interface(v3Abi);
const v2 = new ethers.Interface(v2Abi);
const v3Topic = v3.getEvent('Swap').topicHash;
const v2Topic = v2.getEvent('Swap').topicHash;

// Para comprobar tokens en la dirección (sirve tanto v2 como v3)
const pairAbi = [
  'function token0() view returns (address)',
  'function token1() view returns (address)'
];

const P = PERRY.toLowerCase();
const B = WBNB.toLowerCase();

(async () => {
  const latest = await provider.getBlockNumber();
  const from = Math.max(1, latest - 5000); // ventana 5k bloques
  console.log(`Buscando pools con swaps entre [${from}-${latest}] ...`);

  // Trae logs de v2 y v3 en ventanas (para evitar límites)
  const topics = [v2Topic, v3Topic];
  const step = 800;
  const candidates = new Map(); // addr -> count

  for (const topic of topics) {
    for (let start = from; start <= latest; start += step) {
      const end = Math.min(latest, start + step - 1);
      const logs = await provider.getLogs({ fromBlock: start, toBlock: end, topics: [topic] });
      for (const lg of logs) {
        const addr = lg.address.toLowerCase();
        candidates.set(addr, (candidates.get(addr) || 0) + 1);
      }
    }
  }

  console.log(`Direcciones con swaps detectadas: ${candidates.size}`);

  // Filtra por aquellas cuyo token0/token1 coincidan con PERRY/WBNB
  const matches = [];
  for (const [addr, count] of candidates) {
    try {
      const c = new ethers.Contract(addr, pairAbi, provider);
      const [t0, t1] = await Promise.all([c.token0(), c.token1()]);
      const a0 = t0.toLowerCase(), a1 = t1.toLowerCase();
      const ok = (a0 === P && a1 === B) || (a0 === B && a1 === P);
      if (ok) matches.push({ address: addr, count });
    } catch {
      // no es un par compatible (ignora)
    }
  }

  matches.sort((a,b)=>b.count-a.count);
  if (matches.length === 0) {
    console.log('No encontré pools PERRY/WBNB en la ventana.');
  } else {
    console.log('Pools PERRY/WBNB encontrados (ordenados por actividad):');
    for (const m of matches) console.log(`  ${m.address}  | swaps=${m.count}`);
    console.log('\nSugerencia: usa el primero en tu .env como POOL_ADDRESS.');
  }
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });