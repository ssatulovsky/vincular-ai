import { randomBytes } from 'node:crypto';
import { inject } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Tarea } from '@vincular/ia';
import { crearAplicacion, crearServidor, type Aplicacion } from '../src/api/servidor.ts';
import type { Config } from '../src/config/config.ts';
import { crearPool } from '../src/db/conexion.ts';
import { hashContrasena } from '../src/seguridad/autenticacion.ts';

export const CONTRASENA = 'contrasena-de-prueba-123';
export const CONTACTOS = { samu: '131', prevencionSuicidio: '*4141' };

/**
 * Configuración de prueba. Los modelos apuntan a un puerto local cerrado (127.0.0.1:9): la
 * conexión falla de verdad, sin simular respuestas. Así se prueban los caminos que NO dependen
 * del modelo (reglas, protocolo de emergencia, respuestas seguras, permisos y registros).
 * Las pruebas contra el proveedor real están en paquetes/ia y en `npm run riesgo:evaluar`.
 */
export function configDePrueba(extra: Partial<Config> = {}): Config {
  const tareas = Object.fromEntries(
    (['conversacion', 'guardian', 'riesgo', 'extraccion', 'informes', 'embeddings'] as Tarea[]).map((t) => [t, { proveedor: 'gemini', modelo: 'modelo-inalcanzable', timeoutMs: 1500 }]),
  ) as Config['ia']['tareas'];
  return {
    entorno: 'test',
    puerto: 0,
    host: '127.0.0.1',
    databaseUrl: inject('urlApp'),
    claveCifrado: Buffer.alloc(32, 7),
    ia: { claves: { gemini: 'clave-de-prueba', anthropic: 'clave-de-prueba' }, urls: { gemini: 'http://127.0.0.1:9', anthropic: 'http://127.0.0.1:9' }, tareas },
    tareasSinModelo: [],
    esperaClasificadorMs: 2000,
    sesionAccesoHoras: 12,
    emergencia: { ...CONTACTOS, verificados: false },
    rutaPrecios: new URL('../../../config/precios-modelos.json', import.meta.url).pathname,
    memoriaMinutosInactividad: 30,
    medicacion: { segundoAvisoMin: 30, sinRespuestaMin: 30, vencimientoMin: 60 },
    planificador: false,
    // Twilio apunta a un puerto cerrado: los envíos fallan de verdad y la cadena avanza.
    escalamiento: {
      twilio: { accountSid: 'AC-prueba', authToken: 'token-de-prueba', origen: '+15005550006', url: 'http://127.0.0.1:9', timeoutMs: 1500 },
      urlPublica: 'https://vincular.ejemplo.cl',
      voz: { idioma: 'es-MX' },
      emergenciaSinRespuestaMin: 10,
    },
    // Proveedores de voz inalcanzables (puerto cerrado): se prueban los caminos sin voz.
    voz: {
      catalogo: new URL('../../../config/voz/voces.json', import.meta.url).pathname,
      umbralConfianza: 0.5,
      servicios: {
        google: { claveApi: 'clave-de-prueba', proyecto: 'proyecto-prueba' },
        elevenlabs: { apiKey: 'clave-de-prueba' },
        reconocimiento: { proveedor: 'elevenlabs', idioma: 'es' },
        timeoutMs: 1500,
        urls: { googleTts: 'http://127.0.0.1:9', googleStt: 'http://127.0.0.1:9', elevenlabs: 'http://127.0.0.1:9' },
      },
    },
    ...extra,
  };
}

export interface Escenario {
  app: Aplicacion;
  f: FastifyInstance;
  owner: ReturnType<typeof crearPool>;
  tokens: { admin: string; supervisor: string; enfermera: string; supervisorAjeno: string; guardia: string; familiar: string; dispositivo: string; dispositivoAjeno: string };
  ids: { persona: string; personaAjena: string; supervisor: string; enfermera: string; contacto: string };
  cerrar(): Promise<void>;
}

export function correo(prefijo: string): string {
  return `${prefijo}.${randomBytes(4).toString('hex')}@prueba.cl`;
}

export async function pedir<T = Record<string, unknown>>(
  f: FastifyInstance,
  metodo: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  token?: string,
  cuerpo?: unknown,
): Promise<{ estado: number; datos: T }> {
  const r = await f.inject({
    method: metodo,
    url,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    ...(cuerpo === undefined ? {} : { payload: cuerpo as Record<string, unknown> }),
  });
  return { estado: r.statusCode, datos: (r.body ? JSON.parse(r.body) : {}) as T };
}

/** Arma un piloto mínimo: un admin, profesionales, una persona con su tablet y un familiar. */
export async function crearEscenario(): Promise<Escenario> {
  const app = crearAplicacion(configDePrueba());
  const f = await crearServidor(app);
  const owner = crearPool(inject('urlOwner'));

  // La primera cuenta de administrador se crea fuera de la API (como en la CLI).
  const emailAdmin = correo('admin');
  await app.bd.query(`INSERT INTO cuenta (tipo, email, nombre, hash_contrasena, rol) VALUES ('personal', $1, 'Admin', $2, 'admin_plataforma')`, [emailAdmin, await hashContrasena(CONTRASENA)]);
  const ingresar = async (email: string) => (await pedir<{ token: string }>(f, 'POST', '/api/auth/ingresar', undefined, { email, contrasena: CONTRASENA })).datos.token;
  const admin = await ingresar(emailAdmin);

  const crearCuenta = async (rol: string) => {
    const email = correo(rol);
    const r = await pedir<{ id: string }>(f, 'POST', '/api/cuentas', admin, { tipo: 'personal', email, nombre: `Prof ${rol}`, contrasena: CONTRASENA, rol });
    return { id: r.datos.id, token: await ingresar(email) };
  };
  const supervisor = await crearCuenta('supervisor_clinico');
  const supervisorAjeno = await crearCuenta('supervisor_clinico');
  const enfermera = await crearCuenta('enfermera_enlace');
  const guardia = await crearCuenta('guardia');

  const persona = (await pedir<{ id: string }>(f, 'POST', '/api/personas', admin, { nombre: 'Rosa Elena Muñoz', comuna: 'Puerto Varas', fechaNacimiento: '1944-03-02' })).datos.id;
  const personaAjena = (await pedir<{ id: string }>(f, 'POST', '/api/personas', admin, { nombre: 'Luis Soto', comuna: 'Puerto Varas' })).datos.id;
  for (const c of [supervisor, enfermera]) await pedir(f, 'POST', `/api/personas/${persona}/asignaciones`, admin, { cuentaId: c.id });
  await pedir(f, 'POST', `/api/personas/${personaAjena}/asignaciones`, admin, { cuentaId: supervisorAjeno.id });

  const contacto = (await pedir<{ id: string }>(f, 'POST', `/api/personas/${persona}/contactos`, admin, { nombre: 'Camila Muñoz', relacion: 'hija', telefono: '+56911112222', esCuidador: true, permisos: { resumen_bienestar: true } })).datos.id;
  const emailFamiliar = correo('familiar');
  await pedir(f, 'POST', '/api/cuentas', admin, { tipo: 'familiar', email: emailFamiliar, nombre: 'Camila', contrasena: CONTRASENA, contactoId: contacto });

  const dispositivo = (await pedir<{ token: string }>(f, 'POST', `/api/personas/${persona}/dispositivos`, admin, { nombre: 'Tablet Rosa' })).datos.token;
  const dispositivoAjeno = (await pedir<{ token: string }>(f, 'POST', `/api/personas/${personaAjena}/dispositivos`, admin, { nombre: 'Tablet Luis' })).datos.token;

  return {
    app,
    f,
    owner,
    tokens: { admin, supervisor: supervisor.token, enfermera: enfermera.token, supervisorAjeno: supervisorAjeno.token, guardia: guardia.token, familiar: await ingresar(emailFamiliar), dispositivo, dispositivoAjeno },
    ids: { persona, personaAjena, supervisor: supervisor.id, enfermera: enfermera.id, contacto },
    async cerrar() {
      await Promise.allSettled([...app.tareasPendientes]);
      await f.close();
      await app.bd.end();
      await owner.end();
    },
  };
}
