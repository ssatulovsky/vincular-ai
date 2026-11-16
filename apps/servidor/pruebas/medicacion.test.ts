import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { ejecutarHerramienta, type AmbitoHerramienta } from '../src/conversacion/herramientas.ts';
import { abrirSesion, insertarTurno } from '../src/conversacion/repositorio.ts';
import { cicloMedicacion, generarAgenda, type Recordatorio } from '../src/medicacion/agenda.ts';
import { horaParaVoz, textoRecordatorio } from '../src/medicacion/textos.ts';
import { crearHecho } from '../src/memoria/hechos.ts';
import { CONTRASENA, correo, crearEscenario, pedir, type Escenario } from './escenario.ts';

/**
 * Enfermero digital. Las horas se controlan pasando `ahora` a cada función: no hay relojes
 * falsos. Fechas en 2030 para no chocar con los datos de otras pruebas.
 */
let e: Escenario;
beforeAll(async () => {
  e = await crearEscenario();
});
afterAll(async () => e?.cerrar());

const T = (iso: string) => new Date(iso);

async function crearMed(personaId: string, d: { nombre: string; propositoSimple?: string; dosisTexto: string; horarios: string[] }, token = e.tokens.enfermera) {
  const r = await pedir<{ id: string }>(e.f, 'POST', `/api/personas/${personaId}/medicamentos`, token, d);
  expect(r.estado).toBe(201);
  return r.datos.id;
}

async function estado(medId: string, programadaEn: string) {
  const r = await e.owner.query('SELECT estado, recordado_en, segundo_aviso_en, entregado_en_linea, confirmada_tarde, confirmacion_origen FROM evento_dosis WHERE medicamento_id = $1 AND programada_en = $2', [medId, programadaEn]);
  return r.rows[0];
}

/** Entrega real (TabletsConectadas) con una conexión registrada que guarda lo recibido. */
function conectarTablet(personaId: string): { recibidos: Array<Record<string, unknown>>; cerrar: () => void } {
  const recibidos: Array<Record<string, unknown>> = [];
  const cerrar = e.app.tablets.registrar(personaId, (m) => recibidos.push(m as Record<string, unknown>));
  return { recibidos, cerrar };
}

describe('textos de recordatorio', () => {
  it('dice la hora como se habla', () => {
    expect(horaParaVoz('08:00')).toBe('las ocho de la mañana');
    expect(horaParaVoz('13:30')).toBe('la una y media de la tarde');
    expect(horaParaVoz('21:15')).toBe('las nueve y cuarto de la noche');
    expect(horaParaVoz('12:00')).toBe('las doce del día');
  });

  it('nombra lo indicado y pide confirmar, con el trato de la persona', () => {
    const m = [{ nombre: 'Losartán', propositoSimple: 'para la presión', dosisTexto: '1 comprimido' }];
    expect(textoRecordatorio({ nombrePersona: 'Rosa', trato: 'usted', hora: '08:00', medicamentos: m, segundoAviso: false })).toBe(
      'Rosa, es la hora de su remedio de las ocho de la mañana: Losartán, para la presión, 1 comprimido. ¿Me avisa cuando se lo tome?',
    );
    expect(textoRecordatorio({ nombrePersona: 'Luis', trato: 'tu', hora: '20:00', medicamentos: [...m, { nombre: 'Atorvastatina', propositoSimple: null, dosisTexto: '1 comprimido' }], segundoAviso: true })).toBe(
      'Luis, te recuerdo tus remedios de las ocho de la noche: Losartán, para la presión, 1 comprimido; y Atorvastatina, 1 comprimido. ¿Ya te los tomaste?',
    );
  });
});

describe('gestión de medicamentos', () => {
  it('solo el equipo de salud asignado los registra', async () => {
    const d = { nombre: 'Metformina', dosisTexto: '1 comprimido', horarios: ['09:00'] };
    for (const t of [e.tokens.admin, e.tokens.guardia, e.tokens.familiar, e.tokens.dispositivo, e.tokens.supervisorAjeno]) {
      expect((await pedir(e.f, 'POST', `/api/personas/${e.ids.persona}/medicamentos`, t, d)).estado).toBe(403);
    }
    expect((await pedir(e.f, 'POST', `/api/personas/${e.ids.persona}/medicamentos`, e.tokens.enfermera, { ...d, horarios: ['25:00'] })).estado).toBe(400);
    expect((await pedir(e.f, 'POST', `/api/personas/${e.ids.persona}/medicamentos`, e.tokens.enfermera, { ...d, horarios: ['09:00', '09:00'] })).estado).toBe(400);
  });
});

describe('agenda y ciclo del recordatorio', () => {
  let medId: string;
  beforeAll(async () => {
    medId = await crearMed(e.ids.personaAjena, { nombre: 'Losartán', propositoSimple: 'para la presión', dosisTexto: '1 comprimido', horarios: ['08:00', '20:00'] }, e.tokens.supervisorAjeno);
  });

  it('genera las dosis en la hora de Chile, con y sin horario de verano, sin duplicar', async () => {
    // 10 de marzo de 2030: horario de verano (UTC−3). 08:00 en Chile = 11:00 UTC.
    expect(await generarAgenda(e.app.bd, T('2030-03-10T10:00:00Z'), 48, e.ids.personaAjena)).toBe(4);
    expect(await generarAgenda(e.app.bd, T('2030-03-10T10:00:00Z'), 48, e.ids.personaAjena)).toBe(0);
    expect(await estado(medId, '2030-03-10T11:00:00Z')).toMatchObject({ estado: 'pendiente' });
    expect(await estado(medId, '2030-03-10T23:00:00Z')).toMatchObject({ estado: 'pendiente' });
    // 10 de junio de 2030: horario de invierno (UTC−4). 08:00 en Chile = 12:00 UTC.
    await generarAgenda(e.app.bd, T('2030-06-10T10:00:00Z'), 24, e.ids.personaAjena);
    expect(await estado(medId, '2030-06-10T12:00:00Z')).toMatchObject({ estado: 'pendiente' });
  });

  it('recuerda a la hora, da un segundo aviso a los 30 minutos y avisa al equipo si no hay respuesta', async () => {
    const tablet = conectarTablet(e.ids.personaAjena);
    const d = { bd: e.app.bd, cifrador: e.app.cifrador, entrega: e.app.tablets };

    const r1 = await cicloMedicacion(d, T('2030-03-10T11:00:05Z'));
    expect(r1.recordatorios).toBe(1);
    expect(tablet.recibidos[0]).toMatchObject({ tipo: 'recordatorio_dosis', segundoAviso: false, texto: expect.stringContaining('Luis, es la hora de su remedio de las ocho de la mañana: Losartán') });
    expect(await estado(medId, '2030-03-10T11:00:00Z')).toMatchObject({ estado: 'recordada', entregado_en_linea: true });

    expect((await cicloMedicacion(d, T('2030-03-10T11:20:00Z'))).recordatorios + (await cicloMedicacion(d, T('2030-03-10T11:20:00Z'))).segundosAvisos).toBe(0);

    const r2 = await cicloMedicacion(d, T('2030-03-10T11:31:00Z'));
    expect(r2.segundosAvisos).toBe(1);
    expect(tablet.recibidos.at(-1)).toMatchObject({ segundoAviso: true, texto: expect.stringContaining('¿Ya se lo tomó?') });

    const r3 = await cicloMedicacion(d, T('2030-03-10T12:02:00Z'));
    expect(r3).toMatchObject({ sinRespuesta: 1, notificaciones: 1 });
    expect(await estado(medId, '2030-03-10T11:00:00Z')).toMatchObject({ estado: 'sin_respuesta' });
    // Inicia la cadena del protocolo "dosis sin respuesta"; el detalle no lleva medicamentos.
    const esc = await e.owner.query('SELECT tipo_evento, nivel, detalle FROM escalamiento WHERE persona_id = $1', [e.ids.personaAjena]);
    expect(esc.rows).toHaveLength(1);
    expect(esc.rows[0]).toMatchObject({ tipo_evento: 'dosis_sin_respuesta', nivel: 1, detalle: { dosis: 1, tabletSinConexion: false, protocolo: 'Dosis sin respuesta' } });
    expect(JSON.stringify(esc.rows[0].detalle)).not.toContain('Losartán');
    const s = await e.owner.query(`SELECT count(*)::int AS n FROM senal WHERE persona_id = $1 AND tipo = 'adherencia.dosis_sin_respuesta'`, [e.ids.personaAjena]);
    expect(s.rows[0].n).toBe(1);
    tablet.cerrar();
  });

  it('si la persona confirma, no hay segundo aviso ni aviso al equipo', async () => {
    const d = { bd: e.app.bd, cifrador: e.app.cifrador, entrega: e.app.tablets };
    await cicloMedicacion(d, T('2030-03-10T23:00:10Z'));
    const sesion = await abrirSesion(e.app.bd, e.ids.personaAjena, null, 'persona', 'texto');
    const turno = await insertarTurno(e.app.bd, e.app.cifrador, sesion, e.ids.personaAjena, 'persona', 'ya me la tomé', 'persona');
    const ambito: AmbitoHerramienta = { bd: e.app.bd, cifrador: e.app.cifrador, modelos: e.app.modelos, personaId: e.ids.personaAjena, sesionId: sesion, dispositivoId: null, turnoPersonaId: turno, ahora: () => T('2030-03-10T23:05:00Z'), alReportarRiesgo: () => undefined };
    expect(await ejecutarHerramienta(ambito, 'medicacion_confirmar_dosis', {})).toEqual({ confirmadas: 1 });
    expect(await estado(medId, '2030-03-10T23:00:00Z')).toMatchObject({ estado: 'confirmada', confirmacion_origen: 'voz', confirmada_tarde: false });
    const r = await cicloMedicacion(d, T('2030-03-11T00:40:00Z'));
    expect(r.segundosAvisos + r.sinRespuesta).toBe(0);
  });

  it('una dosis que nadie recordó a tiempo (servidor caído) queda sin registro y no se escala', async () => {
    const antes = await e.owner.query('SELECT count(*)::int AS n FROM escalamiento WHERE persona_id = $1', [e.ids.personaAjena]);
    const r = await cicloMedicacion({ bd: e.app.bd, cifrador: e.app.cifrador, entrega: e.app.tablets }, T('2030-03-11T14:00:00Z'));
    expect(r.sinRegistro).toBeGreaterThanOrEqual(1);
    expect(await estado(medId, '2030-03-11T11:00:00Z')).toMatchObject({ estado: 'sin_registro' });
    const despues = await e.owner.query('SELECT count(*)::int AS n FROM escalamiento WHERE persona_id = $1', [e.ids.personaAjena]);
    expect(despues.rows[0].n).toBe(antes.rows[0].n);
  });

  it('dos procesos a la vez no repiten el recordatorio', async () => {
    const m = await crearMed(e.ids.personaAjena, { nombre: 'Aspirina', dosisTexto: '1 comprimido', horarios: ['10:00'] }, e.tokens.supervisorAjeno);
    const tablet = conectarTablet(e.ids.personaAjena);
    const d = { bd: e.app.bd, cifrador: e.app.cifrador, entrega: e.app.tablets };
    await generarAgenda(e.app.bd, T('2030-04-01T10:00:00Z'), 24, e.ids.personaAjena);
    const [a, b] = await Promise.all([cicloMedicacion(d, T('2030-04-01T13:00:30Z')), cicloMedicacion(d, T('2030-04-01T13:00:30Z'))]);
    expect(a.recordatorios + b.recordatorios).toBe(1);
    expect(tablet.recibidos.filter((x) => (x.texto as string).includes('Aspirina'))).toHaveLength(1);
    expect(await estado(m, '2030-04-01T13:00:00Z')).toMatchObject({ estado: 'recordada' });
    tablet.cerrar();
  });

  it('agrupa los remedios de la misma hora en un solo recordatorio', async () => {
    const m1 = await crearMed(e.ids.personaAjena, { nombre: 'Omeprazol', dosisTexto: '1 cápsula', horarios: ['07:00'] }, e.tokens.supervisorAjeno);
    await crearMed(e.ids.personaAjena, { nombre: 'Levotiroxina', dosisTexto: '1 comprimido', horarios: ['07:00'] }, e.tokens.supervisorAjeno);
    const tablet = conectarTablet(e.ids.personaAjena);
    await generarAgenda(e.app.bd, T('2030-05-02T08:00:00Z'), 24, e.ids.personaAjena);
    await cicloMedicacion({ bd: e.app.bd, cifrador: e.app.cifrador, entrega: e.app.tablets }, T('2030-05-02T11:00:10Z'));
    const r = tablet.recibidos.filter((x) => (x.texto as string).includes('Omeprazol'));
    expect(r).toHaveLength(1);
    expect(r[0]!.texto).toContain('sus remedios de las siete de la mañana');
    expect(r[0]!.eventoIds).toHaveLength(2);
    expect(await estado(m1, '2030-05-02T11:00:00Z')).toMatchObject({ estado: 'recordada' });
    tablet.cerrar();
  });

  it('cambiar o suspender un medicamento anula sus dosis futuras', async () => {
    const m = await crearMed(e.ids.personaAjena, { nombre: 'Vitamina D', dosisTexto: '1 cápsula', horarios: ['12:00'] }, e.tokens.supervisorAjeno);
    await generarAgenda(e.app.bd, T('2030-07-01T12:00:00Z'), 48, e.ids.personaAjena);
    const r = await pedir(e.f, 'POST', `/api/personas/${e.ids.personaAjena}/medicamentos/${m}/suspender`, e.tokens.supervisorAjeno, { motivo: 'Indicación del médico' });
    expect(r.estado).toBe(200);
    // Las de 2030 están en el futuro respecto de hoy: quedan anuladas.
    const q = await e.owner.query(`SELECT DISTINCT estado FROM evento_dosis WHERE medicamento_id = $1`, [m]);
    expect(q.rows).toEqual([{ estado: 'anulada' }]);
    expect(await generarAgenda(e.app.bd, T('2030-07-01T12:00:00Z'), 48, e.ids.personaAjena)).toBe(0);
  });
});

describe('la persona y su medicación', () => {
  it('confirma tarde desde la pantalla; queda marcada como tardía', async () => {
    const m = await crearMed(e.ids.persona, { nombre: 'Enalapril', propositoSimple: 'para la presión', dosisTexto: '1 comprimido', horarios: ['08:00'] });
    const ev = await e.owner.query<{ id: string }>(`INSERT INTO evento_dosis (medicamento_id, programada_en, estado, recordado_en, segundo_aviso_en) VALUES ($1, now() - interval '70 minutes', 'sin_respuesta', now() - interval '70 minutes', now() - interval '40 minutes') RETURNING id`, [m]);
    const r = await pedir<{ confirmadas: string[] }>(e.f, 'POST', '/api/mi-medicacion/confirmar', e.tokens.dispositivo, { eventoIds: [ev.rows[0]!.id] });
    expect(r.datos.confirmadas).toEqual([ev.rows[0]!.id]);
    const f = await e.owner.query('SELECT estado, confirmada_tarde, confirmacion_origen FROM evento_dosis WHERE id = $1', [ev.rows[0]!.id]);
    expect(f.rows[0]).toEqual({ estado: 'confirmada', confirmada_tarde: true, confirmacion_origen: 'pantalla' });
    // Otra tablet no puede confirmar dosis ajenas.
    const ev2 = await e.owner.query<{ id: string }>(`INSERT INTO evento_dosis (medicamento_id, programada_en, estado) VALUES ($1, now() - interval '5 minutes', 'recordada') RETURNING id`, [m]);
    expect((await pedir<{ confirmadas: string[] }>(e.f, 'POST', '/api/mi-medicacion/confirmar', e.tokens.dispositivoAjeno, { eventoIds: [ev2.rows[0]!.id] })).datos.confirmadas).toEqual([]);
  });

  it('una confirmación sin conexión conserva la hora en que se tomó y no acepta horas futuras', async () => {
    const m = await crearMed(e.ids.persona, { nombre: 'Furosemida', dosisTexto: '1 comprimido', horarios: ['10:00'] });
    const ev = await e.owner.query<{ id: string }>(`INSERT INTO evento_dosis (medicamento_id, programada_en, estado) VALUES ($1, now() - interval '20 minutes', 'recordada') RETURNING id`, [m]);
    const tomada = new Date(Date.now() - 15 * 60_000).toISOString();
    await pedir(e.f, 'POST', '/api/mi-medicacion/confirmar', e.tokens.dispositivo, { eventoIds: [ev.rows[0]!.id], tomadaEn: tomada, sinConexion: true });
    const f = await e.owner.query<{ confirmada_en: Date; confirmacion_origen: string }>('SELECT confirmada_en, confirmacion_origen FROM evento_dosis WHERE id = $1', [ev.rows[0]!.id]);
    expect(f.rows[0]!.confirmacion_origen).toBe('sin_conexion');
    expect(f.rows[0]!.confirmada_en.toISOString()).toBe(tomada);
  });

  it('la tablet recibe la agenda de 48 h con los textos listos para sonar sin conexión', async () => {
    const r = await pedir<{ recordatorios: Array<{ texto: string; textoSegundoAviso: string; eventoIds: string[] }> }>(e.f, 'GET', '/api/mi-medicacion/agenda', e.tokens.dispositivo);
    expect(r.estado).toBe(200);
    expect(r.datos.recordatorios.length).toBeGreaterThan(0);
    expect(r.datos.recordatorios[0]!.texto).toMatch(/^Rosa, es la hora de/);
    expect(r.datos.recordatorios[0]!.textoSegundoAviso).toMatch(/Rosa, le recuerdo/);
    expect((await pedir(e.f, 'GET', '/api/mi-medicacion/agenda', e.tokens.enfermera)).estado).toBe(403);
  });

  it('el recordatorio llega por el WebSocket a la tablet conectada', async () => {
    await e.f.listen({ port: 0, host: '127.0.0.1' });
    const ws = new WebSocket(`ws://127.0.0.1:${(e.f.server.address() as { port: number }).port}/api/conversacion/ws`);
    const recibidos: Array<Record<string, unknown>> = [];
    ws.on('message', (m) => recibidos.push(JSON.parse(m.toString())));
    await new Promise((r) => ws.once('open', r));
    ws.send(JSON.stringify({ tipo: 'autenticar', token: e.tokens.dispositivo }));
    while (!recibidos.some((m) => m.tipo === 'sesion')) await new Promise((r) => setTimeout(r, 20));
    const ok = await e.app.tablets.entregar({ personaId: e.ids.persona, programadaEn: new Date(), eventoIds: [], texto: 'Rosa, es la hora de su remedio.', segundoAviso: false } satisfies Recordatorio);
    expect(ok).toBe(true);
    while (!recibidos.some((m) => m.tipo === 'recordatorio_dosis')) await new Promise((r) => setTimeout(r, 20));
    // Sin voz disponible, va solo el texto.
    expect(recibidos.find((m) => m.tipo === 'recordatorio_dosis')).toMatchObject({ texto: 'Rosa, es la hora de su remedio.' });
    ws.close();
    await new Promise((r) => setTimeout(r, 50));
    expect(e.app.tablets.conectada(e.ids.persona)).toBe(false);
  });
});

describe('herramientas del agente: omisiones y preguntas para el control', () => {
  it('registra una omisión sin juzgar y anota la pregunta para la próxima cita', async () => {
    const m = await crearMed(e.ids.persona, { nombre: 'Sertralina', dosisTexto: '1 comprimido', horarios: ['21:00'] });
    const ev = await e.owner.query<{ id: string }>(`INSERT INTO evento_dosis (medicamento_id, programada_en, estado) VALUES ($1, now(), 'recordada') RETURNING id`, [m]);
    const cita = await pedir<{ id: string }>(e.f, 'POST', `/api/personas/${e.ids.persona}/citas`, e.tokens.enfermera, { lugar: 'CESFAM Puerto Varas', profesional: 'Dra. Pérez', fecha: new Date(Date.now() + 5 * 86_400_000).toISOString(), motivo: 'Control crónico' });
    expect(cita.estado).toBe(201);
    const sesion = await abrirSesion(e.app.bd, e.ids.persona, null, 'persona', 'texto');
    const turno = await insertarTurno(e.app.bd, e.app.cifrador, sesion, e.ids.persona, 'persona', 'esa pastilla me da mareos', 'persona');
    const ambito: AmbitoHerramienta = { bd: e.app.bd, cifrador: e.app.cifrador, modelos: e.app.modelos, personaId: e.ids.persona, sesionId: sesion, dispositivoId: null, turnoPersonaId: turno, ahora: () => new Date(), alReportarRiesgo: () => undefined };

    expect(await ejecutarHerramienta(ambito, 'medicacion_no_tomada', { evento_ids: [ev.rows[0]!.id], motivo: 'me da mareos' })).toEqual({ registradas: 1 });
    expect(await ejecutarHerramienta(ambito, 'control_anotar_pregunta', { texto: '¿La sertralina me puede dar mareos?' })).toEqual({ anotada: true });
    const p = await e.owner.query('SELECT cita_id FROM pregunta_control WHERE persona_id = $1', [e.ids.persona]);
    expect(p.rows[0].cita_id).toBe(cita.datos.id);

    const hoy = (await ejecutarHerramienta(ambito, 'medicacion_de_hoy', {})) as { remedios: Array<Record<string, unknown>> };
    expect(hoy.remedios.some((x) => x.nombre === 'Sertralina' && x.estado === 'omitida')).toBe(true);
    // Al agente no se le entregan las dosis: solo nombre, para qué, hora y estado.
    expect(JSON.stringify(hoy)).not.toContain('comprimido');
    const citas = (await ejecutarHerramienta(ambito, 'citas_proximas', {})) as { citas: Array<{ lugar: string }> };
    expect(citas.citas[0]!.lugar).toBe('CESFAM Puerto Varas');
  });
});

describe('hoja para el control', () => {
  let citaId: string;
  beforeAll(async () => {
    citaId = (await pedir<{ citas: Array<{ id: string; lugar: string }> }>(e.f, 'GET', `/api/personas/${e.ids.persona}/citas`, e.tokens.enfermera)).datos.citas.find((c) => c.lugar === 'CESFAM Puerto Varas')!.id;
    await crearHecho(e.app.bd, e.app.cifrador, e.ids.persona, { capa: 'salud', contenido: 'Le duele la rodilla derecha al subir escaleras', privado: false, estado: 'confirmado', fuente: 'persona' });
    await crearHecho(e.app.bd, e.app.cifrador, e.ids.persona, { capa: 'salud', contenido: 'SECRETO-PRIVADO', privado: true, estado: 'confirmado', fuente: 'persona' });
    await crearHecho(e.app.bd, e.app.cifrador, e.ids.persona, { capa: 'salud', contenido: 'NO-CONFIRMADO', privado: false, estado: 'por_confirmar', fuente: 'extraccion' });
  });

  it('reúne preguntas, remedios con su registro y lo que contó; sin lo privado ni lo no confirmado', async () => {
    const r = await e.f.inject({ method: 'GET', url: `/api/mis-citas/${citaId}/hoja`, headers: { authorization: `Bearer ${e.tokens.dispositivo}` } });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-security-policy']).toContain("default-src 'none'");
    expect(r.body).toContain('¿La sertralina me puede dar mareos?');
    expect(r.body).toContain('Enalapril');
    expect(r.body).toContain('Confirmé 1 de 1 tomas');
    expect(r.body).toContain('Le duele la rodilla derecha');
    expect(r.body).not.toContain('SECRETO-PRIVADO');
    expect(r.body).not.toContain('NO-CONFIRMADO');
    expect(r.body).toContain('No reemplaza las indicaciones de su médico');
    const c = await e.owner.query('SELECT hoja_preparada_en FROM cita WHERE id = $1', [citaId]);
    expect(c.rows[0].hoja_preparada_en).not.toBeNull();
  });

  it('el familiar la ve solo si la persona lo autorizó', async () => {
    const url = `/api/personas/${e.ids.persona}/citas/${citaId}/hoja`;
    expect((await pedir(e.f, 'GET', url, e.tokens.familiar)).estado).toBe(403);
    const contacto = (await pedir<{ id: string }>(e.f, 'POST', `/api/personas/${e.ids.persona}/contactos`, e.tokens.admin, { nombre: 'Pedro Muñoz', relacion: 'hijo', permisos: { hoja_control: true } })).datos.id;
    const email = correo('hijo');
    await pedir(e.f, 'POST', '/api/cuentas', e.tokens.admin, { tipo: 'familiar', email, nombre: 'Pedro', contrasena: CONTRASENA, contactoId: contacto });
    const token = (await pedir<{ token: string }>(e.f, 'POST', '/api/auth/ingresar', undefined, { email, contrasena: CONTRASENA })).datos.token;
    expect((await e.f.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(200);
    expect((await pedir(e.f, 'GET', `/api/personas/${e.ids.persona}/medicamentos`, token)).estado).toBe(403);
  });

  it('escapa lo que se escribe en la cita', async () => {
    const c = await pedir<{ id: string }>(e.f, 'POST', `/api/personas/${e.ids.persona}/citas`, e.tokens.enfermera, { lugar: '<script>alert(1)</script>', fecha: new Date(Date.now() + 86_400_000).toISOString() });
    const r = await e.f.inject({ method: 'GET', url: `/api/personas/${e.ids.persona}/citas/${c.datos.id}/hoja`, headers: { authorization: `Bearer ${e.tokens.enfermera}` } });
    expect(r.body).not.toContain('<script>alert(1)</script>');
    expect(r.body).toContain('&lt;script&gt;');
  });
});
