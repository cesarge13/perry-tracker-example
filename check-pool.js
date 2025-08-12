import 'dotenv/config';
import { ethers } from 'ethers';

const { RPC_URL, POOL_ADDRESS, PERRY, WBNB } = process.env;

const provider = RPC_URL?.startsWith('ws')
  ? new ethers.WebSocketProvider(RPC_URL)
  : new ethers.JsonRpcProvider(RPC_URL);

const poolAbi = [
  'function token0() view returns (address)',
  'function token1() view returns (address)'
];
const erc20Abi = [
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)'
];

(async () => {
  const pool = new ethers.Contract(POOL_ADDRESS, poolAbi, provider);

  const t0 = (await pool.token0()).toLowerCase();
  const t1 = (await pool.token1()).toLowerCase();
  console.log('token0 =', t0);
  console.log('token1 =', t1);

  const tok0 = new ethers.Contract(t0, erc20Abi, provider);
  const tok1 = new ethers.Contract(t1, erc20Abi, provider);
  const [s0, d0] = await Promise.all([tok0.symbol(), tok0.decimals()]);
  const [s1, d1] = await Promise.all([tok1.symbol(), tok1.decimals()]);

  // Evitamos backticks para que no falle por codificación
  console.log('token0 symbol=%s decimals=%d', s0, d0);
  console.log('token1 symbol=%s decimals=%d', s1, d1);

  const ok = [t0, t1].includes(PERRY.toLowerCase()) &&
             [t0, t1].includes(WBNB.toLowerCase());
  console.log('¿Pool correcto PERRY/WBNB?:', ok ? 'SÍ' : 'NO');
  process.exit(ok ? 0 : 1);
})().catch(e => {
  console.error(e);
  process.exit(1);
});
