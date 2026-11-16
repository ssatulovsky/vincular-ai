import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { altaPersonaDePrueba } from '../src/administracion/altaPrueba.ts';
import { crearAplicacion, crearServidor, type Aplicacion } from '../src/api/servidor.ts';
import { hashToken } from '../src/seguridad/tokens.ts';
import { configDePrueba, pedir } from './escenario.ts';
import type { FastifyInstance } from 'fastify';

let app: Aplicacion;
let f: FastifyInstance;
beforeAll(async () => {
  app = crearAplicacion(configDePrueba());
  f = await crearServidor(app);
});
afterAll(async () => {
  await f?.close();
  await app?.bd.end();
});

describe('alta de persona de prueba por CLI', () => {
  it('el código entregado identifica a la tablet de esa persona en la API', async () => {
    const r = await altaPersonaDePrueba(app.bd, app.cifrador, { nombre: 'Elena Prueba', comuna: 'Puerto Montt', nombreDispositivo: 'Tablet de prueba' });
    const yo = await pedir(f, 'GET', '/api/yo', r.token);
    expect(yo.estado).toBe(200);
    expect(yo.datos).toMatchObject({ tipo: 'dispositivo', personaId: r.personaId });
  });

  it('guarda solo el hash del token y el nombre cifrado', async () => {
    const r = await altaPersonaDePrueba(app.bd, app.cifrador, { nombre: 'Juan Prueba', comuna: 'Osorno', nombreDispositivo: 'Tablet 2' });
    const d = await app.bd.query<{ token_hash: Buffer }>('SELECT token_hash FROM dispositivo WHERE id = $1', [r.dispositivoId]);
    expect(d.rows[0]!.token_hash.equals(hashToken(r.token))).toBe(true);
    expect(d.rows[0]!.token_hash.toString('utf8')).not.toContain(r.token);
    const p = await app.bd.query<{ nombre_cifrado: Buffer; estado: string }>('SELECT nombre_cifrado, estado FROM persona WHERE id = $1', [r.personaId]);
    expect(p.rows[0]!.nombre_cifrado.toString('utf8')).not.toContain('Juan');
    expect(app.cifrador.descifrar(p.rows[0]!.nombre_cifrado)).toBe('Juan Prueba');
    expect(p.rows[0]!.estado).toBe('onboarding');
  });

  it('deja registro en la auditoría', async () => {
    const r = await altaPersonaDePrueba(app.bd, app.cifrador, { nombre: 'Rosa Prueba', comuna: 'Ancud', nombreDispositivo: 'Tablet 3' });
    const a = await app.bd.query<{ accion: string }>('SELECT accion FROM registro_auditoria WHERE persona_id = $1 ORDER BY accion', [r.personaId]);
    expect(a.rows.map((x) => x.accion)).toEqual(['dispositivo.crear_prueba_cli', 'persona.crear_prueba_cli']);
  });

  it('rechaza datos vacíos sin crear nada', async () => {
    const antes = await app.bd.query<{ n: string }>('SELECT count(*) AS n FROM persona');
    await expect(altaPersonaDePrueba(app.bd, app.cifrador, { nombre: ' ', comuna: 'Ancud', nombreDispositivo: 'Tablet' })).rejects.toThrow(/nombre/);
    const despues = await app.bd.query<{ n: string }>('SELECT count(*) AS n FROM persona');
    expect(despues.rows[0]!.n).toBe(antes.rows[0]!.n);
  });
});
