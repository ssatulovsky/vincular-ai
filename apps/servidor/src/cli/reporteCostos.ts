/**
 * Costo de modelos del mes, por persona y por conversación.
 *
 *   npm run costos:reporte -- 2026-11
 */
import { cargarConfig } from '../config/config.ts';
import { cargarPrecios, costosDelMes } from '../costos/costos.ts';
import { crearPool } from '../db/conexion.ts';

const mes = process.argv[2] ?? new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Santiago', year: 'numeric', month: '2-digit' }).format(new Date());
const config = cargarConfig();
const bd = crearPool(config.databaseUrl);
try {
  const r = await costosDelMes(bd, cargarPrecios(config.rutaPrecios), mes);
  const usd = (n: number | null) => (n === null ? 's/p' : `US$ ${n.toFixed(4)}`);
  console.log(`Mes ${r.mes} · precios verificados: ${r.preciosVerificadosEn ?? 'NO'}`);
  console.log(`Total: ${r.total.tokensEntrada} tokens de entrada, ${r.total.tokensSalida} de salida, ${r.total.llamadas} llamadas (${r.total.fallidas} fallidas) · ${usd(r.total.usd)}`);
  for (const p of r.personas) console.log(`  ${p.personaId}: ${p.sesiones} conversaciones · ${usd(p.usd)} · por conversación ${usd(p.usdPorConversacion)}`);
  if (r.total.modelosSinPrecio.length) console.log(`Modelos sin precio en config/precios-modelos.json: ${r.total.modelosSinPrecio.join(', ')}`);
} finally {
  await bd.end();
}
