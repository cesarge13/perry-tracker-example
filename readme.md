Swap Tracker Multi-Token (BSC)

Tracker on-chain para cualquier par de tokens en PancakeSwap (BSC).
Lee eventos Swap en tiempo real (WSS) y con polling HTTP (para no perder nada), y decodifica Uni/Pancake V2 y V3.
Guarda cada operación en swaps.csv con BUY/SELL + montos + USD aproximado.

Solo necesitas cambiar las direcciones en .env para rastrear el token/par que quieras.


0) Qué hace y cómo está armado
	•	track-swaps.js → motor principal: escucha logs del pool y escribe swaps.csv.
	•	watch.js → sniffer ligero para verificar que tu RPC/WSS devuelve logs.
	•	check-pool.js → sanity check del par (que token0/token1 sean los que crees).

Decodificación robusta
Algunos pools usan un topic[0] distinto al estándar. El tracker:
	1.	Intenta V3 (firma oficial).
	2.	Intenta V2.
	3.	Si falla, hace fallback manual V3 (decodifica data “a mano” y toma sender/recipient de los topics).

Así evitamos perder swaps aunque el topic sea raro.

⸻

📦 Requisitos
	•	Node.js 18+ (probado con v24.x)
	•	NPM
	•	RPC URL (HTTP y opcionalmente WSS) para BSC

Ejemplos de RPCs públicos que funcionaron en pruebas:
	•	HTTP: https://bsc.drpc.org
	•	WSS:  wss://bsc-rpc.publicnode.com

Para producción, usa endpoints con API key (más estables y sin límites).

⸻

1) Instalación
# Clona repositorio
git clone https://github.com/cesarge13/token_tracker_EVM.git
cd token_tracker_EVM.git

# Instala dependencias
npm install

2) Variables de entorno (NO las publiques)

El repo debe tener .gitignore con .env ignorado.

Ejemplo de .env privado (no va al repo):

# RPCs
RPC_URL_HTTP=https://bsc.drpc.org
RPC_URL_WS=wss://bsc-rpc.publicnode.com

# Par a rastrear (cambia según el token/par que desees)
POOL_ADDRESS=0x....
TOKEN0_ADDRESS=0x....
TOKEN1_ADDRESS=0x....

# Umbral de alerta (consola)
LARGE_TRADE_USD=1000

3) Comandos
# 1) Tracker que escribe swaps.csv
node track-swaps.js

# 2) Sniffer de logs (diagnóstico; no escribe CSV)
node watch.js

# 3) Verifica el par y decimales
node check-pool.js

# 4) Descubre pools del token (vía Dexscreener)
node discover-pools.js

# 5) Encuentra pools con swaps en la ventana reciente
node find-pools.js

# 6) Limpieza rápida / profunda
bash reset.sh
bash reset.sh --deep && npm install

Formato CSV (swaps.csv):
ts,tx,side,amountTOKEN0,amountTOKEN1,usd,sender,recipient

	•	side: BUY_TOKEN0 / SELL_TOKEN0
	•	usd: calculado usando precio del token base (ej. BNB) desde Coingecko (aprox).

4) Cambiar a otro token/par
	1.	Sustituye POOL_ADDRESS, TOKEN0_ADDRESS, TOKEN1_ADDRESS en .env.
	2.	Ejecuta:
			node check-pool.js
	3.	Si es correcto, corre:
		node track-swaps.js
	

5) Verificación con BscScan

Si un swap aparece en tu CSV pero no en DexScreener, valida contra BscScan:
	1.	Abre la tx en https://bscscan.com/tx/<hash>.
	2.	Ve a la pestaña Logs → busca el evento Swap del par (POOL_ADDRESS).
	3.	Los amount0/amount1 deben coincidir con los de tu CSV.

DexScreener puede ocultar ciertos swaps (MEV, directos sin router, multi-hop).
Tu tracker siempre registra lo que ocurrió on-chain.

⸻

6) Errores comunes
	•	Faltan variables en .env → revisa que tengas todas (POOL_ADDRESS, TOKEN0_ADDRESS, TOKEN1_ADDRESS, RPC_URL_HTTP).
	•	RPC saturado → cambia a uno con API key.
	•	“No swaps en bloques …” mientras hay trades → puede ser un topic[0] no estándar, el script ya lo maneja con fallback.

⸻

7) Seguridad
	•	Nunca subas .env al repo.
	•	Si se filtra una API key, cámbiala en el proveedor.
	•	Para producción, usa RPCs con API key y monitoreo.

				

