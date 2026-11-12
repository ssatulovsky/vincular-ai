import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { abrirSesion } from '../src/conversacion/repositorio.ts';
import { costoDeSesion, costoUsd, costosDelMes, type TablaPrecios } from '../src/costos/costos.ts';
import { crearEscenario, pedir, type Escenario } from './escenario.ts';

let e: Escenario;
beforeAll(async () => {
  e = await crearEscenario();
});
afterAll(async () => e?.cerrar());

const precios: TablaPrecios = { verificadoEn: '2026-11-12', precios: { 'gemini/modelo-a': { entradaUsdPorMillon: 1, salidaUsdPorMillon: 4 } } };

describe('costos', () => {
  it('calcula el costo por millón de tokens y devuelve null sin precio', () => {
    expect(costoUsd(precios, 'gemini', 'modelo-a', 1_000_000, 500_000)).toBe(3);
    expect(costoUsd(precios, 'anthropic', 'otro', 10, 10)).toBeNull();
  });

  it('agrupa por persona y conversación dentro del mes en hora de Chile', async () => {
    const s1 = await abrirSesion(e.app.bd, e.ids.personaAjena, null, 'persona', 'texto');
    const s2 = await abrirSesion(e.app.bd, e.ids.personaAjena, null, 'persona', 'texto');
    const ins = (sesion: string, tarea: string, entrada: number, salida: number, cuando: string, modelo = 'modelo-a') =>
      e.owner.query(
        `INSERT INTO uso_modelo (persona_id, sesion_id, tarea, proveedor, modelo, tokens_entrada, tokens_salida, latencia_ms, ok, creado_en) VALUES ($1, $2, $3, 'gemini', $4, $5, $6, 100, true, $7)`,
        [e.ids.personaAjena, sesion, tarea, modelo, entrada, salida, cuando],
      );
    await ins(s1, 'conversacion', 1_000_000, 0, '2030-03-10T12:00:00-03:00');
    await ins(s1, 'guardian', 0, 250_000, '2030-03-10T12:00:01-03:00');
    await ins(s2, 'conversacion', 1_000_000, 0, '2030-03-31T23:30:00-03:00');
    // 1 de abril a las 00:30 en Chile: es abril aunque en UTC sea 31 de marzo.
    await ins(s2, 'conversacion', 5_000_000, 0, '2030-04-01T00:30:00-03:00');

    const r = await costosDelMes(e.app.bd, precios, '2030-03');
    const p = r.personas.find((x) => x.personaId === e.ids.personaAjena)!;
    expect(p.sesiones).toBe(2);
    expect(p.tokensEntrada).toBe(2_000_000);
    expect(p.usd).toBeCloseTo(3);
    expect(p.usdPorConversacion).toBeCloseTo(1.5);
    expect(p.porTarea.guardian?.usd).toBeCloseTo(1);

    expect((await costoDeSesion(e.app.bd, precios, s1)).usd).toBeCloseTo(2);

    await ins(s1, 'riesgo', 10, 10, '2030-03-11T12:00:00-03:00', 'sin-precio');
    const conFaltante = await costosDelMes(e.app.bd, precios, '2030-03');
    expect(conFaltante.total.usd).toBeNull();
    expect(conFaltante.total.modelosSinPrecio).toEqual(['gemini/sin-precio']);
  });

  it('solo el administrador consulta los costos', async () => {
    expect((await pedir(e.f, 'GET', '/api/costos?mes=2030-03', e.tokens.admin)).estado).toBe(200);
    expect((await pedir(e.f, 'GET', '/api/costos?mes=marzo', e.tokens.admin)).estado).toBe(400);
    for (const t of [e.tokens.supervisor, e.tokens.guardia, e.tokens.familiar, e.tokens.dispositivo]) {
      expect((await pedir(e.f, 'GET', '/api/costos?mes=2030-03', t)).estado).toBe(403);
    }
  });

  it('cada conversación registra su uso de modelos, aunque el proveedor falle', async () => {
    const { sesionId } = (await pedir<{ sesionId: string }>(e.f, 'POST', '/api/conversacion/sesiones', e.tokens.dispositivo, {})).datos;
    await pedir(e.f, 'POST', `/api/conversacion/sesiones/${sesionId}/turnos`, e.tokens.dispositivo, { texto: 'Buenas tardes' });
    const r = await pedir<{ llamadas: number; fallidas: number }>(e.f, 'GET', `/api/costos/sesiones/${sesionId}`, e.tokens.admin);
    expect(r.datos.llamadas).toBeGreaterThan(0);
    expect(r.datos.fallidas).toBe(r.datos.llamadas);
  });
});
