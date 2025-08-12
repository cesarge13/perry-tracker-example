# PERRY Swap Tracker (BSC)

Tracker on‑chain del par PERRY/WBNB en Pancake (BSC).
Lee eventos Swap en tiempo real (WSS) y con polling HTTP (para no perder nada), y decodifica Uni/Pancake V2 y V3.
Guarda cada operación en swaps.csv con BUY/SELL + montos + USD aproximado.

También sirve para cualquier token/par: cambia direcciones en .env.
---

0) Qué hace y cómo está armado
	•	track-swaps.js → motor principal: escucha logs del pool y escribe swaps.csv.
	•	watch.js → sniffer ligero para verificar que tu RPC/WSS devuelve logs.
	•	check-pool.js → sanity check del par (que token0/1 sean los que crees).

Decodificación robusta

Algunos pools usan un topic[0] distinto al estándar. El tracker:
	1.	intenta V3 (firma oficial),
	2.	intenta V2,
	3.	y si falla, hace fallback manual V3 (decodifica data “a mano” y toma sender/recipient de los topics).
Así evitamos perder swaps aunque el topic sea raro.

----


## 📦 Requisitos

- Node.js 18+ (probado con v24.x)
- NPM
- RPC URL (HTTP y opcionalmente WSS) para BSC

	•	Un RPC HTTP de BSC (obligatorio) y un WSS (opcional, para tiempo real).
Públicos que funcionaron en pruebas:
	•	HTTP: https://bsc.drpc.org
	•	WSS:  wss://bsc-rpc.publicnode.com
(mejor usa endpoints con API key para producción; más estables y sin límites)

2) Instalación

# clona tu repositorio
git clone https://github.com/cesarge13/perry-tracker-example.git
cd <tu-repo>

# instala dependencias
npm install

3) Variables de entorno (NO las publiques)

El repo debe tener .gitignore con .env ignorado.
Ejemplo de ~/.env privado (no va al repo):

# RPCs
RPC_URL_HTTP=https://bsc.drpc.org
RPC_URL_WS=wss://bsc-rpc.publicnode.com

# Par PERRY/WBNB (puedes cambiar a otro)
POOL_ADDRESS=0x560A3375C67c8ad4c13018C87633e6066477151F
PERRY=0x5043F271095350c5ac7db2384A0d9337E27c1055
WBNB=0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c

# Umbral de alerta (consola)
LARGE_TRADE_USD=1000

4) Uso rápido

# 1) comprobación del pool
node check-pool.js
# Debe imprimir token0/1 y "¿Pool correcto PERRY/WBNB?: SÍ"

# 2) sniffer de logs (para ver que RPC/WSS devuelven eventos)
node watch.js
# Verás "eth_subscribe OK" (si el WSS permite) y/o ventanas con "X logs"

# 3) tracker principal (genera/actualiza swaps.csv)
node track-swaps.js
# Verás líneas tipo:
# Ventana [5737xxxx-5737yyyy] -> N logs
# BUY_PERRY [V3*] | PERRY=86,682.00 | BNB=0.2142 | ~$128 | tx=0x...

CSV schema (swaps.csv):
ts,tx,side,amountPERRY,amountWBNB,usd,sender,recipient
	•	side: BUY_PERRY / SELL_PERRY
	•	usd se calcula con precio de BNB desde Coingecko (aprox; sin slippage/fee).


5) Cómo cambiar a otro token/par
	1.	Sustituye POOL_ADDRESS, PERRY, WBNB en .env.
	2.	Ejecuta node check-pool.js para asegurar que el par corresponde (que token0/1 coincidan con tus direcciones).
	3.	Ejecuta node track-swaps.js.

6) Verificación con BscScan

Si un swap aparece en tu CSV pero no en DexScreener, valida contra la fuente de la verdad (BscScan):
	1.	Abre la tx en bscscan.com/tx/<hash>.
	2.	Pestaña Logs → busca el evento Swap del pair (POOL_ADDRESS).
	3.	Los amount0/amount1 deben coincidir (tu script convierte a unidades humanas y usa valor absoluto).
	•	En V3:
	•	con token0=PERRY / token1=WBNB
	•	amount0 < 0 ⇒ BUY_PERRY
	•	amount1 < 0 ⇒ SELL_PERRY

DexScreener puede ocultar/agrup​ar ciertos swaps (MEV, directos sin router, multi‑hop). Tu tracker registra todo lo que realmente sucedió on‑chain.

⸻

7) Diagnóstico rápido (cuando “no salen swaps”)

A. Comprueba que tu HTTP RPC responde (en terminal)

curl -s -X POST "$RPC_URL_HTTP" \
  -H "Content-Type: application/json" \
  --data '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}'

(Debe devolver un hex (0x…). Si sale Unauthorized, usa otro endpoint o añade tu API key.)

B. Ventanas de getLogs (diagnóstico en terminal)
node -e "import 'dotenv/config';import {ethers} from 'ethers';
const p=new ethers.JsonRpcProvider(process.env.RPC_URL_HTTP,{chainId:56,name:'bnb'});
const pool=process.env.POOL_ADDRESS;
(async()=>{const latest=await p.getBlockNumber();const from=Math.max(1,latest-2000);let total=0;
for(let s=from;s<=latest;s+=500){const e=Math.min(latest,s+499);
const logs=await p.getLogs({address:pool,fromBlock:s,toBlock:e});
total+=logs.length;console.log('ventana',s,'-',e,'=>',logs.length)}
console.log('TOTAL',total);process.exit(0)})().catch(console.error)"


	•	Si TOTAL > 0, el HTTP sirve y track-swaps.js debería empezar a registrar.
	•	Si ves “Cannot read properties of null (reading ‘map’)”: es el RPC público saturado → cambia a un endpoint con API key (Ankr/QuickNode/Nodereal) o reintenta (el script ya reintenta).


C. WSS con eth_subscribe

Muchos WSS bloquean filtros por topics; por eso el tracker usa address‑only + filtro local y, si falla WSS, queda el polling HTTP para no perder nada.

⸻

8) Errores comunes que vimos (y solución)
	•	Faltan variables en .env
→ Falta POOL_ADDRESS/PERRY/WBNB o RPC_URL_HTTP. Revisa .env.
	•	eth_newFilter: Method disabled
→ Límite del RPC público. El tracker ya evita newFilter y usa getLogs + address‑only.
	•	Cannot read properties of null (reading 'map') en getLogs
→ Respuesta parcial del RPC. Ya lo capturamos con try/catch y reintento; mejor usa endpoint con API key.
	•	“No swaps en bloques …” mientras hay trades en DexScreener
→ Prueba ventana B (arriba). Si TOTAL=0, cambia de HTTP RPC.
→ Si TOTAL>0 pero el script imprime logs>0, swaps=0, seguramente el topic[0] es no estándar. Nuestro fallback V3 manual (marcado como [V3*]) ya lo resuelve.
	•	Diferencias en WBNB vs DexScreener
→ Por redondeos, perspectiva BUY/SELL y/o su agregación. Valida con BscScan; on‑chain manda.
	•	MODULE_NOT_FOUND / rutas
→ Estabas ejecutando desde otra carpeta o el archivo no existía en esa ruta.
	•	Zsh imprime number expected
→ Ocurre si pegas líneas con comentarios # directamente en el comando. Ejecuta sólo la parte del comando, sin comentarios.

⸻

9) Seguridad y buenas prácticas
	•	Nunca subas .env (usa .gitignore y revisa git ls-files antes de hacer push).
	•	Si algún secreto se filtró, rota esa key en el proveedor.
	•	Para producción, usa RPC con API key y monitoreo (reintentos + alertas).
