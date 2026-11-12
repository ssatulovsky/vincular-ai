import { cargarConfig } from './config/config.ts';
import { crearAplicacion, crearServidor } from './api/servidor.ts';

const config = cargarConfig();
if (!config.emergencia.verificados) {
  console.warn('[aviso] Los números de emergencia de config/protocolo-emergencia.json no están verificados. No usar con personas reales.');
}
if (config.tareasSinModelo.length) {
  console.warn(`[aviso] Tareas sin modelo configurado: ${config.tareasSinModelo.join(', ')}. Sin modelo de conversación o de guardián, la persona recibe solo respuestas seguras.`);
}
const app = crearAplicacion(config);
const servidor = await crearServidor(app);
await servidor.listen({ port: config.puerto, host: config.host });

for (const senal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(senal, () => {
    void servidor.close().then(() => app.bd.end()).then(() => process.exit(0));
  });
}
