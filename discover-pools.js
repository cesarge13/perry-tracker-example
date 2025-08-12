import fetch from 'node-fetch';

const TOKEN = '0x5043F271095350c5ac7db2384A0d9337E27c1055'; // PERRY

const url = `https://api.dexscreener.com/latest/dex/tokens/${TOKEN}`;

const wanted = new Set(['bsc']); // filtramos por BSC
(async () => {
  const r = await fetch(url);
  const j = await r.json();
  if (!j?.pairs?.length) {
    console.log('DexScreener no devolvió pares para el token.');
    process.exit(0);
  }
  const pairs = j.pairs
    .filter(p => wanted.has(p.chainId))
    .map(p => ({
      chain: p.chainId,
      dex: p.dexId,
      pairAddress: p.pairAddress,
      baseSymbol: p.baseToken?.symbol,
      quoteSymbol: p.quoteToken?.symbol,
      liquidityUSD: Number(p.liquidity?.usd || 0),
      volume24h: Number(p.volume?.h24 || 0)
    }))
    .sort((a,b)=> b.liquidityUSD - a.liquidityUSD || b.volume24h - a.volume24h);

  if (!pairs.length) {
    console.log('No hay pares en BSC según DexScreener.');
    process.exit(0);
  }

  console.log('Top pares PERRY en BSC (ordenados por liquidez):');
  for (const p of pairs.slice(0,12)) {
    console.log(
      `${p.pairAddress} | ${p.dex} | ${p.baseSymbol}/${p.quoteSymbol} | liq=$${p.liquidityUSD.toFixed(0)} | vol24h=$${p.volume24h.toFixed(0)}`
    );
  }

  console.log('\nSugerencia: toma el pairAddress con mayor liquidez y ponlo en tu .env como POOL_ADDRESS.');
  process.exit(0);
})();
