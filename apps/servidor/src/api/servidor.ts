import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import { ZodError } from 'zod';
import { ModelosPorTarea } from '@vincular/ia';
import type { Config } from '../config/config.ts';
import { crearPool, type Bd } from '../db/conexion.ts';
import { ErrorConversacion, Orquestador } from '../conversacion/orquestador.ts';
import { actorDesdeToken } from '../seguridad/autenticacion.ts';
import { Cifrador } from '../seguridad/cifrado.ts';
import { ErrorPermiso, type Actor } from '../seguridad/permisos.ts';
import { rutasAdministracion } from './rutas/administracion.ts';
import { rutasAutenticacion } from './rutas/autenticacion.ts';
import { rutasClinicas } from './rutas/clinicas.ts';
import { rutasConversacion } from './rutas/conversacion.ts';
import { rutasMemoria } from './rutas/memoria.ts';
import { rutasCostos } from './rutas/costos.ts';
import { cargarPrecios, type TablaPrecios } from '../costos/costos.ts';
import { rutasVoz } from './rutas/voz.ts';
import { rutasMedicacion } from './rutas/medicacion.ts';
import { TabletsConectadas } from '../tablets.ts';
import { rutasTablet } from './rutas/tablet.ts';
import { readFileSync } from 'node:fs';
import { ServiciosVoz, validarCatalogo, type CatalogoVoces } from '@vincular/voz';

export interface Aplicacion {
  config: Config;
  bd: Bd;
  cifrador: Cifrador;
  modelos: ModelosPorTarea;
  orquestador: Orquestador;
  precios: TablaPrecios;
  voz: ServiciosVoz;
  catalogoVoces: CatalogoVoces;
  tablets: TabletsConectadas;
  /** Extracciones de memoria en curso (para esperar al cerrar y en pruebas). */
  tareasPendientes: Set<Promise<unknown>>;
}

declare module 'fastify' {
  interface FastifyRequest {
    actor: Actor | null;
  }
}

export class ErrorHttp extends Error {
  constructor(
    readonly estado: number,
    mensaje: string,
  ) {
    super(mensaje);
  }
}

export function exigirActor(req: FastifyRequest): Actor {
  if (!req.actor) throw new ErrorHttp(401, 'Debe iniciar sesión');
  return req.actor;
}

export function tokenDe(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  return h?.startsWith('Bearer ') ? h.slice(7).trim() || null : null;
}

export function crearAplicacion(config: Config, bd: Bd = crearPool(config.databaseUrl)): Aplicacion {
  const cifrador = new Cifrador(config.claveCifrado);
  const modelos = new ModelosPorTarea(config.ia);
  const orquestador = new Orquestador({ bd, cifrador, modelos, emergencia: config.emergencia, esperaClasificadorMs: config.esperaClasificadorMs });
  const voz = new ServiciosVoz(config.voz.servicios);
  const catalogoVoces = validarCatalogo(JSON.parse(readFileSync(config.voz.catalogo, 'utf8')));
  return {
    config,
    bd,
    cifrador,
    modelos,
    orquestador,
    precios: cargarPrecios(config.rutaPrecios),
    voz,
    catalogoVoces,
    tablets: new TabletsConectadas({ bd, voz, catalogo: catalogoVoces, emergencia: config.emergencia }),
    tareasPendientes: new Set(),
  };
}

export async function crearServidor(app: Aplicacion): Promise<FastifyInstance> {
  const f = Fastify({
    logger: app.config.entorno === 'test' ? false : { level: 'info', redact: ['req.headers.authorization'] },
    bodyLimit: 64 * 1024,
    trustProxy: app.config.entorno === 'production',
  });

  await f.register(rateLimit, { global: false });
  // El audio de un turno (hasta ~60 s de opus) viaja en base64 por el WebSocket.
  await f.register(websocket, { options: { maxPayload: 3 * 1024 * 1024 } });

  f.decorateRequest('actor', null);
  f.addHook('onRequest', async (req) => {
    const token = tokenDe(req);
    req.actor = token ? await actorDesdeToken(app.bd, token) : null;
  });

  f.setErrorHandler((error, req, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({ error: 'Datos inválidos', detalle: error.issues.map((i) => ({ campo: i.path.join('.'), mensaje: i.message })) });
    }
    if (error instanceof ErrorPermiso || error instanceof ErrorHttp || error instanceof ErrorConversacion) {
      return reply.code(error.estado).send({ error: error.message });
    }
    const e = error as { estado?: number; statusCode?: number; message: string };
    if (typeof e.estado === 'number' && e.estado < 500) return reply.code(e.estado).send({ error: e.message });
    if (typeof e.statusCode === 'number' && e.statusCode < 500) return reply.code(e.statusCode).send({ error: e.message });
    req.log.error({ err: error }, 'error no controlado');
    return reply.code(500).send({ error: 'Error interno' });
  });

  f.get('/api/salud', async () => ({ ok: true }));

  await f.register(rutasAutenticacion(app));
  await f.register(rutasAdministracion(app));
  await f.register(rutasClinicas(app));
  await f.register(rutasConversacion(app));
  await f.register(rutasMemoria(app));
  await f.register(rutasCostos(app));
  await f.register(rutasVoz(app));
  await f.register(rutasMedicacion(app));
  await f.register(rutasTablet(app));
  return f;
}

/** Lanza una tarea en segundo plano sin bloquear la respuesta; los errores quedan en el registro. */
export function enSegundoPlano(app: Aplicacion, nombre: string, fn: () => Promise<unknown>): void {
  const p = fn()
    .catch((e: Error) => console.error(`[${nombre}] ${e.message}`))
    .finally(() => app.tareasPendientes.delete(p));
  app.tareasPendientes.add(p);
}
