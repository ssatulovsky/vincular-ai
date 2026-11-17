import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TokenVerifier } from 'livekit-server-sdk';
import { crearAplicacion, crearServidor } from '../src/api/servidor.ts';
import { configDePrueba, crearEscenario, pedir, type Escenario } from './escenario.ts';
import type { FastifyInstance } from 'fastify';
import type { Aplicacion } from '../src/api/servidor.ts';

const TR = {
  urlPublica: 'wss://livekit.vincular.ejemplo.cl',
  urlInterna: 'ws://127.0.0.1:7880',
  apiKey: 'APIprueba',
  apiSecret: 'secreto-de-prueba-de-al-menos-32-caracteres',
  agente: 'vincular-companero',
  modeloStt: 'scribe_v2_realtime',
  finTurno: { minS: 1.2, maxS: 4 },
  puertoAgente: 8081,
};

// Escenario sin tiempo real (configuración por defecto de las pruebas).
let e: Escenario;
// Un segundo servidor, con tiempo real, sobre la misma base.
let app: Aplicacion;
let f: FastifyInstance;
beforeAll(async () => {
  e = await crearEscenario();
  app = crearAplicacion(configDePrueba({ tiempoReal: TR }));
  f = await crearServidor(app);
});
afterAll(async () => {
  await f?.close();
  await app?.bd.end();
  await e?.cerrar();
});

describe('conversación en tiempo real', () => {
  it('sin LiveKit configurado: no está disponible y la sesión responde 503', async () => {
    expect((await pedir(e.f, 'GET', '/api/tiempo-real', e.tokens.dispositivo)).datos).toEqual({ disponible: false });
    expect((await pedir(e.f, 'POST', '/api/tiempo-real/sesion', e.tokens.dispositivo)).estado).toBe(503);
  });

  it('entrega un permiso firmado, corto, para una sala nueva, con la persona identificada y el agente despachado', async () => {
    expect((await pedir(f, 'GET', '/api/tiempo-real', e.tokens.dispositivo)).datos).toEqual({ disponible: true });
    const r = await pedir<{ url: string; token: string; sala: string }>(f, 'POST', '/api/tiempo-real/sesion', e.tokens.dispositivo);
    expect(r.estado).toBe(201);
    expect(r.datos.url).toBe(TR.urlPublica);
    const claims = await new TokenVerifier(TR.apiKey, TR.apiSecret).verify(r.datos.token);
    expect(claims.sub).toBe(`persona-${e.ids.persona}`);
    expect(claims.attributes).toMatchObject({ personaId: e.ids.persona });
    expect(claims.video).toMatchObject({ roomJoin: true, room: r.datos.sala, canPublish: true, canSubscribe: true });
    expect(claims.roomConfig?.agents?.[0]?.agentName).toBe(TR.agente);
    expect((claims.exp ?? 0) - (claims.nbf ?? claims.iat ?? 0)).toBeLessThanOrEqual(600);
    const otra = await pedir<{ sala: string }>(f, 'POST', '/api/tiempo-real/sesion', e.tokens.dispositivo);
    expect(otra.datos.sala).not.toBe(r.datos.sala);
  });

  it('solo la tablet de la persona puede abrir una sesión', async () => {
    for (const t of [e.tokens.supervisor, e.tokens.familiar, e.tokens.admin]) {
      expect((await pedir(f, 'POST', '/api/tiempo-real/sesion', t)).estado).toBe(403);
    }
    expect((await pedir(f, 'POST', '/api/tiempo-real/sesion')).estado).toBe(401);
  });

  it('la página de la tablet permite conectar solo a ese servidor de LiveKit y sirve el cliente localmente', async () => {
    const pag = await f.inject({ method: 'GET', url: '/tablet' });
    expect(pag.headers['content-security-policy']).toContain("connect-src 'self' ws: wss: wss://livekit.vincular.ejemplo.cl https://livekit.vincular.ejemplo.cl;");
    const cliente = await f.inject({ method: 'GET', url: '/vendor/livekit-client.js' });
    expect(cliente.statusCode).toBe(200);
    expect(cliente.body).toContain('LivekitClient');
  });
});
