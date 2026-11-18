import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { categoriaAnimo } from '../src/familia/resumen.ts';
import { lentesActivas } from '../src/informes/lentes.ts';
import { crearEscenario, pedir, type Escenario } from './escenario.ts';

let e: Escenario;
beforeAll(async () => {
  e = await crearEscenario();
});
afterAll(async () => e?.cerrar());

type Resumen = {
  persona: { nombre: string };
  autorizado: { bienestar: boolean; medicacion: boolean; citas: boolean };
  bienestar: { diasConConversacion: number; dias: boolean[]; animo: string; descanso: string; contactosHumanos: number } | null;
  medicacion: unknown;
  citas: unknown;
  avisos: Array<{ tipo: string; atendido: boolean }>;
  emergencia: { samu: string };
};

const SECRETO = 'Le confieso que mi hermano Raúl me debe plata y no quiero que nadie lo sepa';

describe('panel familiar: resumen de bienestar', () => {
  beforeAll(async () => {
    // Una conversación de hoy con un tema privado y su resumen válido con indicadores.
    const s = (await e.owner.query<{ id: string }>(`INSERT INTO sesion_conversacion (persona_id, iniciada_por, canal, fin) VALUES ($1, 'persona', 'voz', now()) RETURNING id`, [e.ids.persona])).rows[0]!.id;
    await e.owner.query(`INSERT INTO turno (sesion_id, persona_id, orden, hablante, texto_cifrado, origen) VALUES ($1, $2, 1, 'persona', $3, 'persona')`, [s, e.ids.persona, e.app.cifrador.cifrar(SECRETO)]);
    const informe = {
      temas: [{ tema: 'Deuda del hermano', minutos_aprox: 3 }], estado_afectivo: { observado: [{ texto: 'Preocupada por su hermano.', citas: ['mi hermano Raúl me debe plata'] }], inferido: [] },
      pensamientos_creencias: { observado: [], inferido: [] }, funcionamiento_cotidiano: { observado: [], inferido: [] }, red_social: { observado: [], inferido: [] }, salud: { observado: [], inferido: [] },
      riesgo: { justificacion: 'Sin señales.' }, intervenciones: [], observaciones_supervisor: { hipotesis_tentativas: [{ texto: 'Posible conflicto familiar.', citas: [] }], temas_pendientes: [] },
      indicadores: { animo: { valor: -1, cita: 'no quiero que nadie lo sepa' }, sueno: { valor: 'malo', cita: 'x' }, apetito: null, contactos_humanos: [{ tipo: 'llamada', con_quien: 'Raúl', cita: 'mi hermano Raúl' }] },
      lentes: [{ lente: 'transferencia', concepto: 'confidente', senalamiento: 'Ubica al compañero como confidente.', citas: ['Le confieso'], tipo: 'observacion', sesiones_previas: [] }],
      version: 1, datos: {}, nivelRiesgo: 1, lentesActivas: lentesActivas(),
    };
    await e.owner.query(`INSERT INTO informe_sesion (sesion_id, contenido_cifrado, estado_validacion) VALUES ($1, $2, 'valido')`, [s, e.app.cifrador.cifrarJson(informe)]);
  });

  it('muestra categorías y cifras de lo autorizado, sin nada de lo conversado', async () => {
    const r = await pedir<Resumen>(e.f, 'GET', '/api/familia/resumen', e.tokens.familiar);
    expect(r.estado).toBe(200);
    expect(r.datos.persona.nombre).toBe('Rosa');
    expect(r.datos.autorizado).toEqual({ bienestar: true, medicacion: false, citas: false });
    expect(r.datos.bienestar).toMatchObject({ diasConConversacion: 1, animo: 'bajo', descanso: 'con_dificultades', contactosHumanos: 1 });
    expect(r.datos.bienestar!.dias).toHaveLength(7);
    expect(r.datos.bienestar!.dias[6]).toBe(true);
    // Lo no autorizado no viene.
    expect(r.datos.medicacion).toBeNull();
    expect(r.datos.citas).toBeNull();
    // Nada de lo conversado, ni citas, ni hipótesis, ni lecturas, ni nivel de riesgo.
    const json = JSON.stringify(r.datos);
    for (const prohibido of ['Raúl', 'plata', 'confieso', 'hermano', 'conflicto', 'transferencia', 'nivelRiesgo', 'Muñoz']) expect(json, prohibido).not.toContain(prohibido);
    // Los números de emergencia, desde la configuración.
    expect(r.datos.emergencia.samu).toBe('131');
  });

  it('sin autorización de la persona, no hay resumen', async () => {
    await e.owner.query(`UPDATE contacto SET permisos = '{}'::jsonb WHERE id = $1`, [e.ids.contacto]);
    try {
      const r = await pedir<Resumen>(e.f, 'GET', '/api/familia/resumen', e.tokens.familiar);
      expect(r.datos.autorizado).toEqual({ bienestar: false, medicacion: false, citas: false });
      expect(r.datos.bienestar).toBeNull();
    } finally {
      await e.owner.query(`UPDATE contacto SET permisos = '{"resumen_bienestar": true}'::jsonb WHERE id = $1`, [e.ids.contacto]);
    }
  });

  it('solo para familiares: ni el equipo ni la tablet lo usan', async () => {
    for (const t of [e.tokens.supervisor, e.tokens.admin, e.tokens.dispositivo]) expect((await pedir(e.f, 'GET', '/api/familia/resumen', t)).estado).toBe(403);
    expect((await pedir(e.f, 'GET', '/api/familia/resumen')).estado).toBe(401);
  });

  it('los avisos que recibió este contacto, y si alguien los atendió (una cadena agotada no cuenta)', async () => {
    const esc = async (estado: string, nivel: number) =>
      (await e.owner.query<{ id: string }>(
        `INSERT INTO escalamiento (persona_id, tipo_evento, nivel, estado, pasos, proximo_paso_en) VALUES ($1, 'riesgo', $2, $3, '[]'::jsonb, now()) RETURNING id`,
        [e.ids.persona, nivel, estado],
      )).rows[0]!.id;
    for (const [estado, nivel] of [['acusado', 2], ['agotado', 3]] as const) {
      const id = await esc(estado, nivel);
      await e.owner.query(`INSERT INTO notificacion (persona_id, tipo, destinatario_contacto_id, escalamiento_id, canal, estado) VALUES ($1, 'escalamiento', $2, $3, 'sms', 'enviada')`, [e.ids.persona, e.ids.contacto, id]);
    }
    const r = await pedir<Resumen>(e.f, 'GET', '/api/familia/resumen', e.tokens.familiar);
    expect(r.datos.avisos.map((a) => [a.tipo, a.atendido]).sort()).toEqual([['alerta', true], ['emergencia', false]]);
  });

  it('el ánimo se muestra en tres categorías', () => {
    expect(categoriaAnimo([])).toBe('sin_datos');
    expect(categoriaAnimo([1, 2])).toBe('bien');
    expect(categoriaAnimo([0, 0, 1])).toBe('regular');
    expect(categoriaAnimo([-1, -2, 0])).toBe('bajo');
  });
});

describe('panel familiar: propuestas', () => {
  it('la familia propone, el equipo clínico revisa y responde, la familia ve la respuesta', async () => {
    const p = await pedir<{ id: string }>(e.f, 'POST', '/api/familia/propuestas', e.tokens.familiar, { texto: 'Recordarle que el domingo es el cumpleaños de su nieta Antonia.' });
    expect(p.estado).toBe(201);
    expect((await pedir(e.f, 'POST', '/api/familia/propuestas', e.tokens.familiar, { texto: 'hey' })).estado).toBe(400);
    const lista = await pedir<{ propuestas: Array<{ id: string; de: string; estado: string }> }>(e.f, 'GET', `/api/personas/${e.ids.persona}/propuestas`, e.tokens.enfermera);
    expect(lista.datos.propuestas[0]).toMatchObject({ id: p.datos.id, de: 'Camila Muñoz (hija)', estado: 'pendiente' });
    for (const t of [e.tokens.admin, e.tokens.guardia, e.tokens.supervisorAjeno, e.tokens.familiar]) expect((await pedir(e.f, 'GET', `/api/personas/${e.ids.persona}/propuestas`, t)).estado).toBe(403);

    const url = `/api/personas/${e.ids.persona}/propuestas/${p.datos.id}`;
    expect((await pedir(e.f, 'PUT', url, e.tokens.admin, { estado: 'aceptada' })).estado).toBe(403);
    expect((await pedir(e.f, 'PUT', url, e.tokens.supervisor, { estado: 'aceptada', respuesta: 'Lo vamos a incorporar el sábado.' })).estado).toBe(200);
    expect((await pedir(e.f, 'PUT', url, e.tokens.supervisor, { estado: 'descartada' })).estado).toBe(404);
    const propias = await pedir<{ propuestas: Array<{ estado: string; respuesta: string }> }>(e.f, 'GET', '/api/familia/propuestas', e.tokens.familiar);
    expect(propias.datos.propuestas[0]).toMatchObject({ estado: 'aceptada', respuesta: 'Lo vamos a incorporar el sábado.' });
    const crudo = await e.owner.query('SELECT texto_cifrado FROM propuesta_familiar WHERE id = $1', [p.datos.id]);
    expect(crudo.rows[0].texto_cifrado.toString('utf8')).not.toContain('Antonia');
  });
});

describe('panel familiar: acceso', () => {
  it('la ficha indica qué contacto tiene acceso familiar', async () => {
    const f = await pedir<{ contactos: Array<{ id: string; accesoFamiliar: string | null }> }>(e.f, 'GET', `/api/personas/${e.ids.persona}/ficha`, e.tokens.admin);
    expect(f.datos.contactos.find((k) => k.id === e.ids.contacto)?.accesoFamiliar).toMatch(/@prueba\.cl$/);
  });

  it('la página /familia se sirve con política estricta y sin caché', async () => {
    const r = await e.f.inject({ method: 'GET', url: '/familia' });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.body).not.toMatch(/innerHTML/);
  });
});
