/**
 * Extrae la memoria de las sesiones terminadas o inactivas. Pensado para correr cada pocos
 * minutos (cron hoy; el planificador del Sprint 8 lo reemplaza).
 *
 *   npm run memoria:procesar
 */
import { ModelosPorTarea } from '@vincular/ia';
import { cargarConfig } from '../config/config.ts';
import { crearPool } from '../db/conexion.ts';
import { procesarPendientes } from '../memoria/extraccion.ts';
import { Cifrador } from '../seguridad/cifrado.ts';

const config = cargarConfig();
const bd = crearPool(config.databaseUrl);
try {
  const r = await procesarPendientes({ bd, cifrador: new Cifrador(config.claveCifrado), modelos: new ModelosPorTarea(config.ia) }, { minutosInactividad: config.memoriaMinutosInactividad });
  const cuenta = r.reduce<Record<string, number>>((acc, x) => ({ ...acc, [x.estado]: (acc[x.estado] ?? 0) + 1 }), {});
  console.log(`Sesiones: ${r.length} · ${Object.entries(cuenta).map(([k, v]) => `${k}=${v}`).join(' · ') || 'nada pendiente'}`);
  for (const x of r) if (x.estado === 'error') console.error(`  error: ${x.error}`);
} finally {
  await bd.end();
}
