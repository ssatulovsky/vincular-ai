/**
 * Proceso del agente de tiempo real.
 *
 *   npm run agente -w @vincular/servidor            (producción: node --import tsx … start)
 *
 * Se conecta al servidor de LiveKit (LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET) y espera
 * que el servidor web lo despache a una sala con el nombre LIVEKIT_AGENTE.
 */
import { fileURLToPath } from 'node:url';
import { cli, ServerOptions } from '@livekit/agents';
import { crearAplicacion } from '../api/servidor.ts';
import { cerrarUsosHuerfanos } from '../companero/avatarAnimado.ts';
import { cargarConfig } from '../config/config.ts';

const config = cargarConfig({ ...process.env, PLANIFICADOR: 'no' });
if (!config.tiempoReal) {
  console.error('Falta configurar LiveKit (LIVEKIT_URL_PUBLICA, LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET).');
  process.exit(1);
}

// Solo aquí (proceso principal, una vez por arranque): los procesos de cada conversación pueden
// tener sesiones de avatar vivas, pero al arrancar el servicio todas las abiertas son de antes.
try {
  const app = crearAplicacion(config);
  const cerradas = await cerrarUsosHuerfanos(app.bd);
  if (cerradas > 0) console.log(JSON.stringify({ msg: 'agente.avatar_usos_cerrados', cerradas }));
  await app.bd.end();
} catch (e) {
  console.error(JSON.stringify({ msg: 'agente.avatar_usos_sin_cerrar', error: (e as Error).message.slice(0, 200) }));
}

cli.runApp(
  new ServerOptions({
    agent: fileURLToPath(new URL('./agente.ts', import.meta.url)),
    agentName: config.tiempoReal.agente,
    wsURL: config.tiempoReal.urlInterna,
    apiKey: config.tiempoReal.apiKey,
    apiSecret: config.tiempoReal.apiSecret,
    // Pocas personas a la vez en el piloto: un proceso listo basta.
    numIdleProcesses: 1,
    host: '127.0.0.1',
    port: config.tiempoReal.puertoAgente,
  }),
);
