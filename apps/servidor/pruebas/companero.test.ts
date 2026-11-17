import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { descripcionRetrato } from '../src/companero/avatares.ts';
import { construirInstrucciones } from '../src/conversacion/instrucciones.ts';
import { PERFIL_POR_DEFECTO } from '../src/conversacion/perfil.ts';
import { crearEscenario, pedir, type Escenario } from './escenario.ts';

/**
 * Diseño del compañero. El modelo de imágenes apunta a un puerto cerrado (sin simulaciones): se
 * prueban permisos, límites, registros y la elección del avatar con retratos insertados en la base.
 */
let e: Escenario;
beforeAll(async () => {
  e = await crearEscenario();
});
afterAll(async () => e?.cerrar());

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4b30000000049454e44ae426082', 'hex');

async function insertarRetrato(personaId: string, ronda = randomUUID()): Promise<string> {
  const r = await e.owner.query<{ id: string }>(
    `INSERT INTO avatar_propuesta (persona_id, ronda, genero, edad, entorno, imagen, mime, modelo, creado_por)
     VALUES ($1, $2, 'femenina', 'adulta', 'cocina', $3, 'image/png', 'modelo-de-prueba', 'persona') RETURNING id`,
    [personaId, ronda, PNG],
  );
  return r.rows[0]!.id;
}

const pedido = { genero: 'femenina', edad: 'adulta', entorno: 'jardin' };

describe('descripción de los retratos', () => {
  it('pide una persona ficticia que no se parezca a nadie real, sin texto, y varía entre propuestas', () => {
    const d = [0, 1, 2].map((i) => descripcionRetrato({ genero: 'masculina', edad: 'mayor', entorno: 'living' }, i));
    for (const x of d) {
      expect(x).toMatch(/ficticio/);
      expect(x).toMatch(/no debe parecerse a ninguna persona real ni famosa/);
      expect(x).toMatch(/Sin texto/);
      expect(x).toMatch(/hombre chileno/);
      expect(x).toMatch(/70 años/);
    }
    expect(new Set(d).size).toBe(3);
  });
});

describe('generar retratos', () => {
  it('si el modelo no responde: 503, no guarda imágenes y registra el intento como uso fallido', async () => {
    const r = await pedir(e.f, 'POST', '/api/mi-companero/avatares', e.tokens.dispositivo, pedido);
    expect(r.estado).toBe(503);
    const n = await e.owner.query('SELECT count(*)::int AS n FROM avatar_propuesta WHERE persona_id = $1', [e.ids.persona]);
    expect(n.rows[0].n).toBe(0);
    const uso = await e.owner.query("SELECT ok FROM uso_modelo WHERE persona_id = $1 AND tarea = 'imagenes'", [e.ids.persona]);
    expect(uso.rows.length).toBe(3);
    expect(uso.rows.every((x) => x.ok === false)).toBe(true);
  });

  it('valida el pedido', async () => {
    expect((await pedir(e.f, 'POST', '/api/mi-companero/avatares', e.tokens.dispositivo, { ...pedido, entorno: 'playa' })).estado).toBe(400);
    expect((await pedir(e.f, 'POST', '/api/mi-companero/avatares', e.tokens.dispositivo, { ...pedido, genero: 'otro' })).estado).toBe(400);
  });

  it('respeta el límite diario de grupos de retratos', async () => {
    const persona = e.ids.personaAjena;
    await insertarRetrato(persona);
    await insertarRetrato(persona);
    const r = await pedir<{ error: string }>(e.f, 'POST', '/api/mi-companero/avatares', e.tokens.dispositivoAjeno, pedido);
    expect(r.estado).toBe(429);
    expect(r.datos.error).toMatch(/Por hoy/);
  });

  it('solo la persona desde su tablet o el equipo asignado pueden crear retratos', async () => {
    expect((await pedir(e.f, 'POST', '/api/mi-companero/avatares', e.tokens.supervisor, pedido)).estado).toBe(403);
    expect((await pedir(e.f, 'POST', `/api/personas/${e.ids.persona}/companero/avatares`, e.tokens.dispositivo, pedido)).estado).toBe(403);
    expect((await pedir(e.f, 'POST', `/api/personas/${e.ids.persona}/companero/avatares`, e.tokens.familiar, pedido)).estado).toBe(403);
    expect((await pedir(e.f, 'POST', `/api/personas/${e.ids.persona}/companero/avatares`, e.tokens.supervisorAjeno, pedido)).estado).toBe(403);
    // El supervisor asignado sí puede (el modelo está caído: 503, no 403).
    expect((await pedir(e.f, 'POST', `/api/personas/${e.ids.persona}/companero/avatares`, e.tokens.supervisor, pedido)).estado).toBe(503);
  });
});

describe('ver y elegir retratos', () => {
  it('cada persona ve solo sus retratos; el equipo asignado también', async () => {
    const id = await insertarRetrato(e.ids.persona);
    const propio = await e.f.inject({ method: 'GET', url: `/api/mi-companero/avatares/${id}/imagen`, headers: { authorization: `Bearer ${e.tokens.dispositivo}` } });
    expect(propio.statusCode).toBe(200);
    expect(propio.headers['content-type']).toBe('image/png');
    expect(propio.rawPayload.equals(PNG)).toBe(true);

    expect((await pedir(e.f, 'GET', `/api/mi-companero/avatares/${id}/imagen`, e.tokens.dispositivoAjeno)).estado).toBe(404);
    expect((await pedir(e.f, 'GET', `/api/mi-companero/avatares/no-es-uuid/imagen`, e.tokens.dispositivo)).estado).toBe(404);
    const equipo = await e.f.inject({ method: 'GET', url: `/api/personas/${e.ids.persona}/companero/avatares/${id}/imagen`, headers: { authorization: `Bearer ${e.tokens.supervisor}` } });
    expect(equipo.statusCode).toBe(200);
    expect((await pedir(e.f, 'GET', `/api/personas/${e.ids.persona}/companero/avatares/${id}/imagen`, e.tokens.supervisorAjeno)).estado).toBe(403);
    expect((await pedir(e.f, 'GET', `/api/personas/${e.ids.persona}/companero/avatares/${id}/imagen`, e.tokens.familiar)).estado).toBe(403);
  });

  it('el perfil guarda género, edad y un avatar propio; rechaza retratos ajenos o inexistentes', async () => {
    const propio = await insertarRetrato(e.ids.persona);
    const ajeno = await insertarRetrato(e.ids.personaAjena);
    const base = { nombre: 'Silvana', personalidad: 'Cálida y serena', trato: 'usted', voz_id: 'el-silvana', genero: 'femenina', edad_aparente: 'adulta' };
    expect((await pedir(e.f, 'PUT', '/api/mi-perfil-companero', e.tokens.dispositivo, { ...base, avatar_id: ajeno })).estado).toBe(400);
    expect((await pedir(e.f, 'PUT', '/api/mi-perfil-companero', e.tokens.dispositivo, { ...base, avatar_id: randomUUID() })).estado).toBe(400);
    expect((await pedir(e.f, 'PUT', '/api/mi-perfil-companero', e.tokens.dispositivo, { ...base, avatar_id: propio })).estado).toBe(200);
    const r = await pedir<{ perfil: Record<string, unknown> }>(e.f, 'GET', `/api/personas/${e.ids.persona}/perfil-companero`, e.tokens.supervisor);
    expect(r.datos.perfil).toMatchObject({ avatar_id: propio, genero: 'femenina', edad_aparente: 'adulta', voz_id: 'el-silvana' });
    // El equipo tampoco puede asignar un retrato de otra persona.
    expect((await pedir(e.f, 'PUT', `/api/personas/${e.ids.persona}/perfil-companero`, e.tokens.supervisor, { ...base, avatar_id: ajeno })).estado).toBe(400);
    expect((await pedir(e.f, 'GET', `/api/personas/${e.ids.persona}/perfil-companero`, e.tokens.supervisorAjeno)).estado).toBe(403);
  });

  it('la muestra de voz para el equipo exige estar asignado', async () => {
    expect((await pedir(e.f, 'GET', `/api/personas/${e.ids.persona}/voces/el-silvana/muestra`, e.tokens.supervisorAjeno)).estado).toBe(403);
    expect((await pedir(e.f, 'GET', `/api/personas/${e.ids.persona}/voces/el-silvana/muestra`, e.tokens.dispositivo)).estado).toBe(403);
    // Asignado: la voz está caída en las pruebas → 503.
    expect((await pedir(e.f, 'GET', `/api/personas/${e.ids.persona}/voces/el-silvana/muestra`, e.tokens.supervisor)).estado).toBe(503);
  });
});

describe('instrucciones del compañero', () => {
  const base = {
    nombrePersona: 'Rosa',
    preferencias: [],
    hechos: [],
    porConfirmar: [],
    episodios: [],
    nivelRiesgo: 0 as const,
    categoriasRiesgo: [],
    modoEmergencia: false,
    ahora: new Date('2026-11-17T15:00:00Z'),
    plan: null,
  };
  it('el compañero habla en el género elegido y su edad aparente no le da una vida humana', () => {
    const t = construirInstrucciones({ ...base, perfil: { ...PERFIL_POR_DEFECTO, nombre: 'Silvana', genero: 'femenina', edad_aparente: 'adulta' } });
    expect(t).toContain('Te presentas en femenino');
    expect(t).toMatch(/no tienes historia, familia ni recuerdos propios/);
    const sin = construirInstrucciones({ ...base, perfil: PERFIL_POR_DEFECTO });
    expect(sin).not.toContain('Te presentas en');
  });
});

describe('personas del equipo', () => {
  it('el equipo ve solo sus personas asignadas; el administrador, todas; la tablet y la familia, nada', async () => {
    const sup = await pedir<{ personas: Array<{ id: string; nombre: string }> }>(e.f, 'GET', '/api/mis-personas', e.tokens.supervisor);
    expect(sup.estado).toBe(200);
    expect(sup.datos.personas.map((p) => p.id)).toEqual([e.ids.persona]);
    expect(sup.datos.personas[0]!.nombre).toBe('Rosa Elena Muñoz');
    const adm = await pedir<{ personas: Array<{ id: string }> }>(e.f, 'GET', '/api/mis-personas', e.tokens.admin);
    expect(adm.datos.personas.map((p) => p.id)).toEqual(expect.arrayContaining([e.ids.persona, e.ids.personaAjena]));
    expect((await pedir(e.f, 'GET', '/api/mis-personas', e.tokens.dispositivo)).estado).toBe(403);
    expect((await pedir(e.f, 'GET', '/api/mis-personas', e.tokens.familiar)).estado).toBe(403);
  });
});

describe('lista de retratos', () => {
  it('cada uno ve los retratos de su persona y cuántos grupos quedan hoy', async () => {
    const id = await insertarRetrato(e.ids.persona);
    const r = await pedir<{ retratos: Array<{ id: string }>; rondasRestantesHoy: number }>(e.f, 'GET', '/api/mi-companero/avatares', e.tokens.dispositivo);
    expect(r.datos.retratos[0]!.id).toBe(id);
    expect(r.datos.rondasRestantesHoy).toBeGreaterThanOrEqual(0);
    const ajena = await pedir<{ retratos: Array<{ id: string }> }>(e.f, 'GET', '/api/mi-companero/avatares', e.tokens.dispositivoAjeno);
    expect(ajena.datos.retratos.map((x) => x.id)).not.toContain(id);
    expect((await pedir(e.f, 'GET', `/api/personas/${e.ids.persona}/companero/avatares`, e.tokens.supervisor)).estado).toBe(200);
    expect((await pedir(e.f, 'GET', `/api/personas/${e.ids.persona}/companero/avatares`, e.tokens.supervisorAjeno)).estado).toBe(403);
  });
});
