import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { CRITERIOS_NEGATIVOS, crearEscenario, pedir, type Escenario } from './escenario.ts';
import { decidirPermiso, type Actor } from '../src/seguridad/permisos.ts';
import { huecosGuardia } from '../src/administracion/preparacion.ts';

/**
 * Decisión 0018: nadie conversa sin consentimiento vigente y evaluación clínica de ingreso, salvo
 * que haya una emergencia en curso. Rol de psiquiatra. Exportación y supresión (Ley 21.719).
 */

let e: Escenario;
const CONTRASENA = 'contrasena-de-prueba-123';
let psiquiatra: { id: string; token: string };

beforeAll(async () => {
  e = await crearEscenario();
  const email = `psiq-${Date.now()}@prueba.cl`;
  const r = await pedir<{ id: string }>(e.f, 'POST', '/api/cuentas', e.tokens.admin, { tipo: 'personal', email, nombre: 'Dra. Psiquiatra', contrasena: CONTRASENA, rol: 'psiquiatra' });
  expect(r.estado).toBe(201);
  const t = await pedir<{ token: string }>(e.f, 'POST', '/api/auth/ingresar', undefined, { email, contrasena: CONTRASENA });
  psiquiatra = { id: r.datos.id, token: t.datos.token };
});
afterAll(async () => e?.cerrar());

/** Persona nueva con tablet, asignada a la psiquiatra, sin consentimiento ni evaluación. */
async function personaNueva(nombre = 'Ana Pérez'): Promise<{ id: string; tablet: string }> {
  const id = (await pedir<{ id: string }>(e.f, 'POST', '/api/personas', e.tokens.admin, { nombre, comuna: 'Puerto Varas' })).datos.id;
  await pedir(e.f, 'POST', `/api/personas/${id}/asignaciones`, e.tokens.admin, { cuentaId: psiquiatra.id });
  const tablet = (await pedir<{ token: string }>(e.f, 'POST', `/api/personas/${id}/dispositivos`, e.tokens.admin, { nombre: 'Tablet' })).datos.token;
  return { id, tablet };
}
const abrirSesion = (tablet: string) => pedir<{ codigo?: string; faltan?: string[]; error?: string; sesionId?: string }>(e.f, 'POST', '/api/conversacion/sesiones', tablet, { canal: 'texto' });
const consentir = (id: string) => pedir(e.f, 'POST', `/api/personas/${id}/consentimientos`, e.tokens.admin, { tipo: 'participacion_y_datos', version: '1.0', otorgadoPor: 'persona' });
const evaluar = (id: string, cuerpo: Record<string, unknown>, token = psiquiatra.token) => pedir<{ id?: string; detalle?: Array<{ mensaje: string }> }>(e.f, 'POST', `/api/personas/${id}/evaluaciones`, token, cuerpo);

describe('requisitos para conversar', () => {
  it('sin consentimiento ni evaluación, la tablet no abre la conversación y recibe un mensaje tranquilo con números de emergencia', async () => {
    const p = await personaNueva();
    const r = await abrirSesion(p.tablet);
    expect(r.estado).toBe(409);
    expect(r.datos.codigo).toBe('requisitos_pendientes');
    expect(r.datos.faltan).toEqual(['consentimiento', 'evaluacion']);
    expect(r.datos.error).toMatch(/131/);
    // Tampoco por tiempo real.
    expect((await pedir(e.f, 'POST', '/api/tiempo-real/sesion', p.tablet)).estado).toBe(409);
    // Queda en la auditoría.
    const a = await e.owner.query(`SELECT detalle FROM registro_auditoria WHERE accion = 'conversacion.bloqueada_requisitos' AND persona_id = $1`, [p.id]);
    expect(a.rowCount).toBeGreaterThan(0);
  });

  it('con consentimiento y evaluación apta, conversa; el panel ve qué falta en cada paso', async () => {
    const p = await personaNueva();
    const faltan = async () => (await pedir<{ faltan: string[] }>(e.f, 'GET', `/api/personas/${p.id}/requisitos`, e.tokens.admin)).datos.faltan;
    expect(await faltan()).toEqual(['consentimiento', 'evaluacion']);
    await consentir(p.id);
    expect(await faltan()).toEqual(['evaluacion']);
    expect((await evaluar(p.id, { resultado: 'apto', criterios: CRITERIOS_NEGATIVOS })).estado).toBe(201);
    expect(await faltan()).toEqual([]);
    expect((await abrirSesion(p.tablet)).estado).toBe(201);
  });

  it('una evaluación "no apto", vencida o un consentimiento revocado vuelven a bloquear', async () => {
    const p = await personaNueva();
    await consentir(p.id);
    await evaluar(p.id, { resultado: 'no_apto', criterios: { ...CRITERIOS_NEGATIVOS, psicosis_activa: true } });
    expect((await abrirSesion(p.tablet)).datos.faltan).toEqual(['evaluacion']);
    await evaluar(p.id, { resultado: 'apto', criterios: CRITERIOS_NEGATIVOS, revisarAntesDe: '2020-01-01' });
    expect((await abrirSesion(p.tablet)).datos.faltan).toEqual(['evaluacion']);
    await evaluar(p.id, { resultado: 'apto', criterios: CRITERIOS_NEGATIVOS });
    expect((await abrirSesion(p.tablet)).estado).toBe(201);
    const k = await e.owner.query<{ id: string }>('SELECT id FROM consentimiento WHERE persona_id = $1', [p.id]);
    await pedir(e.f, 'POST', `/api/personas/${p.id}/consentimientos/${k.rows[0]!.id}/revocar`, e.tokens.admin);
    expect((await abrirSesion(p.tablet)).datos.faltan).toEqual(['consentimiento']);
  });

  it('una persona pausada no conversa', async () => {
    const p = await personaNueva();
    await consentir(p.id);
    await evaluar(p.id, { resultado: 'apto', criterios: CRITERIOS_NEGATIVOS });
    await e.owner.query(`UPDATE persona SET estado = 'pausada' WHERE id = $1`, [p.id]);
    const r = await abrirSesion(p.tablet);
    expect(r.datos.faltan).toEqual(['estado']);
    expect(r.datos.error).toMatch(/pausa/);
  });

  it('con una emergencia en curso sin acuse, el compañero nunca se bloquea', async () => {
    const p = await personaNueva();
    await e.owner.query(
      `INSERT INTO evento_riesgo (persona_id, nivel, nivel_reglas, fuente, categorias, fragmento_cifrado, accion, acuse_requerido) VALUES ($1, 3, 3, 'reglas', '{ideacion_suicida}', $2, 'escalar', true)`,
      [p.id, e.app.cifrador.cifrar('fragmento de prueba')],
    );
    const r = await abrirSesion(p.tablet);
    expect(r.estado).toBe(201);
  });
});

describe('tablet bloqueada por requisitos', () => {
  it('no conversa, pero sigue conectada y recibe los recordatorios de medicación', async () => {
    const p = await personaNueva();
    await e.f.listen({ port: 0, host: '127.0.0.1' });
    const ws = new WebSocket(`ws://127.0.0.1:${(e.f.server.address() as { port: number }).port}/api/conversacion/ws`);
    const recibidos: Array<Record<string, unknown>> = [];
    ws.on('message', (m) => recibidos.push(JSON.parse(m.toString())));
    await new Promise((r) => ws.once('open', r));
    ws.send(JSON.stringify({ tipo: 'autenticar', token: p.tablet }));
    while (!recibidos.some((m) => m.tipo === 'bloqueada')) await new Promise((r) => setTimeout(r, 20));
    expect(recibidos.find((m) => m.tipo === 'bloqueada')).toMatchObject({ codigo: 'requisitos_pendientes', faltan: ['consentimiento', 'evaluacion'] });
    // Un intento de conversar recibe el mismo aviso, sin procesar el texto.
    ws.send(JSON.stringify({ tipo: 'turno', texto: 'hola' }));
    await new Promise((r) => setTimeout(r, 100));
    expect(recibidos.filter((m) => m.tipo === 'bloqueada')).toHaveLength(2);
    expect(recibidos.some((m) => m.tipo === 'respuesta')).toBe(false);
    // El recordatorio de medicación llega igual.
    expect(await e.app.tablets.entregar({ personaId: p.id, programadaEn: new Date(), eventoIds: [], texto: 'Ana, es la hora de su remedio.', segundoAviso: false })).toBe(true);
    while (!recibidos.some((m) => m.tipo === 'recordatorio_dosis')) await new Promise((r) => setTimeout(r, 20));
    ws.close();
  });
});

describe('evaluación clínica de ingreso', () => {
  it('con un criterio de exclusión presente no se puede marcar "apto"; con resguardos exige indicaciones', async () => {
    const p = await personaNueva();
    const conCriterio = { ...CRITERIOS_NEGATIVOS, demencia_moderada_severa: true };
    const r1 = await evaluar(p.id, { resultado: 'apto', criterios: conCriterio });
    expect(r1.estado).toBe(400);
    expect(r1.datos.detalle?.[0]?.mensaje).toMatch(/resguardos/);
    expect((await evaluar(p.id, { resultado: 'apto_con_resguardos', criterios: conCriterio, notas: 'corta' })).estado).toBe(400);
    expect((await evaluar(p.id, { resultado: 'apto_con_resguardos', criterios: conCriterio, notas: 'Sesiones acompañadas por su hija la primera semana.' })).estado).toBe(201);
  });

  it('deben venir revisados todos los criterios', async () => {
    const p = await personaNueva();
    expect((await evaluar(p.id, { resultado: 'apto', criterios: { psicosis_activa: false } })).estado).toBe(400);
  });

  it('las notas se guardan cifradas y la evaluación queda auditada', async () => {
    const p = await personaNueva();
    await evaluar(p.id, { resultado: 'apto_con_resguardos', criterios: { ...CRITERIOS_NEGATIVOS, sin_red_de_apoyo: true }, notas: 'Activar red comunitaria antes del primer mes.' });
    const fila = await e.owner.query<{ notas_cifradas: Buffer }>('SELECT notas_cifradas FROM evaluacion_ingreso WHERE persona_id = $1', [p.id]);
    expect(fila.rows[0]!.notas_cifradas.toString('utf8')).not.toContain('Activar red');
    const lista = await pedir<{ evaluaciones: Array<{ notas: string; autor: string; rol: string }> }>(e.f, 'GET', `/api/personas/${p.id}/evaluaciones`, psiquiatra.token);
    expect(lista.datos.evaluaciones[0]).toMatchObject({ notas: 'Activar red comunitaria antes del primer mes.', autor: 'Dra. Psiquiatra', rol: 'psiquiatra' });
    const a = await e.owner.query<{ detalle: { criteriosPresentes: string[] } }>(`SELECT detalle FROM registro_auditoria WHERE accion = 'evaluacion_ingreso.registrar' AND persona_id = $1`, [p.id]);
    expect(a.rows[0]!.detalle.criteriosPresentes).toEqual(['sin_red_de_apoyo']);
  });

  it('solo la psiquiatría o el psicólogo supervisor asignados la registran; la administración no ve su contenido', async () => {
    const p = await personaNueva();
    expect((await evaluar(p.id, { resultado: 'apto', criterios: CRITERIOS_NEGATIVOS }, e.tokens.enfermera)).estado).toBe(403);
    expect((await evaluar(p.id, { resultado: 'apto', criterios: CRITERIOS_NEGATIVOS }, e.tokens.supervisorAjeno)).estado).toBe(403);
    expect((await evaluar(p.id, { resultado: 'apto', criterios: CRITERIOS_NEGATIVOS }, e.tokens.admin)).estado).toBe(403);
    expect((await pedir(e.f, 'GET', `/api/personas/${p.id}/evaluaciones`, e.tokens.admin)).estado).toBe(403);
  });
});

describe('rol de psiquiatra', () => {
  const asignado = { asignado: true, esSuContacto: false, permisosContacto: {} };
  const actor: Actor = { tipo: 'personal', id: 'x', rol: 'psiquiatra', nombre: 'P' };
  it('es responsable clínico de sus personas asignadas', () => {
    for (const a of ['persona.ver_ficha', 'plan.leer', 'plan.editar', 'transcripcion.leer', 'alertas.acusar', 'evaluacion.registrar', 'medicacion.gestionar'] as const) {
      expect(decidirPermiso(actor, a, 'p', asignado)).toBe(true);
      expect(decidirPermiso(actor, a, 'p', { ...asignado, asignado: false })).toBe(false);
    }
  });
  it('no gestiona cuentas, altas ni derechos sobre los datos', () => {
    for (const a of ['cuenta.crear', 'persona.crear', 'persona.exportar', 'persona.suprimir', 'costos.ver'] as const) expect(decidirPermiso(actor, a, 'p', asignado)).toBe(false);
  });
});

describe('derechos sobre los datos (Ley 21.719)', () => {
  it('la administración exporta todo, legible y sin credenciales, solo con motivo y queda auditado', async () => {
    const p = await personaNueva('Teresa Oyarzún');
    await consentir(p.id);
    await evaluar(p.id, { resultado: 'apto', criterios: CRITERIOS_NEGATIVOS, notas: 'Sin observaciones.' });
    await pedir(e.f, 'POST', `/api/personas/${p.id}/contactos`, e.tokens.admin, { nombre: 'Jorge Oyarzún', relacion: 'hijo', telefono: '+56922223333', esCuidador: true, permisos: {} });

    expect((await pedir(e.f, 'POST', `/api/personas/${p.id}/exportar-todo`, e.tokens.admin, { motivo: 'corto' })).estado).toBe(400);
    expect((await pedir(e.f, 'POST', `/api/personas/${p.id}/exportar-todo`, e.tokens.supervisor, { motivo: 'Solicitud de acceso de la persona' })).estado).toBe(403);

    const r = await e.f.inject({ method: 'POST', url: `/api/personas/${p.id}/exportar-todo`, headers: { authorization: `Bearer ${e.tokens.admin}` }, payload: { motivo: 'Solicitud de acceso de la persona del 25-11' } });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-disposition']).toContain('attachment');
    const d = JSON.parse(r.body) as { tablas: Record<string, Array<Record<string, unknown>>>; omitidos: string[] };
    expect(d.tablas.persona![0]!.nombre).toBe('Teresa Oyarzún');
    expect(d.tablas.contacto![0]!.nombre).toBe('Jorge Oyarzún');
    expect(d.tablas.contacto![0]!.telefono).toBe('+56922223333');
    expect(d.tablas.evaluacion_ingreso![0]!.notas).toBe('Sin observaciones.');
    expect(d.tablas.dispositivo?.[0]).toBeDefined();
    expect(JSON.stringify(d.tablas)).not.toMatch(/token_hash|telefono_hash|hash_contrasena/);
    expect(d.omitidos.some((x) => x.includes('hash'))).toBe(true);
    const a = await e.owner.query<{ motivo: string }>(`SELECT motivo FROM registro_auditoria WHERE accion = 'persona.exportar_todo' AND persona_id = $1`, [p.id]);
    expect(a.rows[0]!.motivo).toContain('Solicitud de acceso');
  });

  it('la supresión borra todo, pide confirmación y motivo, y deja constancia en la auditoría', async () => {
    const p = await personaNueva('Hugo Barría');
    await consentir(p.id);
    await evaluar(p.id, { resultado: 'apto', criterios: CRITERIOS_NEGATIVOS });
    const contacto = (await pedir<{ id: string }>(e.f, 'POST', `/api/personas/${p.id}/contactos`, e.tokens.admin, { nombre: 'Rita Barría', relacion: 'hija', telefono: '+56933334444', esCuidador: true, permisos: { resumen_bienestar: true } })).datos.id;
    const email = `fam-${Date.now()}@prueba.cl`;
    await pedir(e.f, 'POST', '/api/cuentas', e.tokens.admin, { tipo: 'familiar', email, nombre: 'Rita', contrasena: CONTRASENA, contactoId: contacto });
    expect((await abrirSesion(p.tablet)).estado).toBe(201);

    expect((await pedir(e.f, 'POST', `/api/personas/${p.id}/suprimir`, e.tokens.admin, { confirmacion: 'si', motivo: 'Solicitud de supresión de la persona' })).estado).toBe(400);
    expect((await pedir(e.f, 'POST', `/api/personas/${p.id}/suprimir`, psiquiatra.token, { confirmacion: 'SUPRIMIR', motivo: 'Solicitud de supresión de la persona' })).estado).toBe(403);
    const r = await pedir(e.f, 'POST', `/api/personas/${p.id}/suprimir`, e.tokens.admin, { confirmacion: 'SUPRIMIR', motivo: 'Solicitud de supresión de la persona del 25-11' });
    expect(r.estado).toBe(200);

    for (const [tabla, col] of [['persona', 'id'], ['contacto', 'persona_id'], ['sesion_conversacion', 'persona_id'], ['evaluacion_ingreso', 'persona_id'], ['consentimiento', 'persona_id'], ['dispositivo', 'persona_id']]) {
      expect((await e.owner.query(`SELECT 1 FROM ${tabla} WHERE ${col} = $1`, [p.id])).rowCount, tabla).toBe(0);
    }
    // La cuenta del familiar ya no puede entrar.
    expect((await pedir(e.f, 'POST', '/api/auth/ingresar', undefined, { email, contrasena: CONTRASENA })).estado).toBeGreaterThanOrEqual(400);
    // La tablet tampoco.
    expect((await abrirSesion(p.tablet)).estado).toBeGreaterThanOrEqual(400);
    const a = await e.owner.query<{ motivo: string }>(`SELECT motivo FROM registro_auditoria WHERE accion = 'persona.suprimir' AND recurso_id = $1`, [p.id]);
    expect(a.rows[0]!.motivo).toContain('supresión');
  });
});

describe('preparación del piloto', () => {
  it('calcula las horas sin guardia, incluidos los turnos que cruzan la medianoche', () => {
    const todos = [1, 2, 3, 4, 5, 6, 7];
    expect(huecosGuardia([{ dias: todos, horaDesde: '00:00', horaHasta: '23:59' }])).toEqual([]);
    expect(huecosGuardia([])).toHaveLength(7 * 24);
    // Día (08:00–19:59) más noche (20:00–07:59 del día siguiente): cubre todo.
    expect(huecosGuardia([{ dias: todos, horaDesde: '08:00', horaHasta: '19:59' }, { dias: todos, horaDesde: '20:00', horaHasta: '07:59' }])).toEqual([]);
    // Solo hábiles de 8 a 18: faltan noches y fin de semana.
    const habiles = huecosGuardia([{ dias: [1, 2, 3, 4, 5], horaDesde: '08:00', horaHasta: '17:59' }]);
    expect(habiles).toContainEqual({ dia: 1, hora: 3 });
    expect(habiles).toContainEqual({ dia: 6, hora: 12 });
    expect(habiles).not.toContainEqual({ dia: 2, hora: 10 });
    // La noche del domingo cubre la madrugada del lunes.
    const noche = huecosGuardia([{ dias: [7], horaDesde: '22:00', horaHasta: '06:59' }]);
    expect(noche).not.toContainEqual({ dia: 1, hora: 3 });
    expect(noche).toContainEqual({ dia: 7, hora: 3 });
  });

  it('muestra lo que falta y permite marcar los acuerdos legales; solo administración o responsables clínicos', async () => {
    expect((await pedir(e.f, 'GET', '/api/preparacion', e.tokens.enfermera)).estado).toBe(403);
    const r = await pedir<{ chequeos: Array<{ clave: string; estado: string }>; personas: Array<{ nombre: string; faltan: string[] }>; manuales: Array<{ clave: string; completado: boolean }> }>(e.f, 'GET', '/api/preparacion', e.tokens.admin);
    expect(r.estado).toBe(200);
    const chequeo = (k: string) => r.datos.chequeos.find((x) => x.clave === k)!.estado;
    // En pruebas no hay guardia: debe decir que falta, no que está listo. La mensajería sigue a la configuración.
    expect(chequeo('guardia_24_7')).toBe('falta');
    expect(chequeo('mensajeria')).toBe(e.app.config.escalamiento.twilio ? 'ok' : 'falta');
    expect(r.datos.personas.some((p) => p.faltan.includes('consentimiento'))).toBe(true);
    expect(r.datos.manuales.find((m) => m.clave === 'dpa_modelos')!.completado).toBe(false);

    expect((await pedir(e.f, 'PUT', '/api/preparacion/manual/dpa_modelos', e.tokens.admin, { completado: true, nota: 'Firmado el 20-11' })).estado).toBe(200);
    expect((await pedir(e.f, 'PUT', '/api/preparacion/manual/no_existe', e.tokens.admin, { completado: true })).estado).toBe(400);
    const r2 = await pedir<{ manuales: Array<{ clave: string; completado: boolean; nota: string }> }>(e.f, 'GET', '/api/preparacion', psiquiatra.token);
    expect(r2.datos.manuales.find((m) => m.clave === 'dpa_modelos')).toMatchObject({ completado: true, nota: 'Firmado el 20-11' });
  });
});
