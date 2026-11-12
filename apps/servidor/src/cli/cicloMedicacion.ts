/**
 * Un paso del ciclo de medicación (agenda, recordatorios, segundos avisos, sin respuesta).
 * El servidor lo corre solo cada 20 s; esta CLI sirve si el planificador está apagado
 * (PLANIFICADOR=no) o para revisar el estado. Sin el servidor no hay tablets conectadas:
 * los recordatorios quedan como no entregados en línea.
 *
 *   npm run medicacion:ciclo
 */
import { cargarConfig } from '../config/config.ts';
import { crearPool } from '../db/conexion.ts';
import { cicloMedicacion } from '../medicacion/agenda.ts';
import { Cifrador } from '../seguridad/cifrado.ts';

const config = cargarConfig();
const bd = crearPool(config.databaseUrl);
try {
  const r = await cicloMedicacion({ bd, cifrador: new Cifrador(config.claveCifrado), entrega: { entregar: async () => false }, plazos: config.medicacion }, new Date());
  console.log(JSON.stringify(r));
} finally {
  await bd.end();
}
