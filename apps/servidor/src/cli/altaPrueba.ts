/**
 * Crea una persona de prueba con su tablet y muestra el código que se pega en /tablet.
 *
 *   npm run cli:alta-prueba -w @vincular/servidor -- --nombre "Elena Prueba" --comuna "Puerto Montt"
 *
 * Solo para probar un servidor recién instalado; las altas reales se hacen por la API.
 */
import { parseArgs } from 'node:util';
import { altaPersonaDePrueba } from '../administracion/altaPrueba.ts';
import { cargarConfig } from '../config/config.ts';
import { crearPool } from '../db/conexion.ts';
import { Cifrador } from '../seguridad/cifrado.ts';

const { values } = parseArgs({ options: { nombre: { type: 'string' }, comuna: { type: 'string' }, dispositivo: { type: 'string', default: 'Tablet de prueba' } } });
if (!values.nombre || !values.comuna) {
  console.error('Uso: npm run cli:alta-prueba -- --nombre <nombre> --comuna <comuna> [--dispositivo <nombre>]');
  process.exit(1);
}
const config = cargarConfig();
const bd = crearPool(config.databaseUrl);
try {
  const r = await altaPersonaDePrueba(bd, new Cifrador(config.claveCifrado), { nombre: values.nombre, comuna: values.comuna, nombreDispositivo: values.dispositivo });
  console.log(`Persona de prueba creada: ${r.personaId}`);
  console.log('Código de la tablet (se muestra una sola vez; péguelo en /tablet):');
  console.log(r.token);
} finally {
  await bd.end();
}
